#!/usr/bin/env node
/**
 * Measure, per year, whether our fight records are complete enough for an
 * absence in them to mean anything.
 *
 *   node scripts/tuf/record_completeness.mjs [--write]
 *
 * This exists to supply the second half of an argument the archive was making
 * with only the first half.
 *
 * A TUF bout was being called an exhibition because it aired in a numbered
 * episode. That is not what an episode number proves. It proves when the bout
 * was broadcast; it says nothing about whether the bout was also contested on
 * a sanctioned card. The classification needs a second fact: that no such
 * professional bout exists.
 *
 * Absence normally proves nothing, and this codebase has been careful to say
 * so while the historical backfill was still running — a bout missing from a
 * half-loaded table is missing from the loading, not from history. That
 * changed when the backfill finished. For a year in which every event carries
 * bouts and every bout carries a result, a professional bout that happened
 * would be there. Its absence is then a finding rather than a search result.
 *
 * So this measures completeness per year and writes it down with its date, and
 * the importer cites it. A year that fails the test does not get the argument
 * made on its behalf: its bouts stay unverified.
 *
 * Read-only against the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'web', 'data', 'tuf', 'record_completeness.json');

const KNOWN_FLAGS = new Set(['--write']);
{
  const unknown = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}`);
    console.error(`supported: ${[...KNOWN_FLAGS].join(', ')}`);
    process.exit(2);
  }
}
const WRITE = process.argv.includes('--write');

for (const f of ['.env', '.env.local', path.join('web', '.env.local')]) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.trimStart().startsWith('#')) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }

const rest = async (q) => {
  const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`supabase ${r.status} on ${q.split('?')[0]}`);
  return r.json();
};

const FIRST = 2005;   // the first TUF season
const LAST = new Date().getUTCFullYear();

const main = async () => {
  const years = {};
  for (let y = FIRST; y <= LAST; y += 1) {
    const events = await rest(`ufc_events?select=id&event_date=gte.${y}-01-01&event_date=lte.${y}-12-31`);
    let eventsWithoutBouts = 0;
    let bouts = 0;
    let withResult = 0;
    for (const e of events) {
      const rows = await rest(`ufc_bouts?select=id,ufc_bout_results(method_raw)&event_id=eq.${e.id}`);
      if (!rows.length) { eventsWithoutBouts += 1; continue; }
      bouts += rows.length;
      withResult += rows.filter((x) => {
        const r = x.ufc_bout_results;
        return r && (Array.isArray(r) ? r.length : 1);
      }).length;
    }
    const complete = events.length > 0 && eventsWithoutBouts === 0 && bouts > 0 && bouts === withResult;
    years[y] = { events: events.length, events_without_bouts: eventsWithoutBouts, bouts, bouts_with_result: withResult, complete };
    console.log(
      `${y}  events ${String(events.length).padStart(3)}  without bouts ${eventsWithoutBouts}  ` +
      `bouts ${String(bouts).padStart(4)}  with result ${String(withResult).padStart(4)}  ${complete ? 'COMPLETE' : 'incomplete'}`,
    );
  }

  const complete = Object.entries(years).filter(([, v]) => v.complete).map(([y]) => Number(y));
  console.log(`\ncomplete years: ${complete.length} of ${Object.keys(years).length}`);

  const payload = {
    _note: 'Per-year completeness of our own fight records, used to decide whether a bout\'s ABSENCE from them carries any weight. A year counts as complete only when every event in it holds bouts and every one of those bouts holds a result. For such a year, a professional bout that happened would be in our records, so a TUF bout that is not there was not contested on a sanctioned card that year. For any other year the argument is not available and the bouts stay unverified.',
    _method: 'For each year: every ufc_events row in range, then every ufc_bouts row on those events, then whether each carries a ufc_bout_results row. No sampling.',
    _generated_at: new Date().toISOString(),
    _generated_by: 'scripts/tuf/record_completeness.mjs',
    years,
  };

  if (!WRITE) { console.log(`\n(dry run — pass --write to save ${path.relative(ROOT, OUT)})`); return; }
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
