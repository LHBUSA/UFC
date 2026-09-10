#!/usr/bin/env node
/* PropBetEdge UFC — official rankings ingest.
 *
 * Source: https://www.ufc.com/rankings (static HTML). Parses the 13 official
 * lists (men's P4P, 8 men's divisions, women's P4P, 3 women's divisions),
 * links names to ufc_fighters through shared/alias_resolver normalize(),
 * uploads a JSON snapshot to the public `ufc-media` Storage bucket
 * (rankings/latest.json + rankings/YYYY-MM-DD.json) and upserts ufc_rankings
 * when that table exists (migration 003; a PostgREST 404 is "not applied yet"
 * and is skipped, not an error).
 *
 *   node scripts/rankings/ingest_rankings.mjs --dry-run          parse + link, write nothing
 *   node scripts/rankings/ingest_rankings.mjs                    real run
 *   node scripts/rankings/ingest_rankings.mjs --html file.html   parse a saved page instead of fetching
 *
 * No dependencies beyond node built-ins (Node 18+, global fetch).
 * Every structural assumption about the page is asserted; a page that does not
 * look like the one verified on 2026-09-06 makes the script throw before it
 * writes anything.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../shared/alias_resolver.mjs';

/* Computed LAZILY, and only on the CLI path.
 *
 * At module scope this threw the Worker's startup: workerd leaves
 * import.meta.url undefined, so fileURLToPath(undefined) raises before any
 * handler runs and the deploy fails with a bare validation error. A repo-root
 * path is a Node concept and a Worker has no use for one, so it must not be
 * computed merely by loading the file. */
function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
const SOURCE_URL = 'https://www.ufc.com/rankings';
const BUCKET = 'ufc-media';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/* Options are an ARGUMENT, not module-scope state read from argv at import.
 * The Worker imports this module once per isolate and calls main() many times;
 * anything decided at import is decided for the life of the isolate, and
 * process.argv is empty in workerd regardless. This is the same refactor
 * ingest_news.mjs already carries. */
export function parseCliOptions(argv = []) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  return { dry: argv.includes('--dry-run'), html: at('--html') };
}


// ---------------------------------------------------------------------------
// Division catalogue. Order here is the order of `divisions` in the snapshot.
// ---------------------------------------------------------------------------
const LABELS = {
  STRAWWEIGHT: 'Strawweight',
  FLYWEIGHT: 'Flyweight',
  BANTAMWEIGHT: 'Bantamweight',
  FEATHERWEIGHT: 'Featherweight',
  LIGHTWEIGHT: 'Lightweight',
  WELTERWEIGHT: 'Welterweight',
  MIDDLEWEIGHT: 'Middleweight',
  LIGHT_HEAVYWEIGHT: 'Light Heavyweight',
  HEAVYWEIGHT: 'Heavyweight',
};
const MEN = ['FLYWEIGHT', 'BANTAMWEIGHT', 'FEATHERWEIGHT', 'LIGHTWEIGHT', 'WELTERWEIGHT', 'MIDDLEWEIGHT', 'LIGHT_HEAVYWEIGHT', 'HEAVYWEIGHT'];
const WOMEN = ['STRAWWEIGHT', 'FLYWEIGHT', 'BANTAMWEIGHT'];
const EXPECTED = [
  { key: 'P4P', label: "Men's Pound-for-Pound", is_womens: false, is_p4p: true },
  ...MEN.map((k) => ({ key: k, label: LABELS[k], is_womens: false, is_p4p: false })),
  { key: 'P4P', label: "Women's Pound-for-Pound", is_womens: true, is_p4p: true },
  ...WOMEN.map((k) => ({ key: k, label: `Women's ${LABELS[k]}`, is_womens: true, is_p4p: false })),
];
const divId = (d) => `${d.is_womens ? 'W' : 'M'}:${d.key}`;
const MIN_ENTRIES = 10; // UFC publishes 15; anything under 10 means the parse slipped
const MAX_ENTRIES = 16;

