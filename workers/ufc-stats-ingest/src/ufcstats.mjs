/* Fetch layer for ufcstats.com inside the Worker.
 *
 * Serial, 1 req/s. Cache-first against R2 (ufc-raw/{kind}/{key}.html) so
 * re-parsing never re-scrapes.
 *
 * Access gate (decision 2026-09-05, option 1 in docs/scraper_notes.md):
 * ufcstats.com fronts requests with a JS proof-of-work interstitial. This
 * layer does exactly what a browser does — parses the nonce and difficulty
 * out of the inline script, finds n such that sha256(`${nonce}:${n}`) has
 * `difficulty` leading hex zeros, POSTs it to the challenge endpoint, keeps
 * the returned cookie, and retries the original request. The cookie is
 * persisted in R2 (ufc-raw/_state/session.json) so a normal run never has to
 * solve at all.
 *
 * It ABORTS (AccessGateError -> loud Discord) instead of adapting when:
 *   - the interstitial no longer matches the known script shape,
 *   - difficulty exceeds MAX_POW_DIFFICULTY (default 4 hex zeros),
 *   - the challenge endpoint path is not the known one,
 *   - a solved challenge still yields the interstitial, or
 *   - solving takes more than POW_MAX_ITER hashes.
 * A shape change means the operator changed their mind about automation and
 * a human should look, not the Worker.
 */

