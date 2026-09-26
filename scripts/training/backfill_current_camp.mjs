#!/usr/bin/env node
// Backfill current camp for the active UFC roster (migration 032, owner decision 2026-09-26).
//
//   node scripts/training/backfill_current_camp.mjs            # read ESPN + write through the SQL function
//   node scripts/training/backfill_current_camp.mjs --dry      # read ESPN only, write nothing, report coverage
//   node scripts/training/backfill_current_camp.mjs --out file.json
//
// Roster = a UFC-series bout in the last 18 months OR a booked UFC-series bout (effective card truth,
// migration 031), the same rule the ingest's daily camp sweep uses (workers/ufc-stats-ingest/src/training.mjs).
// Fighter identity is ufc_fighters.espn_athlete_id: no name matching anywhere. Only association.id and
// association.name are read; association.location is never used. Idempotent: a re-run only re-stamps.
import fs from 'node:fs';
import { get, getAll, rpc } from './lib.mjs';
import { activeRoster } from '../../workers/ufc-stats-ingest/src/training.mjs';
import { Espn } from '../../workers/ufc-stats-ingest/src/espn.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const today = new Date().toISOString().slice(0, 10);

const [events, bouts, results, fighters] = await Promise.all([
  getAll('ufc_events', 'id,event_date,event_series'),
  getAll('ufc_bouts_effective', 'id,event_id,fighter_a_id,fighter_b_id,is_active'),
  getAll('ufc_bout_results', 'bout_id', 'bout_id'),
  getAll('ufc_fighters', 'id,name,espn_athlete_id'),
]);
const roster = activeRoster({
  bouts: bouts.map((b) => ({ ...b, status: b.is_active === false ? 'cancelled' : 'active' })),
  events,
  resultsByBout: new Set(results.map((r) => r.bout_id)),
  today,
});
const byId = new Map(fighters.map((f) => [f.id, f]));
const linked = [...roster.keys()].map((id) => byId.get(id)).filter((f) => f?.espn_athlete_id);

const espn = new Espn({ minIntervalMs: 250 });
const report = {
  at: new Date().toISOString(), dry: DRY, today,
  eligible: roster.size, booked: [...roster.values()].filter((r) => r.booked_on).length,
  espn_linked: linked.length, association_present: 0, association_absent: 0, fetch_failed: 0,
  actions: {}, distinct_association_ids: 0, absent_sample: [], failed_sample: [], changed: [],
};
const assocIds = new Set();
let i = 0;
for (const f of linked) {
  i += 1;
  let a;
  try {
    a = await espn.athlete(String(f.espn_athlete_id), { records: false });
  } catch (e) {
    report.fetch_failed += 1;
    if (report.failed_sample.length < 15) report.failed_sample.push({ id: f.id, name: f.name, error: String(e?.message || e).slice(0, 120) });
    continue;
  }
  if (String(a.espn_athlete_id) !== String(f.espn_athlete_id)) { report.fetch_failed += 1; continue; }
  if (a.association) { report.association_present += 1; assocIds.add(a.association.id); }
  else { report.association_absent += 1; if (report.absent_sample.length < 40) report.absent_sample.push({ id: f.id, name: f.name, espn: f.espn_athlete_id }); }
  if (!DRY) {
    const r = await rpc('ufc_training_record_association', {
      p_fighter_id: f.id, p_espn_athlete_id: String(f.espn_athlete_id),
      p_association_id: a.association?.id ?? null, p_association_name: a.association?.name ?? null,
      p_source_url: a.source_url, p_captured_at: new Date().toISOString(),
    });
    report.actions[r.action] = (report.actions[r.action] || 0) + 1;
    if (r.action === 'changed') report.changed.push({ id: f.id, name: f.name, to: a.association?.name });
  }
  if (i % 50 === 0) console.error(`${i}/${linked.length} read`);
}
report.distinct_association_ids = assocIds.size;
if (!DRY) {
  report.db = {
    camps: (await get('ufc_training_camps?select=id')).length,
    fighters_with_current_camp: (await getAll('ufc_fighter_training_current', 'fighter_id', 'fighter_id', '&current_camp=not.is.null')).length,
  };
}
report.current_camp_coverage = `${report.association_present}/${report.eligible} (${(100 * report.association_present / Math.max(1, report.eligible)).toFixed(1)}%)`;
const text = JSON.stringify(report, null, 2);
if (OUT) fs.writeFileSync(OUT, text);
console.log(text);