// ---------------------------------------------------------------------------
// Small HTML helpers. The page is Drupal views output: flat, predictable.
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
const stripTags = (s) => String(s).replace(/<[^>]*>/g, '');
const clean = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

class ParseError extends Error {}
function assert(cond, msg) {
  if (!cond) throw new ParseError(`rankings page assertion failed: ${msg}`);
}

/* "Flyweight" | "Women's Strawweight" | "Men's Pound-for-Pound <span>Top Rank</span>" -> catalogue entry */
function classifyHeader(rawHeader) {
  const text = clean(rawHeader.replace(/<span[\s\S]*?<\/span>/g, ''));
  let n = normalize(text); // apostrophes vanish in normalize(): "Women's" -> "womens"
  const is_womens = n.startsWith('womens ');
  if (is_womens) n = n.slice('womens '.length);
  else if (n.startsWith('mens ')) n = n.slice('mens '.length);
  let key = null;
  if (n === 'pound for pound') key = 'P4P';
  else key = Object.keys(LABELS).find((k) => normalize(LABELS[k]) === n) || null;
  if (!key) return { text, division: null };
  const division = EXPECTED.find((d) => d.key === key && d.is_womens === is_womens) || null;
  return { text, division };
}

/* Observed cell values (2026-09-06): empty; "<span ...rank-increase>Rank increased by</span> N";
 * "<span ...rank-decrease>Rank decreased by</span> N"; "<span ...not-ranked>NR</span>". */
function parseChange(cellInner) {
  const text = clean(cellInner);
  if (!text) return { change: 0, is_new: false, warning: null };
  const inc = /rank-increase|increased by/i.test(cellInner);
  const dec = /rank-decrease|decreased by/i.test(cellInner);
  const num = text.match(/(\d+)\s*$/);
  if ((inc || dec) && num) return { change: (inc ? 1 : -1) * Number(num[1]), is_new: false, warning: null };
  if (/not-ranked/i.test(cellInner) || /^NR$/i.test(text)) return { change: null, is_new: true, warning: null };
  return { change: null, is_new: false, warning: `unrecognised rank-change cell "${text}"` };
}

