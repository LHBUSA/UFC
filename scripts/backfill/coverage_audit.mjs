#!/usr/bin/env node
// Round-stat coverage audit. Read-only: counts what the canonical tables hold
// today so a backfill can be prioritised by product value rather than by year.
//
//   node scripts/backfill/coverage_audit.mjs [--json out.json] [--year 2024]
//
// Reports, overall and per year:
//   completed bouts (a bout with a stored result)
//   bouts with >= 1 round-stat row      -> "stat-covered"
//   bouts whose round rows look complete for both corners
//   coverage %
// plus a split by event class (PPV / Fight Night / DWCS / other) and a
// priority queue of currently relevant fighters with the weakest coverage.
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
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function count(pathq) {
  const r = await fetch(`${URL_}/rest/v1/${pathq}${pathq.includes('?') ? '&' : '?'}select=*&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
  const cr = r.headers.get('content-range') || '/0';
  return Number(cr.split('/')[1]) || 0;
}
/* Paged reader: PostgREST caps rows per response, so walk with range headers. */
async function all(pathq, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) throw new Error(`${pathq.split('?')[0]} -> ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const eventClass = (name) => {
  const n = String(name || '');
  if (/contender series|road to ufc/i.test(n)) return 'DWCS';
  if (/ultimate fighter|TUF/i.test(n)) return 'TUF';
  if (/^UFC \d+/i.test(n)) return 'PPV';
  if (/fight night|UFC on |UFC Live|Noche UFC/i.test(n)) return 'Fight Night';
  return 'Other';
};

const main = async () => {
  console.log('reading canonical tables…');
  const [events, bouts, results, statRows] = await Promise.all([
    all('ufc_events?select=id,name,event_date,card_status&order=event_date.asc'),
    all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,status'),
    all('ufc_bout_results?select=bout_id,method,round,winner_id,has_stats'),
    all('ufc_bout_round_stats?select=bout_id,fighter_id,round'),
  ]);

  const eventById = new Map(events.map((e) => [e.id, e]));
  const resultByBout = new Map(results.map((r) => [r.bout_id, r]));
  /* rounds per bout, and distinct corners seen, to judge completeness */
  const statsByBout = new Map();
  for (const s of statRows) {
    let v = statsByBout.get(s.bout_id);
    if (!v) { v = { rounds: new Set(), fighters: new Set(), rows: 0 }; statsByBout.set(s.bout_id, v); }
    v.rounds.add(s.round); v.fighters.add(s.fighter_id); v.rows += 1;
  }

  const completed = bouts.filter((b) => resultByBout.has(b.id) && b.status !== 'cancelled');
  const byYear = new Map();
  const byClass = new Map();
  const fighterCov = new Map();

  for (const b of completed) {
    const e = eventById.get(b.event_id);
    const year = e?.event_date ? Number(e.event_date.slice(0, 4)) : 0;
    const cls = eventClass(e?.name);
    const st = statsByBout.get(b.id);
    const res = resultByBout.get(b.id);
    /* Expected rounds: a finish ends at the finishing round; a decision runs
     * the scheduled distance. Complete = both corners present for each. */
    const expected = res?.round || b.scheduled_rounds || 3;
    const covered = Boolean(st);
    const complete = Boolean(st && st.fighters.size >= 2 && st.rounds.size >= expected);

    for (const [map, key] of [[byYear, year], [byClass, cls]]) {
      let v = map.get(key);
      if (!v) { v = { completed: 0, covered: 0, complete: 0 }; map.set(key, v); }
      v.completed += 1; if (covered) v.covered += 1; if (complete) v.complete += 1;
    }
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      if (!fid) continue;
      let v = fighterCov.get(fid);
      if (!v) { v = { completed: 0, covered: 0 }; fighterCov.set(fid, v); }
      v.completed += 1; if (covered) v.covered += 1;
    }
  }

  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const totalCovered = completed.filter((b) => statsByBout.has(b.id)).length;
  const totalComplete = completed.filter((b) => { const st = statsByBout.get(b.id); const res = resultByBout.get(b.id); const exp = res?.round || b.scheduled_rounds || 3; return st && st.fighters.size >= 2 && st.rounds.size >= exp; }).length;

  console.log('\n=== TABLE COUNTS ===');
  console.log(`ufc_events            ${events.length}`);
  console.log(`ufc_bouts             ${bouts.length}`);
  console.log(`ufc_bout_results      ${results.length}`);
  console.log(`ufc_bout_round_stats  ${statRows.length} rows across ${statsByBout.size} bouts`);
  console.log('\n=== ROUND-STAT COVERAGE ===');
  console.log(`completed bouts            ${completed.length}`);
  console.log(`stat-covered (>=1 row)     ${totalCovered}  ${pct(totalCovered, completed.length)}`);
  console.log(`complete (both corners)    ${totalComplete}  ${pct(totalComplete, completed.length)}`);

  console.log('\n=== BY YEAR ===');
  console.log('year   completed  covered  complete  coverage');
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const v = byYear.get(y);
    console.log(`${String(y || 'n/a').padEnd(6)} ${String(v.completed).padStart(9)} ${String(v.covered).padStart(8)} ${String(v.complete).padStart(9)}  ${pct(v.covered, v.completed)}`);
  }
  console.log('\n=== BY EVENT CLASS ===');
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1].completed - a[1].completed)) {
    console.log(`${k.padEnd(12)} completed ${String(v.completed).padStart(5)}  covered ${String(v.covered).padStart(5)}  ${pct(v.covered, v.completed)}`);
  }

  /* Fighters with the weakest coverage, weighted toward current relevance:
   * ranked / champion / booked on an upcoming card. */
  const [ranked, upcoming] = await Promise.all([
    all('ufc_rankings_snapshots?select=divisions&order=snapshot_date.desc&limit=1').catch(() => []),
    all(`ufc_bouts?select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${new Date().toISOString().slice(0, 10)}`).catch(() => []),
  ]);
  const priority = new Set();
  for (const d of ranked[0]?.divisions || []) {
    if (d.champion?.fighter_id) priority.add(d.champion.fighter_id);
    for (const e of d.entries || []) if (e.fighter_id) priority.add(e.fighter_id);
  }
  for (const b of upcoming) { if (b.fighter_a_id) priority.add(b.fighter_a_id); if (b.fighter_b_id) priority.add(b.fighter_b_id); }
  const names = new Map((await all(`ufc_fighters?select=id,name`)).map((f) => [f.id, f.name]));

  const queue = [...fighterCov.entries()]
    .map(([id, v]) => ({ id, name: names.get(id) || id, completed: v.completed, covered: v.covered, missing: v.completed - v.covered, priority: priority.has(id) }))
    .filter((f) => f.missing > 0)
    .map((f) => ({ ...f, score: f.missing * (f.priority ? 10 : 1) }))
    .sort((a, b) => b.score - a.score);

  console.log('\n=== FIGHTER COVERAGE ===');
  const dist = (n) => fighterCov.size ? [...fighterCov.values()].filter((v) => v.covered >= n).length : 0;
  console.log(`fighters with completed bouts ${fighterCov.size}`);
  console.log(`  0 stat-covered bouts  ${[...fighterCov.values()].filter((v) => v.covered === 0).length}`);
  for (const n of [1, 2, 3, 5]) console.log(`  ${n}+ stat-covered bouts ${dist(n)}`);
  console.log('\ntop 25 backfill priorities (current-relevance weighted):');
  console.log('fighter                        completed  covered  missing  priority');
  for (const f of queue.slice(0, 25)) console.log(`${f.name.slice(0, 30).padEnd(30)} ${String(f.completed).padStart(9)} ${String(f.covered).padStart(8)} ${String(f.missing).padStart(8)}  ${f.priority ? 'CURRENT' : ''}`);

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      totals: { events: events.length, bouts: bouts.length, results: results.length, round_stat_rows: statRows.length, completed: completed.length, covered: totalCovered, complete: totalComplete },
      by_year: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
      by_class: Object.fromEntries(byClass),
      fighters: { total: fighterCov.size, zero: [...fighterCov.values()].filter((v) => v.covered === 0).length, one_plus: dist(1), two_plus: dist(2), three_plus: dist(3), five_plus: dist(5) },
      queue: queue.slice(0, 200),
    }, null, 2) + '\n');
    console.log(`\njson -> ${opt('--json')}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
