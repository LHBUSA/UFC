#!/usr/bin/env node
// The backfill's closing report: structural coverage, round-stat coverage,
// the named historical canaries, and Hall of Fame link resolution.
//
// The two coverage numbers are deliberately separate. Structural coverage
// asks whether the fight exists at all; round-stat coverage asks how deep a
// bout we already hold is. A single blended percentage hides whichever hole
// is larger, which is exactly how 384 events with zero bouts stayed invisible
// behind a "40.7% covered" headline.
//
// Canary before/after is derived, not remembered. At the start of this work
// no event before 2017 had a single bout, so a subject's pre-2017 count was
// zero by definition and its 2017-onward count is untouched by the historical
// lane. "Before" is therefore the 2017-onward figure and "after" is the total,
// computed the same way whenever this runs. Nothing is hand-entered.
//
//   node scripts/backfill/report.mjs [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
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

/* The boundary between "already loaded before this work" and "loaded by the
 * historical lane". Every event before it had zero bouts at the start. */
const ERA = '2017-01-01';

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

const CANARIES = ['John McCarthy', 'Royce Gracie', 'Randy Couture', 'Chuck Liddell', 'Ronda Rousey', 'Daniel Cormier', 'BJ Penn', 'Urijah Faber', 'Michael Bisping'];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const main = async () => {
  const [events, bouts, results, statRows, fighters] = await Promise.all([
    all('ufc_events?select=id,name,event_date'),
    all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,status'),
    all('ufc_bout_results?select=bout_id,method,round,referee'),
    all('ufc_bout_round_stats?select=bout_id'),
    all('ufc_fighters?select=id,name'),
  ]);

  const evById = new Map(events.map((e) => [e.id, e]));
  const dateOf = (boutId) => { const b = boutById.get(boutId); return b ? evById.get(b.event_id)?.event_date || null : null; };
  const boutById = new Map(bouts.map((b) => [b.id, b]));
  const resultByBout = new Map(results.map((r) => [r.bout_id, r]));
  const statBouts = new Set(statRows.map((s) => s.bout_id));

  /* ---------------- structural ---------------- */
  const era = (d) => (d && d >= ERA ? 'modern' : 'historical');
  const S = { historical: { events: 0, bouts: 0, results: 0, referees: 0, fighters: new Set() }, modern: { events: 0, bouts: 0, results: 0, referees: 0, fighters: new Set() } };
  for (const e of events) S[era(e.event_date)].events += 1;
  for (const b of bouts) {
    const k = era(evById.get(b.event_id)?.event_date);
    S[k].bouts += 1;
    if (b.fighter_a_id) S[k].fighters.add(b.fighter_a_id);
    if (b.fighter_b_id) S[k].fighters.add(b.fighter_b_id);
  }
  for (const r of results) {
    const k = era(dateOf(r.bout_id));
    S[k].results += 1;
    if (r.referee) S[k].referees += 1;
  }

  const line = (l, v) => console.log(`  ${l.padEnd(26)} ${String(v).padStart(8)}`);
  console.log('\n================ STRUCTURAL COVERAGE ================');
  console.log('the canonical fight graph: does the fight exist at all\n');
  console.log(`                            historical    modern     total`);
  const row = (l, a, b) => console.log(`  ${l.padEnd(24)} ${String(a).padStart(10)} ${String(b).padStart(9)} ${String(a + b).padStart(9)}`);
  row('events', S.historical.events, S.modern.events);
  row('bouts', S.historical.bouts, S.modern.bouts);
  row('results', S.historical.results, S.modern.results);
  row('referee assignments', S.historical.referees, S.modern.referees);
  row('distinct fighters', S.historical.fighters.size, S.modern.fighters.size);
  console.log(`\n  fighters on record (all)   ${fighters.length}`);
  console.log(`  historical = events before ${ERA}, which held zero bouts before this backfill`);

  /* ---------------- round-stat ---------------- */
  const completed = bouts.filter((b) => resultByBout.has(b.id) && b.status !== 'cancelled');
  const covered = completed.filter((b) => statBouts.has(b.id));
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  console.log('\n================ ROUND-STAT COVERAGE ================');
  console.log('how deep a bout we already hold is\n');
  line('completed bouts', completed.length);
  line('stat-covered bouts', covered.length);
  line('coverage', pct(covered.length, completed.length));
  line('round-stat rows', statRows.length);

  const byYear = new Map();
  for (const b of completed) {
    const y = evById.get(b.event_id)?.event_date?.slice(0, 4) || 'n/a';
    let v = byYear.get(y);
    if (!v) { v = { completed: 0, covered: 0 }; byYear.set(y, v); }
    v.completed += 1;
    if (statBouts.has(b.id)) v.covered += 1;
  }
  console.log('\n  year   completed  covered  coverage');
  for (const y of [...byYear.keys()].sort()) {
    const v = byYear.get(y);
    console.log(`  ${y.padEnd(6)} ${String(v.completed).padStart(9)} ${String(v.covered).padStart(8)}  ${pct(v.covered, v.completed)}`);
  }

  /* ---------------- canaries ---------------- */
  const fighterByNorm = new Map();
  for (const f of fighters) {
    const k = norm(f.name);
    if (!fighterByNorm.has(k)) fighterByNorm.set(k, []);
    fighterByNorm.get(k).push(f);
  }
  const refCounts = new Map();
  for (const r of results) {
    if (!r.referee) continue;
    const d = dateOf(r.bout_id);
    let v = refCounts.get(r.referee.trim());
    if (!v) { v = { modern: 0, historical: 0 }; refCounts.set(r.referee.trim(), v); }
    v[era(d)] += 1;
  }
  const fighterCounts = new Map();
  for (const b of bouts) {
    const k = era(evById.get(b.event_id)?.event_date);
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      if (!fid) continue;
      let v = fighterCounts.get(fid);
      if (!v) { v = { modern: 0, historical: 0 }; fighterCounts.set(fid, v); }
      v[k] += 1;
    }
  }

  console.log('\n================ HISTORICAL CANARIES ================');
  console.log('before = bouts/assignments on events from 2017 onward, which the');
  console.log('historical lane does not touch. after = total now held.\n');
  console.log('  subject                    kind       before   after    added');
  const canaryRows = [];
  for (const name of CANARIES) {
    const ref = refCounts.get(name);
    if (ref) {
      const before = ref.modern, after = ref.modern + ref.historical;
      canaryRows.push({ subject: name, kind: 'referee', before, after, added: after - before });
      console.log(`  ${name.padEnd(26)} ${'referee'.padEnd(10)} ${String(before).padStart(6)} ${String(after).padStart(7)} ${String(after - before).padStart(8)}`);
      continue;
    }
    const hits = fighterByNorm.get(norm(name)) || [];
    if (!hits.length) {
      canaryRows.push({ subject: name, kind: 'fighter', before: null, after: null, added: null, note: 'no canonical fighter row yet' });
      console.log(`  ${name.padEnd(26)} ${'fighter'.padEnd(10)} ${'—'.padStart(6)} ${'—'.padStart(7)} ${'—'.padStart(8)}   not yet on record`);
      continue;
    }
    let before = 0, after = 0;
    for (const f of hits) {
      const v = fighterCounts.get(f.id) || { modern: 0, historical: 0 };
      before += v.modern; after += v.modern + v.historical;
    }
    const dup = hits.length > 1 ? `  ${hits.length} rows share this name` : '';
    canaryRows.push({ subject: name, kind: 'fighter', before, after, added: after - before, rows: hits.length });
    console.log(`  ${name.padEnd(26)} ${'fighter'.padEnd(10)} ${String(before).padStart(6)} ${String(after).padStart(7)} ${String(after - before).padStart(8)}${dup}`);
  }

  /* ---------------- hall of fame ---------------- */
  console.log('\n================ HALL OF FAME LINKS ================');
  const mapPath = path.join(ROOT, 'data', 'hall-of-fame', '_fighter-map.json');
  let hof = { linked: 0, unresolved: 0, names: [] };
  if (fs.existsSync(mapPath)) {
    const m = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const linked = Object.keys(m.linked || {});
    const cand = m.backfill_candidates || {};
    const unresolvedNames = Array.isArray(cand) ? cand : Object.values(cand);
    hof = { linked: linked.length, unresolved: unresolvedNames.length, names: unresolvedNames.map((c) => (typeof c === 'string' ? c : c.name || c.slug)).filter(Boolean) };
    line('linked to a fighter row', hof.linked);
    line('unresolved', hof.unresolved);
    if (hof.names.length) console.log(`\n  unresolved: ${hof.names.slice(0, 40).join(', ')}${hof.names.length > 40 ? ' …' : ''}`);
    console.log('\n  Unresolved means no unambiguous canonical fighter exists yet.');
    console.log('  A duplicate row created to satisfy a link would be worse than the gap.');
  } else {
    console.log('  no fighter map yet — run scripts/hof/resolve-fighters.mjs');
  }

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({
      generated_at: new Date().toISOString(), era_boundary: ERA,
      structural: {
        historical: { ...S.historical, fighters: S.historical.fighters.size },
        modern: { ...S.modern, fighters: S.modern.fighters.size },
        fighters_total: fighters.length,
      },
      round_stat: { completed: completed.length, covered: covered.length, rows: statRows.length, by_year: Object.fromEntries([...byYear.entries()].sort()) },
      canaries: canaryRows,
      hall_of_fame: hof,
    }, null, 2) + '\n');
    console.log(`\njson -> ${opt('--json')}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
