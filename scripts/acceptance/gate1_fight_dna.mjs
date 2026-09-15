// Gate 1: Fight DNA natural build. READ-ONLY.
//
//   node scripts/acceptance/gate1_fight_dna.mjs baseline <out.json>
//   node scripts/acceptance/gate1_fight_dna.mjs check <baseline.json> [after-out.json] [--as-of 2026-09-16]
//
// Per-row content hash of every ufc_fighter_bout_features row (feature_version 1),
// over the columns below in this exact order (generated_at and provenance are
// excluded: they change on every rebuild without changing content). The committed
// baseline docs/acceptance/data/dna-baseline-2026-09-15.json was captured
// 2026-09-15T11:49:03Z with this procedure: 18,720 rows, 0 out-of-scope, set sha256
// 7c2486740bcf002ccb6b01c568f3fe0c742b369b7ef19a6ba671fb4b220ae0e1.
//
// Two separate verdicts, never mixed:
//   ROAD TO UFC SCOPE        out-of-scope rows 0; baseline rows removed 0 and changed 0
//   FIGHT DNA BUILD LIFECYCLE  build rows closed normally; snapshots written == expected

import fs from 'node:fs';
import { get, count, inChunks, sha256, print } from './lib.mjs';

const COLS = 'fighter_id,bout_id,event_id,opponent_id,event_date,fighter_stance,opponent_stance,stance_context,outcome,method,scheduled_rounds,is_title,is_main_event,short_notice_days,round_rows,observed_seconds,stats_coverage,raw_stats,features';

async function snapshotOfFeatureRows() {
  const rows = [];
  for (let after = ''; ;) {
    const page = await get(`ufc_fighter_bout_features?select=${COLS}&feature_version=eq.1&order=fighter_id.asc,bout_id.asc&limit=1000${after}`);
    rows.push(...page);
    if (page.length < 1000) break;
    const last = page[page.length - 1];
    after = `&or=(fighter_id.gt.${last.fighter_id},and(fighter_id.eq.${last.fighter_id},bout_id.gt.${last.bout_id}))`;
  }
  const map = Object.fromEntries(rows.map((x) => [`${x.fighter_id}|${x.bout_id}`, sha256(JSON.stringify(x)).slice(0, 24)]));
  const scope = new Map((await inChunks('ufc_bouts', 'id', [...new Set(rows.map((x) => x.bout_id))], 'id,model_scope', '', 150)).map((b) => [b.id, b.model_scope]));
  return {
    at: new Date().toISOString(),
    rows: rows.length,
    out_of_scope_rows: rows.filter((x) => scope.get(x.bout_id) === false).length,
    set_sha256: sha256(Object.keys(map).sort().map((k) => `${k}:${map[k]}`).join('\n')),
    map,
    fighters_with_rows: new Set(rows.map((x) => x.fighter_id)).size,
  };
}

const [mode, a, b, ...rest] = process.argv.slice(2);
if (mode === 'baseline') {
  const snap = await snapshotOfFeatureRows();
  fs.writeFileSync(a, JSON.stringify(snap));
  const { map: _m, ...summary } = snap;
  print(summary);
} else if (mode === 'check') {
  const base = JSON.parse(fs.readFileSync(a, 'utf8'));
  const asOfIdx = rest.indexOf('--as-of');
  const asOf = asOfIdx >= 0 ? rest[asOfIdx + 1] : new Date().toISOString().slice(0, 10);
  const after = await snapshotOfFeatureRows();
  if (b) fs.writeFileSync(b, JSON.stringify(after));
  const removed = Object.keys(base.map).filter((k) => !(k in after.map));
  const changed = Object.keys(base.map).filter((k) => k in after.map && after.map[k] !== base.map[k]);
  const added = Object.keys(after.map).filter((k) => !(k in base.map));
  const addedBouts = [...new Set(added.map((k) => k.split('|')[1]))];
  const addedScope = addedBouts.length ? await inChunks('ufc_bouts', 'id', addedBouts, 'id,model_scope,ufc_events(name,event_date,event_series)') : [];
  const scopePass = after.out_of_scope_rows === 0 && removed.length === 0 && changed.length === 0 && addedScope.every((x) => x.model_scope === true);

  const builds = await get(`ufc_dna_build_runs?select=id,mode,started_at,finished_at,status,as_of_date,input_counts,errors&started_at=gt.${base.at}&order=started_at.asc`);
  const full = builds.filter((r) => r.mode === 'full' && r.as_of_date === asOf);
  const written = await count('ufc_fighter_dna_snapshots', `&as_of_date=eq.${asOf}&definition_version=eq.1`);
  const expected = after.fighters_with_rows;   // the builder writes one snapshot per fighter with >= 1 feature row
  const lifecyclePass = full.length > 0 && full.every((r) => r.status === 'success' && r.finished_at) && written === expected;

  print({
    ROAD_TO_UFC_SCOPE: scopePass ? 'PASS' : 'FAIL',
    scope: {
      baseline_at: base.at, baseline_rows: base.rows, baseline_set_sha256: base.set_sha256, baseline_out_of_scope_rows: base.out_of_scope_rows,
      after_at: after.at, after_rows: after.rows, after_set_sha256: after.set_sha256, after_out_of_scope_rows: after.out_of_scope_rows,
      removed: removed.length, changed: changed.length, changed_sample: changed.slice(0, 20),
      added: added.length, added_bouts: addedScope.map((x) => ({ bout_id: x.id, model_scope: x.model_scope, event: x.ufc_events?.name, date: x.ufc_events?.event_date, series: x.ufc_events?.event_series })),
    },
    FIGHT_DNA_BUILD_LIFECYCLE: lifecyclePass ? 'PASS' : 'FAIL — PRE-EXISTING DEFECT (if the full build did not close / wrote fewer snapshots; see doc baseline)',
    lifecycle: { as_of_date: asOf, full_builds_for_as_of: full.length, snapshots_expected: expected, snapshots_written: written, build_runs_since_baseline: builds },
  });
} else {
  console.error('usage: baseline <out.json> | check <baseline.json> [after-out.json] [--as-of YYYY-MM-DD]');
  process.exit(2);
}
