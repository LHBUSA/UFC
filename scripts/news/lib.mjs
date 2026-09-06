/* Shared helpers for the ufc.propbetedge.ai news pipeline.
 *
 * Plain Node (>=20), no npm dependencies. Everything talks to Supabase through
 * PostgREST with the service role key; the tables are used exactly as
 * migrations/001 defines them (no DDL from here).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AliasResolver, normalize } from '../../shared/alias_resolver.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const SITE_URL = 'https://ufc.propbetedge.ai';
export const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeNewsBot/1.0; +https://ufc.propbetedge.ai/about)';

/* ------------------------------------------------------------------ env */

export function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) env[m[1]] = v;
    }
  } catch { /* no .env, rely on process.env */ }
  return env;
}

/* ------------------------------------------------------------ PostgREST */

export class Supabase {
  constructor(env = loadEnv()) {
    this.url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
    this.key = env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!this.url || !this.key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)');
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async request(method, path, { body, prefer, range } = {}) {
    const headers = this.headers();
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostgREST ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  /* Paginates until the page comes back short. `query` is a PostgREST query string. */
  async select(table, query = 'select=*', pageSize = 1000) {
    const out = [];
    for (let from = 0; ; from += pageSize) {
      const rows = await this.request('GET', `${table}?${query}`, { range: `${from}-${from + pageSize - 1}` });
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async insert(table, rows, { onConflict, ignoreDuplicates = false, returning = true } = {}) {
    const prefer = [returning ? 'return=representation' : 'return=minimal'];
    if (ignoreDuplicates) prefer.push('resolution=ignore-duplicates');
    const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    return this.request('POST', `${table}${q}`, { body: rows, prefer: prefer.join(',') });
  }

  async upsert(table, rows, onConflict) {
    return this.request('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      body: rows,
      prefer: 'return=representation,resolution=merge-duplicates',
    });
  }

  async patch(table, filter, patch) {
    return this.request('PATCH', `${table}?${filter}`, { body: patch, prefer: 'return=representation' });
  }
}

/* ---------------------------------------------------------------- text */

export function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/* Mirrors web/lib/slug.ts slugify() so article links and event slugs agree. */
export function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function eventSlug(e) {
  return `${slugify(e.name)}-${e.event_date || 'tbd'}`;
}

export function fighterSlug(f) {
  return `${slugify(f.name)}-${f.espn_athlete_id || f.ufcstats_id || ''}`;
}

export function matchupSlug(a, b, e) {
  return `${slugify(a.name)}-vs-${slugify(b.name)}-${eventSlug(e)}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : m));
}

export function stripHtml(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > max * 0.6 ? sp : max - 1).replace(/[,;:\-–—]$/, '')}…`;
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function wordCount(s) {
  return String(s || '').split(/\s+/).filter(Boolean).length;
}

/* Canonical JSON (sorted keys) so the same facts always hash the same. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
export function factHash(block) {
  return sha256(canonicalJson(block));
}

/* Deterministic picker: the same slug always draws the same variant. */
export function pick(seed, options, salt = '') {
  const h = parseInt(sha256(`${seed}|${salt}`).slice(0, 8), 16);
  return options[h % options.length];
}

/* ------------------------------------------------------------- RSS/Atom */

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}
function attr(block, name, attrName) {
  const re = new RegExp(`<${name}\\b([^>]*)\\/?>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const a = m[1].match(new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i')) || m[1].match(new RegExp(`${attrName}\\s*=\\s*'([^']*)'`, 'i'));
    out.push({ attrs: m[1], value: a ? a[1] : null });
  }
  return out;
}
function clean(s) {
  return stripHtml(s == null ? '' : s);
}

