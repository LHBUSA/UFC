#!/usr/bin/env node
// Structural (historical breadth) coverage audit, 1994 onward.
//
// Round-stat coverage answers "how deep is a bout we already hold". This
// answers the different question the 2026 audit exposed: how much of the
// canonical fight graph exists at all. An event row with no bout rows is not
// a shallow bout — it is a missing fight, result, fighter and referee record.
//
// Per year it reports events, how many carry a UFC Stats id, how many have a
// Wayback event capture (read from the backfill's own cached index, so this
// costs no network), and how many have bouts / results / referee assignments.
//
//   node scripts/backfill/structural_audit.mjs [--json out.json] [--from 1994] [--to 2016]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, accept: 'application/json' };
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FROM = Number(opt('--from', '1994')), TO = Number(opt('--to', '2026'));

async function all(q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) throw new Error(`${q.split('?')[0]} -> ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const main = async () => {
  const idxPath = path.join(ROOT, 'scripts', 'backfill', 'cache', '_wayback_index', 'events.json');
  const captured = fs.existsSync(idxPath) ? new Set(Object.keys(JSON.parse(fs.readFileSync(idxPath, 'utf8')))) : null;
  if (!captured) console.warn('note: no cached Wayback events index yet — capture columns will read as unknown');

  const [events, bouts, results] = await Promise.all([
    all('ufc_events?select=id,name,event_date,ufcstats_id,card_status&order=event_date.asc'),
    all('ufc_bouts?select=id,event_id'),
    all('ufc_bout_results?select=bout_id,referee'),
  ]);
  const boutsByEvent = new Map();
  for (const b of bouts) boutsByEvent.set(b.event_id, (boutsByEvent.get(b.event_id) || 0) + 1);
  const boutEvent = new Map(bouts.map((b) => [b.id, b.event_id]));
  const resByEvent = new Map(), refByEvent = new Map();
  for (const r of results) {
    const ev = boutEvent.get(r.bout_id);
    if (!ev) continue;
    resByEvent.set(ev, (resByEvent.get(ev) || 0) + 1);
    if (r.referee) refByEvent.set(ev, (refByEvent.get(ev) || 0) + 1);
  }

  const rows = new Map();
  for (const e of events) {
    const y = e.event_date ? Number(e.event_date.slice(0, 4)) : 0;
    if (y < FROM || y > TO) continue;
    let v = rows.get(y);
    if (!v) { v = { events: 0, withId: 0, captured: 0, withBouts: 0, withResults: 0, withReferee: 0, bouts: 0, results: 0, referees: 0, complete: 0 }; rows.set(y, v); }
    v.events += 1;
    if (e.ufcstats_id) { v.withId += 1; if (captured?.has(e.ufcstats_id)) v.captured += 1; }
    if (e.card_status === 'complete') v.complete += 1;
    const nb = boutsByEvent.get(e.id) || 0, nr = resByEvent.get(e.id) || 0, nref = refByEvent.get(e.id) || 0;
    v.bouts += nb; v.results += nr; v.referees += nref;
    if (nb > 0) v.withBouts += 1;
    if (nr > 0) v.withResults += 1;
    if (nref > 0) v.withReferee += 1;
  }

  console.log('\n=== STRUCTURAL COVERAGE (canonical fight graph) ===');
  console.log('year  events  ufcstats_id  wb_capture  ev_with_bouts  bouts  results  referee_rows');
  let tEvents = 0, tNoBouts = 0, tCaptured = 0;
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const v = rows.get(y);
    tEvents += v.events; tNoBouts += v.events - v.withBouts; tCaptured += v.captured;
    console.log(`${String(y).padEnd(5)} ${String(v.events).padStart(6)} ${String(v.withId).padStart(12)} ${String(v.captured).padStart(11)} ${String(v.withBouts).padStart(14)} ${String(v.bouts).padStart(6)} ${String(v.results).padStart(8)} ${String(v.referees).padStart(13)}`);
  }
  console.log(`\nevents in range ${tEvents} · events with NO bout rows ${tNoBouts} · of those, Wayback-captured ${tCaptured}`);
  console.log('An event with a UFC Stats id and a Wayback capture but zero bout rows is directly backfillable:');
  console.log('  event -> bouts -> fighter identity -> results -> referee -> round stats.');

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({ generated_at: new Date().toISOString(), from: FROM, to: TO, by_year: Object.fromEntries([...rows.entries()].sort((a, b) => a[0] - b[0])), totals: { events: tEvents, events_without_bouts: tNoBouts } }, null, 2) + '\n');
    console.log(`json -> ${opt('--json')}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
