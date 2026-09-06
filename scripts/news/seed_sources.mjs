#!/usr/bin/env node
/* Seed ufc_news_sources. Idempotent: upserts on (kind, name).
 *
 * Every RSS candidate URL is fetched and parsed before it is written; a
 * source whose feed does not return at least one item is not seeded (and is
 * disabled if an earlier run had seeded it). One `internal` source,
 * propbetedge-tables, represents stories generated from our own tables.
 *
 *   node scripts/news/seed_sources.mjs [--dry-run]
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

async function verify(url) {
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sb = new Supabase();
  const rows = [INTERNAL_SOURCE];
  const dropped = [];

  for (const src of RSS_SOURCES) {
    let chosen = null;
    for (const url of src.urls) {
      const v = await verify(url);
      console.log(`${v.ok ? 'ok  ' : 'fail'} ${src.name} ${url} -> ${v.ok ? `${v.items} items` : v.reason}`);
      if (v.ok) { chosen = url; break; }
    }
    if (chosen) rows.push({ kind: 'rss', name: src.name, url: chosen, weight: src.weight, enabled: true });
    else dropped.push(src.name);
  }

  console.log(`\nseeding ${rows.length} sources${dropped.length ? `; dropped: ${dropped.join(', ')}` : ''}`);
  if (dryRun) { console.log(JSON.stringify(rows, null, 2)); return; }

  const written = await sb.upsert('ufc_news_sources', rows, 'kind,name');
  for (const r of written) console.log(`  ${r.kind.padEnd(8)} ${r.name.padEnd(20)} weight=${r.weight} enabled=${r.enabled} ${r.url || ''}`);

  /* A previously seeded source whose feed no longer verifies gets switched off, not deleted. */
  for (const name of dropped) {
    const off = await sb.patch('ufc_news_sources', `kind=eq.rss&name=eq.${encodeURIComponent(name)}&enabled=is.true`, { enabled: false });
    if (off.length) console.log(`  disabled ${name} (feed no longer verifies)`);
  }
  const all = await sb.select('ufc_news_sources', 'select=id,kind,name,enabled');
  console.log(`\nufc_news_sources: ${all.length} rows, ${all.filter((s) => s.enabled).length} enabled`);
}

main().catch((e) => { console.error(e); process.exit(1); });