export class SchemaAssertionError extends Error {
  constructor(url, detail) { super(`${detail} @ ${url}`); this.name = 'SchemaAssertionError'; this.url = url; this.detail = detail; }
}
export class AccessGateError extends Error {
  constructor(url, detail) { super(`${detail} @ ${url}`); this.name = 'AccessGateError'; this.url = url; this.detail = detail; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const STATE_KEY = 'ufc-raw/_state/session.json';
const KNOWN_CHALLENGE_PATH = '/__c';
const POW_MAX_ITER = 2_000_000;

export function isInterstitial(html) {
  const head = html.slice(0, 4000);
  return (head.includes('Checking your browser') && head.includes('/__c'))
    || (html.length < 6000 && head.includes('This site requires JavaScript'));
}

/* Exact shape observed 2026-09-05. Anything else is a gate change. */
const RE_NONCE = /var nonce="([0-9a-f]{8,64})",\s*target=new Array\((\d+)\+1\)\.join\('0'\)/;
const RE_POST = /xhr\.open\('POST',"([^"]+)",true\)/;
const RE_SEND = /xhr\.send\('nonce='\+encodeURIComponent\(nonce\)\+'&n='\+n\)/;

export function parseChallenge(html, url, maxDifficulty) {
  const m = html.match(RE_NONCE);
  const p = html.match(RE_POST);
  if (!m || !p || !RE_SEND.test(html)) throw new AccessGateError(url, 'challenge shape changed');
  const difficulty = Number(m[2]);
  if (p[1] !== KNOWN_CHALLENGE_PATH) throw new AccessGateError(url, `challenge endpoint changed to ${p[1]}`);
  if (!(difficulty >= 1 && difficulty <= maxDifficulty)) throw new AccessGateError(url, `challenge difficulty ${difficulty} exceeds limit ${maxDifficulty}`);
  return { nonce: m[1], difficulty, path: p[1] };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function solveChallenge({ nonce, difficulty }, url) {
  const target = '0'.repeat(difficulty);
  for (let n = 0; n < POW_MAX_ITER; n += 1) {
    if ((await sha256hex(`${nonce}:${n}`)).startsWith(target)) return n;
  }
  throw new AccessGateError(url, `challenge unsolved after ${POW_MAX_ITER} iterations`);
}

export function extractId(url) {
  const m = String(url).match(/([0-9a-f]{16})(?:[/?]|$)/);
  if (!m) throw new Error(`no 16-hex id in ${url}`);
  return m[1];
}

export class Fetcher {
  constructor(env, { minIntervalMs = 1000, solveGate = true } = {}) {
    this.env = env;
    /* solveGate=false is the canary posture: report a challenge, never answer
     * it. The scheduled lane keeps the 2026-09-05 decision (solve the exact
     * known shape, abort on anything else). */
    this.solveGate = solveGate;
    /* Source telemetry, recorded on every run so "is UFC Stats answering us,
     * and how" has a stored answer instead of an assumption. */
    this.statuses = {};
    this.interstitialsSeen = 0;
    this.lastInterstitialAt = null;
    this.base = String(env.UFCSTATS_BASE || 'http://ufcstats.com').replace(/\/$/, '');
    this.maxDifficulty = Number(env.MAX_POW_DIFFICULTY || 4);
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.cookie = null;
    this.cookieLoaded = false;
    this.subrequests = 0;
    this.challengesSolved = 0;
    this.fetched = { lists: 0, events: 0, fights: 0, fighters: 0 };
  }

  async throttle() {
    const wait = this.minIntervalMs - (Date.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }

  async loadCookie() {
    if (this.cookieLoaded) return;
    this.cookieLoaded = true;
    if (!this.env.RAW) return;
    try {
      const obj = await this.env.RAW.get(STATE_KEY);
      if (obj) this.cookie = (await obj.json())?.cookie || null;
    } catch (_) { this.cookie = null; }
  }

  async saveCookie() {
    if (!this.env.RAW) return;
    await this.env.RAW.put(STATE_KEY, JSON.stringify({ cookie: this.cookie, saved_at: new Date().toISOString() }));
  }

  headers() {
    const h = { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
    if (this.cookie) h.cookie = this.cookie;
    return h;
  }

  async rawGet(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.throttle();
      this.subrequests += 1;
      let res;
      try {
        res = await fetch(url, { headers: this.headers(), redirect: 'follow', cf: { cacheTtl: 0 } });
      } catch (e) {
        console.error(`[fetch] ${url} transport ${String(e?.message || e).slice(0, 100)} attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      this.statuses[res.status] = (this.statuses[res.status] || 0) + 1;
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        console.error(`[fetch] ${url} HTTP ${res.status} attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      if (res.status !== 200) throw new SchemaAssertionError(url, `HTTP ${res.status}`);
      return res.text();
    }
    throw new SchemaAssertionError(url, 'gave up after 4 attempts');
  }

  async passGate(html, url) {
    const ch = parseChallenge(html, url, this.maxDifficulty);
    const n = await solveChallenge(ch, url);
    await this.throttle();
    this.subrequests += 1;
    const res = await fetch(`${this.base}${ch.path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded', origin: this.base, referer: url },
      body: `nonce=${encodeURIComponent(ch.nonce)}&n=${n}`,
      redirect: 'manual',
    });
    if (!(res.status >= 200 && res.status < 300)) throw new AccessGateError(url, `challenge POST -> HTTP ${res.status}`);
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    if (!setCookie.length) throw new AccessGateError(url, 'challenge accepted but no cookie returned');
    this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    this.challengesSolved += 1;
    await this.saveCookie();
    console.log(`[fetch] challenge solved difficulty=${ch.difficulty} n=${n}`);
  }

  async httpGet(url) {
    await this.loadCookie();
    let html = await this.rawGet(url);
    if (!isInterstitial(html)) return html;
    this.interstitialsSeen += 1;
    this.lastInterstitialAt = new Date().toISOString();
    if (!this.solveGate) throw new AccessGateError(url, 'challenge interstitial present (canary does not answer challenges)');
    await this.passGate(html, url);
    html = await this.rawGet(url);
    if (isInterstitial(html)) throw new AccessGateError(url, 'interstitial persisted after solved challenge');
    return html;
  }

  /* kind: lists|events|fights|fighters. Returns { html, fromCache }. */
  async get(kind, key, url, { refresh = false } = {}) {
    const r2key = `ufc-raw/${kind}/${key}.html`;
    if (!refresh && this.env.RAW) {
      const obj = await this.env.RAW.get(r2key);
      if (obj) return { html: await obj.text(), fromCache: true };
    }
    const html = await this.httpGet(url);
    this.fetched[kind] = (this.fetched[kind] || 0) + 1;
    if (this.env.RAW && kind !== 'lists') {
      await this.env.RAW.put(r2key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    }
    return { html, fromCache: false };
  }

  telemetry() {
    return {
      requests: this.subrequests, http_statuses: this.statuses, fetched: this.fetched,
      interstitials_seen: this.interstitialsSeen, last_interstitial_at: this.lastInterstitialAt,
      challenges_solved: this.challengesSolved, cookie_present: Boolean(this.cookie),
    };
  }

  url(kind, id) {
    const path = { events: 'event-details', fights: 'fight-details', fighters: 'fighter-details' }[kind];
    return `${this.base}/${path}/${id}`;
  }
}
