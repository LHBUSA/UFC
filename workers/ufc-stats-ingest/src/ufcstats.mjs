/* Fetch layer for ufcstats.com inside the Worker.
 *
 * Serial. Cache-first against R2 (ufc-raw/{kind}/{key}.html) so re-parsing
 * never re-scrapes. Detects the site's JS challenge interstitial and throws
 * AccessGateError instead of handing the parsers a "Checking your browser"
 * page.
 *
 * The access strategy is `httpGet` and nothing else. When the decision in
 * docs/scraper_notes.md is made, it changes here.
 */

export class SchemaAssertionError extends Error {
  constructor(url, detail) { super(`${detail} @ ${url}`); this.name = 'SchemaAssertionError'; this.url = url; this.detail = detail; }
}
export class AccessGateError extends Error {
  constructor(url) { super(`JS challenge interstitial served for ${url}; fetch strategy not decided (docs/scraper_notes.md)`); this.name = 'AccessGateError'; this.url = url; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export function isInterstitial(html) {
  const head = html.slice(0, 4000);
  return (head.includes('Checking your browser') && head.includes('/__c'))
    || (html.length < 6000 && head.includes('This site requires JavaScript'));
}

export function extractId(url) {
  const m = String(url).match(/([0-9a-f]{16})(?:[/?]|$)/);
  if (!m) throw new Error(`no 16-hex id in ${url}`);
  return m[1];
}

export class Fetcher {
  constructor(env, { minIntervalMs = 1000 } = {}) {
    this.env = env;
    this.base = String(env.UFCSTATS_BASE || 'http://ufcstats.com').replace(/\/$/, '');
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.subrequests = 0;
    this.fetched = { lists: 0, events: 0, fights: 0, fighters: 0 };
  }

  async throttle() {
    const wait = this.minIntervalMs - (Date.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }

  async httpGet(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.throttle();
      this.subrequests += 1;
      let res;
      try {
        res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' }, cf: { cacheTtl: 0 } });
      } catch (e) {
        console.error(`[fetch] ${url} transport ${String(e?.message || e).slice(0, 100)} attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        console.error(`[fetch] ${url} HTTP ${res.status} attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      if (res.status !== 200) throw new SchemaAssertionError(url, `HTTP ${res.status}`);
      const html = await res.text();
      if (isInterstitial(html)) throw new AccessGateError(url);
      return html;
    }
    throw new SchemaAssertionError(url, 'gave up after 4 attempts');
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

  url(kind, id) {
    const path = { events: 'event-details', fights: 'fight-details', fighters: 'fighter-details' }[kind];
    return `${this.base}/${path}/${id}`;
  }
}
