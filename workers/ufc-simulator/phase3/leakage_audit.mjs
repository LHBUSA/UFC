// Leakage audit for the Phase 3 cohort. Every check is a hard assertion over
// every cohort bout; any failure exits non-zero.
import fs from 'node:fs';
import path from 'node:path';
import { buildCohort, boutInput, loadTables, CACHE } from './dataset.mjs';
import { validateSnapshotAsOf } from '../src/engine/inputs.mjs';
import { canonicalJson } from '../src/engine/canonical.mjs';

const { cohort } = buildCohort();
const T = loadTables();
const fail = {};
const bump = (k) => { fail[k] = (fail[k] || 0) + 1; };
let checked = 0, fallbackCorners = 0, closestGapDays = Infinity, minAsOfGap = Infinity;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

for (const c of cohort) {
  const D = c.event_date;
  const input = boutInput(c);
  for (const side of ['fighter_a', 'fighter_b']) {
    const inp = input[side];
    const s = inp.snapshot;
    if (!s) { bump('missing_snapshot'); continue; }
    if (!(s.as_of_date <= D)) bump('snapshot_after_event');
    minAsOfGap = Math.min(minAsOfGap, dayDiff(s.as_of_date, D));
    const v = validateSnapshotAsOf(s, inp.bout_dates);
    if (!v.ok) bump('snapshot_contains_bout_on_or_after_as_of');
    if (v.unverified.length) bump('snapshot_bout_unverified');
    for (const bid of s.provenance?.bouts || []) {
      if (bid === c.bout_id) bump('target_bout_in_snapshot');
      const d = T.boutDate.get(bid);
      if (d && d >= D) bump('future_bout_in_snapshot');
      if (d) closestGapDays = Math.min(closestGapDays, dayDiff(d, D));
    }
    for (const row of inp.ladder) { if (row.event_date >= D) bump('ladder_row_on_or_after_event'); if (row.bout_id === c.bout_id) bump('target_bout_in_ladder'); }
    const w = T.resolution.get(`${c.bout_id}|${inp.fighter.id}`);
    if (w?.rejected?.length) fallbackCorners++;
  }
  const ch = T.champion.get(c.bout_id);
  if (!ch || ch.fold_year !== c.year) bump('anchor_fold_year_mismatch');
  if (!(ch.fighter_1_id < ch.fighter_2_id)) bump('anchor_not_canonical_order');
  const json = JSON.stringify(input);
  if (json.includes(c.bout_id)) bump('target_bout_id_in_inputs');
  if (/"winner_id"|"result_method"|"end_round"/.test(json)) bump('result_field_in_inputs');
  checked++;
}

// Truncation test: rebuild a deterministic sample of bouts after deleting every raw row dated >= D; the inputs must be byte-identical.
let truncated = 0, truncationDiffs = 0;
for (let i = 0; i < cohort.length; i += 29) {
  const c = cohort[i];
  const a = canonicalJson(boutInput(c)), b = canonicalJson(boutInput(c, { truncateAt: c.event_date }));
  truncated++; if (a !== b) truncationDiffs++;
}
if (truncationDiffs) fail.truncation_changed_inputs = truncationDiffs;

const report = { cohort: cohort.length, checked, failures: fail, fallback_corners: fallbackCorners, truncation_sample: truncated, truncation_diffs: truncationDiffs, closest_included_bout_days_before_event: closestGapDays, min_snapshot_as_of_gap_days: minAsOfGap, all_passed: Object.keys(fail).length === 0 };
fs.writeFileSync(path.join(CACHE, 'leakage_audit.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(report.all_passed ? 0 : 1);