/* Returns [{title, link, published, summary}] for RSS 2.0, RSS 1.0 (rdf) and Atom. */
export function parseFeed(xml) {
  const text = String(xml || '');
  const items = [];
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = text.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    let link = null;
    if (isAtom) {
      const links = attr(b, 'link', 'href');
      const alt = links.find((l) => /rel\s*=\s*"alternate"/i.test(l.attrs)) || links.find((l) => !/rel\s*=/i.test(l.attrs)) || links[0];
      link = alt ? alt.value : null;
    } else {
      link = clean(tag(b, 'link'));
      if (!link) {
        const g = tag(b, 'guid');
        if (g && /^https?:\/\//i.test(clean(g))) link = clean(g);
      }
      if (!link) {
        const l = attr(b, 'link', 'href')[0];
        link = l ? l.value : null;
      }
    }
    const published = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'dc:date') || tag(b, 'updated'));
    const summaryRaw = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content') || '';
    const title = clean(tag(b, 'title'));
    if (!title || !link) continue;
    items.push({ title, link: decodeEntities(link.trim()), published: published || null, summary: truncate(clean(summaryRaw), 400) });
  }
  return items;
}

export function parseDate(s) {
  if (!s) return null;
  let d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    /* "Fri, 4 Sep 2026 16:09:53 EST"-style strings with an unknown zone: try dropping the zone. */
    d = new Date(String(s).replace(/\s+[A-Z]{2,5}$/, ' GMT'));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/* Retries transport errors (ECONNRESET, timeouts) but never HTTP errors. */
export async function fetchText(url, { timeoutMs = 25000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      /* No Accept header on purpose: ESPN's feed host resets the connection when one is sent. */
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: ctl.signal });
      const body = await res.text();
      return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', body, finalUrl: res.url };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------ taxonomy */

export const TAXONOMY_LABELS = ['withdrawal', 'replacement', 'weight_miss', 'bout_moved', 'injury', 'suspension', 'rankings', 'contract', 'result', 'other'];
export const EXTERNAL_STORY_LABELS = new Set(['withdrawal', 'replacement', 'weight_miss', 'bout_moved', 'injury', 'suspension', 'rankings', 'contract']);

const RULES = {
  withdrawal: /\b(withdraw(?:s|n|al)?|pull(?:s|ed|ing)? out|out of (?:ufc|the card|the fight|his fight|her fight|their fight)|off the card|removed from|drops? out|no longer (?:fighting|facing|on)|scrapped|cancel(?:led|ed|s)?|called off)\b/gi,
  replacement: /\b(replac(?:es|ed|ement|ing)|steps? in|stepping in|fills? in|filling in|short[- ]notice|new opponent|late notice|now faces|new matchup|booked against)\b/gi,
  weight_miss: /\b(miss(?:es|ed)? weight|weight miss|fail(?:s|ed)? to make weight|(?:pound|lb)s? over|came in (?:heavy|over)|catchweight|overweight|weigh-?in (?:miss|drama|fail))\b/gi,
  bout_moved: /\b(moved to|rebooked|re-booked|rescheduled|shifted to|bumped (?:to|up)|postponed|new date|now headlin(?:es|ing)|elevated to|main card promotion)\b/gi,
  injury: /\b(injur(?:y|ed|ies)|torn|tears?|broken|fracture[ds]?|surgery|concussion|illness|hospitali[sz]ed|medical(?:ly)?|sick|acl|mcl|staph)\b/gi,
  suspension: /\b(suspend(?:ed|s|sion)|usada|anti-?doping|banned|ban|flagged|drug test|cscs|nsac|commission (?:ruling|fine))\b/gi,
  rankings: /\b(rankings?|ranked|pound-for-pound|p4p|top[- ]?(?:5|10|15)|climbs|moves up|movers)\b/gi,
  contract: /\b(contracts?|signs?|signed|signing|re-?signs?|extension|free agen(?:t|cy)|releas(?:ed|es|e)|cut from|parts ways|retir(?:es|ement|ed|ing)|bonus(?:es)?|purse|payout)\b/gi,
  result: /\b(def\.|defeats?|beats?|wins?|won|stops|knocks out|knocked out|knockout|submits?|submitted|tko|ko|decision|results?|finish(?:es|ed)?|upsets?|tops|scorecards?|round-by-round|recap)\b/gi,
};

/* Title hits count for more than summary hits: the title is what an external story may quote. */
export function classify(title, summary) {
  const scores = {};
  const matched = {};
  for (const [label, re] of Object.entries(RULES)) {
    const t = [...String(title || '').matchAll(re)].map((m) => m[1].toLowerCase());
    const s = [...String(summary || '').matchAll(re)].map((m) => m[1].toLowerCase());
    if (!t.length && !s.length) continue;
    let score = 0;
    if (t.length) score = Math.min(0.95, 0.65 + 0.1 * (t.length - 1) + 0.05 * Math.min(2, s.length));
    else score = Math.min(0.55, 0.4 + 0.05 * (s.length - 1));
    scores[label] = Math.round(score * 100) / 100;
    matched[label] = [...new Set([...t, ...s])];
  }
  const labels = Object.keys(scores).sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
  if (!labels.length) return { labels: ['other'], confidence: 0.3, matched: [], scores: {} };
  return {
    labels,
    confidence: scores[labels[0]],
    matched: labels.flatMap((l) => matched[l].map((m) => `${l}:${m}`)),
    scores,
  };
}

/* ----------------------------------------------------- domain helpers */

export function recordString(f) {
  if (f == null || f.record_w == null) return null;
  let s = `${f.record_w}-${f.record_l ?? 0}-${f.record_d ?? 0}`;
  if (f.record_nc) s += ` (${f.record_nc} NC)`;
  return s;
}

export function ageOn(dob, dateStr) {
  if (!dob || !dateStr) return null;
  const d = new Date(dob);
  const on = new Date(dateStr);
  if (Number.isNaN(d.getTime()) || Number.isNaN(on.getTime())) return null;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

export function heightString(inches) {
  if (inches == null) return null;
  const n = Number(inches);
  const ft = Math.floor(n / 12);
  const rest = Math.round((n - ft * 12) * 2) / 2;
  return `${ft}'${rest}"`;
}

export function mmss(sec) {
  if (sec == null) return null;
  const s = Number(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const WEIGHT_CLASS_LABEL = {
  STRAWWEIGHT: 'strawweight', FLYWEIGHT: 'flyweight', BANTAMWEIGHT: 'bantamweight', FEATHERWEIGHT: 'featherweight',
  LIGHTWEIGHT: 'lightweight', WELTERWEIGHT: 'welterweight', MIDDLEWEIGHT: 'middleweight', LIGHT_HEAVYWEIGHT: 'light heavyweight',
  HEAVYWEIGHT: 'heavyweight', SUPER_HEAVYWEIGHT: 'super heavyweight', CATCHWEIGHT: 'catchweight', OPEN: 'openweight',
};
export function weightClassLabel(bout) {
  const base = WEIGHT_CLASS_LABEL[bout.weight_class] || (bout.weight_class_raw ? bout.weight_class_raw.toLowerCase().replace(/\s*bout$/, '') : 'unlisted weight');
  return bout.is_womens && !/women/.test(base) ? `women's ${base}` : base;
}

export const METHOD_LABEL = {
  KO_TKO: 'KO/TKO', SUB: 'submission', DEC_U: 'unanimous decision', DEC_S: 'split decision', DEC_M: 'majority decision',
  DQ: 'disqualification', NC: 'no contest', DRAW: 'draw', OTHER: 'other',
};

export function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* "UFC 331: Van vs. Pantoja 2" -> "UFC 331"; "Noche UFC: Silva vs. Delgado" -> "Noche UFC";
 * "UFC Fight Night: Hooker vs. Parnasse" stays whole (the prefix alone is ambiguous). */
export function eventShortName(name) {
  const n = String(name || '').trim();
  const m = n.match(/^([^:]+):\s*(.+)$/);
  if (!m) return n;
  const head = m[1].trim();
  if (/^ufc fight night$/i.test(head)) return n;
  return head;
}

export function isContenderSeries(name) {
  return /contender series|dwcs|road to ufc/i.test(String(name || ''));
}

export function formatDate(dateStr) {
  if (!dateStr) return 'a date to be announced';
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function shortDate(dateStr) {
  if (!dateStr) return 'TBD';
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* ------------------------------------------------------ data loading */

/* Same event captured from ESPN and UFC Stats can sit in ufc_events twice
 * (one row per source id). Group by normalized name + date; the primary is
 * the copy with the richest bout data. Venue/city/country fall back to the
 * sibling when the primary lacks them. */
export function dedupeEvents(events, { boutsByEvent = new Map(), resultsByBout = new Map(), statsByBout = new Map() } = {}) {
  const groups = new Map();
  for (const e of events) {
    const k = `${normalize(e.name)}|${e.event_date || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    const scored = list.map((e) => {
      const bouts = boutsByEvent.get(e.id) || [];
      const results = bouts.filter((b) => resultsByBout.has(b.id)).length;
      const stats = bouts.filter((b) => statsByBout.has(b.id)).length;
      return { e, score: stats * 10000 + results * 100 + bouts.length + (e.venue ? 1 : 0) };
    }).sort((a, b) => b.score - a.score);
    const primary = { ...scored[0].e, alt_ids: scored.slice(1).map((s) => s.e.id) };
    for (const s of scored.slice(1)) {
      for (const k of ['venue', 'city', 'region', 'country']) if (primary[k] == null && s.e[k] != null) primary[k] = s.e[k];
    }
    out.push(primary);
  }
  return out;
}

export async function loadFighterIndex(sb) {
  const [fighters, aliases] = await Promise.all([
    sb.select('ufc_fighters', 'select=id,ufcstats_id,espn_athlete_id,name,nickname,dob,record_w,record_l,record_d,record_nc,height_in,reach_in,stance,weight_lbs,career_slpm,career_str_acc,career_sapm,career_str_def,career_td_avg,career_td_acc,career_td_def,career_sub_avg,source_url'),
    sb.select('ufc_fighter_aliases', 'select=fighter_id,alias,source,normalized'),
  ]);
  const aliasesByFighter = new Map();
  for (const a of aliases) {
    if (!aliasesByFighter.has(a.fighter_id)) aliasesByFighter.set(a.fighter_id, []);
    aliasesByFighter.get(a.fighter_id).push(a.alias);
  }
  const resolver = new AliasResolver(fighters.map((f) => ({
    id: f.id,
    ufcstats_id: f.ufcstats_id,
    name: f.name,
    nickname: f.nickname,
    dob: f.dob,
    record: recordString(f),
    aliases: aliasesByFighter.get(f.id) || [],
  })));
  const byId = new Map(fighters.map((f) => [f.id, f]));
  return { fighters, byId, aliasesByFighter, resolver };
}

/* Mention scan: multi-token names/aliases only (single-token nicknames such as
 * "Gunslinger" tag far too loosely). Accepts a name-only hit when the resolver's
 * exact-normalized candidate list is unambiguous. This is a tag, not a merge,
 * so name-only is acceptable here; the resolver's second-key rule still governs
 * fighter identity everywhere else. */
export function findFighterMentions(text, index) {
  const norm = ` ${normalize(text)} `;
  if (!norm.trim()) return [];
  const hits = new Map();
  const seen = new Set();
  const candidates = [];
  for (const f of index.fighters) {
    for (const raw of [f.name, ...(index.aliasesByFighter.get(f.id) || [])]) {
      const n = normalize(raw);
      if (!n || seen.has(n) || n.split(' ').length < 2) continue;
      seen.add(n);
      candidates.push({ raw, n });
    }
  }
  for (const c of candidates) {
    if (!norm.includes(` ${c.n} `)) continue;
    const r = index.resolver.resolve(c.raw, 'news');
    let fid = null;
    if (r.status === 'matched') fid = r.fighter_id;
    else {
      const exact = (r.candidates || []).filter((x) => x.reasons.includes('exact_normalized'));
      if (exact.length === 1) fid = exact[0].fighter_id;
    }
    if (fid && !hits.has(fid)) hits.set(fid, { fighter_id: fid, alias: c.raw });
  }
  return [...hits.values()];
}

export function surname(name) {
  const toks = normalize(name).split(' ').filter(Boolean);
  return toks.length ? toks[toks.length - 1] : '';
}