function parseGrouping(segment, warnings) {
  const headerM = segment.match(/<div class="view-grouping-header">([\s\S]*?)<\/div>/);
  assert(headerM, 'view-grouping without a view-grouping-header');
  const { text: headerText, division } = classifyHeader(headerM[1]);
  if (!division) return { headerText, division: null };

  // Champion caption. P4P captions repeat the #1 fighter without a "Champion" h6.
  let champion = null;
  let p4pCaption = null;
  const capM = segment.match(/<caption>([\s\S]*?)<\/caption>/);
  if (capM) {
    const h5 = capM[1].match(/<h5>\s*<a href="\/athlete\/([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h5>/);
    if (h5) {
      const isChampionCaption = /<h6>[\s\S]*?Champion[\s\S]*?<\/h6>/i.test(capM[1]);
      const person = { name: clean(h5[2]), ufc_slug: decodeEntities(h5[1]).trim(), fighter_id: null };
      if (division.is_p4p) {
        p4pCaption = person; // checked against rank 1 below
        if (isChampionCaption) warnings.push(`${headerText}: P4P caption unexpectedly carries a Champion h6`);
      } else {
        if (!isChampionCaption) warnings.push(`${headerText}: caption has no "Champion" h6; treating ${person.name} as champion anyway`);
        champion = person;
      }
    }
  }
  if (!division.is_p4p && !champion) warnings.push(`${headerText}: no champion in caption (vacant title?)`);

  const tbodyM = segment.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert(tbodyM, `${headerText}: no <tbody>`);
  const rows = tbodyM[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const entries = [];
  for (const row of rows) {
    // The page carries each grouping twice; the second run (mobile layout) names the
    // cells views-field-meta-weight-class-rank[-change]. Accept both.
    const rankM = row.match(/<td class="views-field views-field-(?:meta-)?weight-class-rank">([\s\S]*?)<\/td>/);
    const titleM = row.match(/<td class="views-field views-field-title">([\s\S]*?)<\/td>/);
    const changeM = row.match(/<td class="views-field views-field-(?:meta-)?weight-class-rank-change">([\s\S]*?)<\/td>/);
    assert(rankM && titleM && changeM, `${headerText}: row is missing one of the expected td classes: ${clean(row).slice(0, 80)}`);
    const rankText = clean(rankM[1]);
    assert(/^\d+$/.test(rankText), `${headerText}: rank cell is not an integer: "${rankText}"`);
    const a = titleM[1].match(/<a href="\/athlete\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    assert(a, `${headerText}: title cell has no /athlete/ link: ${clean(titleM[1])}`);
    const name = clean(a[2]);
    assert(name, `${headerText}: empty fighter name at rank ${rankText}`);
    const { change, is_new, warning } = parseChange(changeM[1]);
    if (warning) warnings.push(`${headerText} #${rankText} ${name}: ${warning}`);
    entries.push({ rank: Number(rankText), name, ufc_slug: decodeEntities(a[1]).trim(), fighter_id: null, change, is_new });
  }
  return { headerText, division, champion, entries, p4pCaption };
}

/* Competition ranking: each row's rank is its 1-based position, or equal to the
 * previous row's rank when tied (seen 2026-09-06: men's P4P 10, 10, 12). */
function isComplete(g) {
  if (!g.entries.length) return false;
  return g.entries.every((e, i) => e.rank === i + 1 || (i > 0 && e.rank === g.entries[i - 1].rank));
}

export function parseRankings(html, { warnings = [] } = {}) {
  const starts = [];
  const re = /<div class="view-grouping"[^>]*>/g;
  for (let m; (m = re.exec(html)); ) starts.push(m.index);
  assert(starts.length >= EXPECTED.length, `expected at least ${EXPECTED.length} div.view-grouping blocks, found ${starts.length}`);

  const found = new Map(); // divId -> first complete grouping (the page repeats groupings lower down)
  const unknownHeaders = [];
  starts.forEach((s, i) => {
    const seg = html.slice(s, starts[i + 1] ?? html.length);
    const g = parseGrouping(seg, warnings);
    if (!g.division) {
      unknownHeaders.push(g.headerText);
      return;
    }
    const id = divId(g.division);
    const prev = found.get(id);
    if (!prev || (!isComplete(prev) && isComplete(g))) found.set(id, g);
  });
  assert(unknownHeaders.length === 0, `unrecognised division header(s): ${unknownHeaders.map((h) => JSON.stringify(h)).join(', ')}`);

  const missing = EXPECTED.filter((d) => !found.has(divId(d)));
  assert(missing.length === 0, `missing division(s): ${missing.map((d) => d.label).join(', ')}`);

  return EXPECTED.map((d) => {
    const g = found.get(divId(d));
    assert(isComplete(g), `${d.label}: ranks are not 1..N with competition-style ties (${g.entries.map((e) => e.rank).join(',')})`);
    const ties = g.entries.filter((e, i) => i > 0 && e.rank === g.entries[i - 1].rank);
    for (const t of ties) warnings.push(`${d.label}: tie at rank ${t.rank} (${g.entries.filter((e) => e.rank === t.rank).map((e) => e.name).join(' / ')})`);
    assert(
      g.entries.length >= MIN_ENTRIES && g.entries.length <= MAX_ENTRIES,
      `${d.label}: ${g.entries.length} entries (expected ${MIN_ENTRIES}-${MAX_ENTRIES})`,
    );
    if (g.entries.length !== 15) warnings.push(`${d.label}: ${g.entries.length} ranked entries (usually 15)`);
    const slugs = new Set(g.entries.map((e) => e.ufc_slug));
    assert(slugs.size === g.entries.length, `${d.label}: duplicate athlete slug in the list`);
    if (d.is_p4p && g.p4pCaption && g.p4pCaption.ufc_slug !== g.entries[0].ufc_slug) {
      warnings.push(`${d.label}: caption shows ${g.p4pCaption.name} but rank 1 is ${g.entries[0].name}`);
    }
    return { key: d.key, label: d.label, is_womens: d.is_womens, is_p4p: d.is_p4p, champion: g.champion, entries: g.entries };
  });
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST + Storage) via fetch with the service role.
// ---------------------------------------------------------------------------
/* `injected` is the Worker's env. When present the filesystem is never
 * touched: a Worker has no .env and no process.env, and reaching for either
 * is how a module stops being portable. */
function loadEnv(injected) {
  if (injected && injected.SUPABASE_URL) {
    return { ...injected, SUPABASE_URL: String(injected.SUPABASE_URL).replace(/\/+$/, '') };
  }
  const env = {};

  const p = join(repoRoot(), '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (process.env[k]) env[k] = process.env[k];
  if (env.SUPABASE_URL) env.SUPABASE_URL = env.SUPABASE_URL.replace(/\/+$/, '');
  return env;
}

function sbHeaders(env, extra = {}) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra };
}

async function pageAll(env, path, select) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const url = `${env.SUPABASE_URL}/rest/v1/${path}?select=${encodeURIComponent(select)}&order=id.asc`;
    const res = await fetch(url, { headers: sbHeaders(env, { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' }) });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/* normalized name -> Set(fighter_id). Fighter names + every alias except nicknames
 * (a nickname that happens to equal another person's real name must not link). */
async function loadFighterIndex(env) {
  const byNorm = new Map();
  const add = (norm, id) => {
    if (!norm) return;
    if (!byNorm.has(norm)) byNorm.set(norm, new Set());
    byNorm.get(norm).add(id);
  };
  const fighters = await pageAll(env, 'ufc_fighters', 'id,name');
  for (const f of fighters) add(normalize(f.name), f.id);
  const aliases = await pageAll(env, 'ufc_fighter_aliases', 'id,fighter_id,alias,source,normalized');
  let used = 0;
  for (const a of aliases) {
    if (/nickname/i.test(a.source || '')) continue;
    add(normalize(a.alias), a.fighter_id);
    add(a.normalized, a.fighter_id);
    used += 1;
  }
  return { byNorm, fighters: fighters.length, aliases: used };
}

/* Link only when the name and the ufc.com slug together point at exactly one fighter. */
function linkPerson(person, byNorm, stats) {
  const cands = new Set();
  for (const n of [normalize(person.name), normalize(person.ufc_slug)]) for (const id of byNorm.get(n) || []) cands.add(id);
  if (cands.size === 1) {
    person.fighter_id = [...cands][0];
    stats.linked += 1;
  } else if (cands.size > 1) {
    person.fighter_id = null;
    stats.ambiguous += 1;
  } else {
    person.fighter_id = null;
    stats.unmatched += 1;
  }
}

async function uploadJson(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: sbHeaders(env, { 'content-type': 'application/json', 'x-upsert': 'true', 'cache-control': 'max-age=300' }),
    body,
  });
  if (!res.ok) throw new Error(`storage upload ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function upsertRows(env, rows) {
  // name_raw is in the key because ufc.com prints ties (two fighters at the same rank).
  const url = `${env.SUPABASE_URL}/rest/v1/ufc_rankings?on_conflict=snapshot_date,division,is_womens,rank,name_raw`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sbHeaders(env, { 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (res.status === 404) {
    console.log('[rankings] ufc_rankings not found (HTTP 404): migration 003 not applied yet; table write skipped');
    return 'skipped(404)';
  }
  if (!res.ok) throw new Error(`upsert ufc_rankings -> HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return `upserted ${rows.length}`;
}

function tableRows(snapshot) {
  const rows = [];
  for (const d of snapshot.divisions) {
    const base = {
      snapshot_date: snapshot.snapshot_date,
      division: d.key,
      is_womens: d.is_womens,
      is_p4p: d.is_p4p,
      source_url: snapshot.source_url,
      captured_at: snapshot.captured_at,
    };
    if (d.champion) {
      rows.push({ ...base, rank: 0, fighter_id: d.champion.fighter_id, name_raw: d.champion.name, ufc_slug: d.champion.ufc_slug, rank_change: null, is_new: false });
    }
    for (const e of d.entries) {
      rows.push({ ...base, rank: e.rank, fighter_id: e.fighter_id, name_raw: e.name, ufc_slug: e.ufc_slug, rank_change: e.change, is_new: e.is_new });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
export async function main(injectedEnv, options = {}) {
  const opts = { dry: Boolean(options.dry), html: options.html || null };
  const env = loadEnv(injectedEnv);
  const warnings = [];


  let html;
  const localHtml = opts.html;
  if (localHtml) {
    html = readFileSync(localHtml, 'utf8');   /* CLI only; a Worker never sets this */
  } else {
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) throw new Error(`GET ${SOURCE_URL} -> HTTP ${res.status}`);
    html = await res.text();
  }
  assert(html.length > 50_000, `page body suspiciously small (${html.length} bytes)`);

  const divisions = parseRankings(html, { warnings });
  const capturedAt = new Date();
  const snapshot = {
    captured_at: capturedAt.toISOString(),
    source_url: SOURCE_URL,
    snapshot_date: capturedAt.toISOString().slice(0, 10),
    divisions,
  };

  // Link to ufc_fighters. Reads only; runs in --dry-run too when creds exist.
  const stats = { linked: 0, ambiguous: 0, unmatched: 0 };
  const people = divisions.flatMap((d) => [...(d.champion ? [d.champion] : []), ...d.entries]);
  const haveCreds = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  if (haveCreds) {
    const idx = await loadFighterIndex(env);
    for (const p of people) linkPerson(p, idx.byNorm, stats);
    console.log(`[rankings] fighter index: ${idx.fighters} fighters, ${idx.aliases} aliases`);
  } else {
    warnings.push('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing: fighter linking skipped');
    stats.unmatched = people.length;
  }

  const champions = divisions.filter((d) => d.champion).length;
  const entries = divisions.reduce((n, d) => n + d.entries.length, 0);
  for (const w of warnings) console.log(`[rankings] warn: ${w}`);
  for (const d of divisions) {
    const linked = [...(d.champion ? [d.champion] : []), ...d.entries].filter((p) => p.fighter_id).length;
    console.log(`[rankings] ${d.label.padEnd(24)} champ=${d.champion ? d.champion.name : '-'} entries=${d.entries.length} linked=${linked}`);
  }

  let storage = 'dry-run';
  let table = 'dry-run';
  if (!opts.dry) {
    if (!haveCreds) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required for a real run');
    const body = JSON.stringify(snapshot);
    await uploadJson(env, 'rankings/latest.json', body);
    await uploadJson(env, `rankings/${snapshot.snapshot_date}.json`, body);
    storage = `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/rankings/latest.json`;
    table = await upsertRows(env, tableRows(snapshot));
  }

  console.log(
    `[rankings] ${opts.dry ? 'DRY-RUN ' : ''}snapshot=${snapshot.snapshot_date} divisions=${divisions.length} champions=${champions} entries=${entries} ` +
      `linked=${stats.linked}/${people.length} ambiguous=${stats.ambiguous} unmatched=${stats.unmatched} warnings=${warnings.length} storage=${storage} table=${table}`,
  );

  /* Returned rather than logged-and-grepped. The GitHub job parsed counters
   * out of stdout and read zero whenever a line moved. */
  return {
    snapshot_date: snapshot.snapshot_date,
    divisions: divisions.length,
    champions,
    entries,
    linked: stats.linked,
    people: people.length,
    ambiguous: stats.ambiguous,
    unmatched: stats.unmatched,
    warnings,
    storage,
    table,
    dry: opts.dry,
  };
}

/* CLI ONLY. Importing this module must never ingest: the previous version
 * called main() at module scope with no guard, so merely loading the file -
 * which is exactly what a Worker does - fetched ufc.com, uploaded a snapshot
 * and upserted ufc_rankings as a side effect of the import. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('ingest_rankings.mjs');
if (isCli) {
  main(undefined, parseCliOptions(process.argv.slice(2))).catch((err) => {
    console.error(`[rankings] FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
