#!/usr/bin/env node
/* Seed and verify ufc_news_sources. Idempotent: upserts on (kind, name).
 *
 * Every RSS candidate URL is fetched and parsed before it is written; a
 * source whose feed does not return at least one item is not seeded (and is
 * disabled if an earlier run had seeded it). One `internal` source,
 * propbetedge-tables, represents stories generated from our own tables.
 *
 *   node scripts/news/seed_sources.mjs [--dry-run]
 *
 * This is not one-time setup, which is why the Worker runs it on a cadence.
 * Feeds move and feeds die: MMA Fighting and MMA Junkie each already have a
 * known alternate URL listed below because their first one stopped working.
 * Ingest reads `enabled=true` and asks no questions, so if nothing ever
 * re-verifies, a dead feed stays enabled and contributes silence — which looks
 * exactly like a quiet news day.
 *
 * Worker-callable on the same terms as the other two phases: env injected,
 * options explicit, and NOTHING runs on import. This file previously called
 * main() at module scope with no CLI guard, so importing it — which is what a
 * Worker does — would have seeded and disabled sources as a side effect of
 * loading the module.
 */
import { Supabase, fetchText, parseFeed } from './lib.mjs';

const RSS_SOURCES = [
  /* The brief's URL is listed first; a known-good alternate follows when the site moved its feed. */
  { name: 'MMA Fighting', urls: ['https://www.mmafighting.com/rss/current', 'https://www.mmafighting.com/rss/index.xml'], weight: 1 },
  { name: 'MMA Junkie', urls: ['https://mmajunkie.usatoday.com/feed', 'https://mmajunkie.usatoday.com/feed/'], weight: 1 },
  { name: 'ESPN MMA', urls: ['https://www.espn.com/espn/rss/mma/news'], weight: 1 },
  { name: 'Bloody Elbow', urls: ['https://www.bloodyelbow.com/feed'], weight: 1 },
  { name: 'UFC.com News', urls: ['https://www.ufc.com/rss/news'], weight: 0.8 },
];
const INTERNAL_SOURCE = { kind: 'internal', name: 'propbetedge-tables', url: null, weight: 2, enabled: true };

export function parseCliOptions(argv = []) {
  return { dry: argv.includes('--dry-run') };
}

export function resolveOptions(options = {}) {
  return { dry: Boolean(options.dry) };
}

/** Fetch and parse one candidate feed. Never throws: a source that cannot be
 *  reached is a fact about that source, not a failure of the pass. */
export async function verify(url) {
  try {
    const r = await fetchText(url);
    if (!r.ok) return { ok: false, reason: `http ${r.status}` };
    const items = parseFeed(r.body);
    if (!items.length) return { ok: false, reason: 'no items parsed' };
    return { ok: true, items: items.length, finalUrl: r.finalUrl };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Verify every candidate and choose a URL per source.
 *
 * Separated from the writing half so the decision can be tested without a
 * database, and so one dead source cannot stop the healthy ones: each source
 * is resolved independently and a failure is recorded, never thrown.
 */
export async function verifySources(sources = RSS_SOURCES, { log = console.log } = {}) {
  const chosen = [];
  const dropped = [];
  const attempts = [];
  for (const src of sources) {
    let url = null;
    for (const candidate of src.urls) {
      const v = await verify(candidate);
      attempts.push({ name: src.name, url: candidate, ...v });
      log(`${v.ok ? 'ok  ' : 'fail'} ${src.name} ${candidate} -> ${v.ok ? `${v.items} items` : v.reason}`);
      if (v.ok) { url = candidate; break; }
    }
    if (url) chosen.push({ kind: 'rss', name: src.name, url, weight: src.weight, enabled: true });
    else dropped.push(src.name);
  }
  return { chosen, dropped, attempts };
}

export async function main(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const sb = new Supabase(injectedEnv);

  const { chosen, dropped } = await verifySources();
  const rows = [INTERNAL_SOURCE, ...chosen];

  console.log(`\nseeding ${rows.length} sources${dropped.length ? `; dropped: ${dropped.join(', ')}` : ''}`);
  if (opts.dry) {
    console.log(JSON.stringify(rows, null, 2));
    return { verified: chosen.length, dropped: dropped.length, disabled: 0, enabled_total: null, dry: true };
  }

  const written = await sb.upsert('ufc_news_sources', rows, 'kind,name');
  for (const r of written) console.log(`  ${r.kind.padEnd(8)} ${r.name.padEnd(20)} weight=${r.weight} enabled=${r.enabled} ${r.url || ''}`);

  /* A previously seeded source whose feed no longer verifies gets switched off, not deleted. */
  let disabled = 0;
  for (const name of dropped) {
    const off = await sb.patch('ufc_news_sources', `kind=eq.rss&name=eq.${encodeURIComponent(name)}&enabled=is.true`, { enabled: false });
    if (off && off.length) { disabled += 1; console.log(`  disabled ${name} (feed no longer verifies)`); }
  }
  const all = await sb.select('ufc_news_sources', 'select=id,kind,name,enabled');
  const enabledTotal = all.filter((s) => s.enabled).length;
  console.log(`\nufc_news_sources: ${all.length} rows, ${enabledTotal} enabled`);
  return { verified: chosen.length, dropped: dropped.length, disabled, enabled_total: enabledTotal, dry: false };
}

/* CLI only. Importing this module must never write a source row. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('seed_sources.mjs');
if (isCli) main(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
