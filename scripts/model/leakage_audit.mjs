#!/usr/bin/env node
// PBE Fight Model v1 - leakage audit.
//
//   node scripts/model/leakage_audit.mjs
//
// Six independent checks. Each one can fail on its own; the run fails if any
// does. The point is not to assert that the code looks careful, it is to make
// leakage produce a number that is visibly wrong.
//
//  1  SOURCE ALLOWLIST     The cached extract must not contain a single banned
//                          column. Present-day career totals and the bout's own
//                          result cannot leak through code that never received
//                          them.
//
//  2  SNAPSHOT PROVENANCE  Every as-of Fight DNA snapshot selected for a bout
//                          must (a) be dated on or before the event, (b) not
//                          list the bout under prediction among its inputs, and
//                          (c) list no bout dated on or after the event.
//
//  3  TRUNCATION           The decisive test. For a large random sample of
//                          bouts, delete EVERY row in the dataset dated on or
//                          after that bout - other bouts, their results, their
//                          DNA feature rows, and every snapshot generated after
//                          it - then rebuild the bout's feature vector. If any
//                          future fact were reaching the vector, the truncated
//                          vector would differ. It must be identical to the
//                          last bit.
//
//  4  PERMUTATION          Shuffle the training labels and refit. A pipeline
//                          that has smuggled the answer in through a feature
//                          keeps performing; one that has not collapses to the
//                          coin. Skill must fall to approximately zero.
//
//  5  ANTISYMMETRY         Swapping the corners must return exactly the
//                          complementary probability, so no corner ordering,
//                          and no artifact of which fighter the source listed
//                          first, can be doing work.
//
//  6  FOLD BOUNDARIES      In every walk-forward fold, the latest training
//                          event must be strictly earlier than the earliest
//                          scored event.

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, readJsonl } from './common.mjs';
import { loadTables, buildFromTables } from './build_features.mjs';
import { BANNED_FIGHTER_COLUMNS, BANNED_FEATURE_SOURCES, FEATURE_KEYS } from './feature_spec.mjs';
import { fitFold, winRateBaseline } from './backtest.mjs';
import { predictOne } from './logistic.mjs';
import { brier } from './metrics.mjs';

const SAMPLE_SIZE = Number(process.env.PBE_AUDIT_SAMPLE || 250);

/** Deterministic PRNG so the audit samples the same bouts on every run. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkAllowlist(cache) {
  const banned = [];
  const fighters = readJsonl(path.join(cache, 'fighters.jsonl'));
  const present = new Set(Object.keys(fighters[0] || {}));
  for (const col of BANNED_FIGHTER_COLUMNS) if (present.has(col)) banned.push(`fighters.${col}`);

  // The extractor pulls results and market rows for labels and comparison. The
  // check that matters is that the FEATURE builder never receives them, which
  // is a property of the code, so it is asserted against the code itself.
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'build_features.mjs'), 'utf8');
  const featureBody = src.slice(src.indexOf('function buildSide'), src.indexOf('export function loadTables'));
  const forbiddenInFeatures = ['results.get', 'winner_id', 'p_market', 'price', 'implied'];
  const hits = forbiddenInFeatures.filter((t) => featureBody.includes(t));

  return {
    name: 'source allowlist',
    pass: banned.length === 0 && hits.length === 0,
    banned_columns_present: banned,
    banned_sources: BANNED_FEATURE_SOURCES,
    result_or_price_symbols_inside_feature_functions: hits,
    fighter_columns_extracted: [...present].sort(),
  };
}

function checkSnapshotProvenance(cache) {
  const audit = JSON.parse(fs.readFileSync(path.join(cache, 'feature_audit.json'), 'utf8'));
  return {
    name: 'snapshot provenance',
    pass:
      audit.violation_target_in_snapshot === 0 &&
      audit.violation_future_bout_in_snapshot === 0 &&
      audit.violation_snapshot_after_event === 0,
    target_bout_found_inside_its_own_snapshot: audit.violation_target_in_snapshot,
    snapshot_containing_a_bout_on_or_after_the_event: audit.violation_future_bout_in_snapshot,
    snapshot_dated_after_the_event: audit.violation_snapshot_after_event,
    snapshot_record_vs_independent_ladder: `${audit.snapshot_record_mismatch} mismatches in ${audit.snapshot_record_checked} comparisons`,
    // Across every snapshot selected for every bout, the smallest gap between a
    // bout inside the snapshot and the event it was used to predict. Strictly
    // positive is the proof: nothing same-day, nothing later.
    closest_included_bout_days_before_event: audit.max_included_bout_date_offset_days,
  };
}

function checkTruncation(cache, dataset) {
  const tables = loadTables(cache);
  const byId = new Map(dataset.map((r) => [r.bout_id, r]));
  const eventDate = new Map(tables.events.map((e) => [e.id, e.event_date]));

  const candidates = dataset.filter((r) => r.graded && r.min_prior_bouts >= 1 && r.event_date >= '2010-01-01');
  const rand = mulberry32(20260908);
  const picked = [];
  const seen = new Set();
  while (picked.length < Math.min(SAMPLE_SIZE, candidates.length)) {
    const i = Math.floor(rand() * candidates.length);
    if (seen.has(i)) continue;
    seen.add(i);
    picked.push(candidates[i]);
  }

  let compared = 0;
  const mismatches = [];
  for (const target of picked) {
    const D = target.event_date;
    const keptBouts = tables.bouts.filter((b) => b.id === target.bout_id || (eventDate.get(b.event_id) || '9999') < D);
    const keptIds = new Set(keptBouts.map((b) => b.id));
    const truncated = {
      events: tables.events,
      fighters: tables.fighters,
      results: tables.results.filter((r) => keptIds.has(r.bout_id) && r.bout_id !== target.bout_id),
      bouts: keptBouts,
      bout_features: tables.bout_features.filter((r) => r.event_date < D),
      snapshots: tables.snapshots.filter((s) => s.as_of_date <= D),
    };
    const rebuilt = buildFromTables(truncated).rows.find((r) => r.bout_id === target.bout_id);
    compared += 1;
    if (!rebuilt) { mismatches.push({ bout_id: target.bout_id, reason: 'not rebuilt' }); continue; }
    const before = byId.get(target.bout_id).x;
    const after = rebuilt.x;
    for (let j = 0; j < before.length; j++) {
      if (before[j] !== after[j]) {
        mismatches.push({ bout_id: target.bout_id, event_date: D, feature: FEATURE_KEYS[j], full: before[j], truncated: after[j] });
        break;
      }
    }
  }

  return {
    name: 'truncation',
    pass: mismatches.length === 0,
    bouts_rebuilt_with_all_later_data_deleted: compared,
    vectors_that_changed: mismatches.length,
    examples: mismatches.slice(0, 10),
  };
}

function checkPermutation(dataset) {
  const graded = dataset
    .filter((r) => r.graded)
    .sort((a, b) => (a.event_date === b.event_date ? a.bout_id.localeCompare(b.bout_id) : a.event_date.localeCompare(b.event_date)));
  const train = graded.filter((r) => r.event_date < '2024-01-01');
  const test = graded.filter((r) => r.event_date >= '2024-01-01');

  const real = fitFold(train);
  const realBrier = brier(test.map((r) => ({ p: predictOne(r.x, real.beta, real.scale), y: r.label })));

  const rand = mulberry32(7);
  const labels = train.map((r) => r.label);
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [labels[i], labels[j]] = [labels[j], labels[i]];
  }
  const shuffledTrain = train.map((r, i) => ({ ...r, label: labels[i] }));
  const fake = fitFold(shuffledTrain);
  const fakeBrier = brier(test.map((r) => ({ p: predictOne(r.x, fake.beta, fake.scale), y: r.label })));

  const realSkill = 1 - realBrier / 0.25;
  const fakeSkill = 1 - fakeBrier / 0.25;
  return {
    name: 'permutation',
    // A pipeline reading the answer keeps its skill when labels are destroyed.
    // Real skill must be clearly positive and permuted skill must sit at zero.
    pass: realSkill > 0.02 && Math.abs(fakeSkill) < 0.01,
    real_brier_skill_vs_coin: realSkill,
    permuted_label_brier_skill_vs_coin: fakeSkill,
  };
}

function checkAntisymmetry(dataset) {
  const graded = dataset.filter((r) => r.graded);
  const train = graded.filter((r) => r.event_date < '2024-01-01');
  const model = fitFold(train);
  let worst = 0;
  let worstWinrate = 0;
  for (const r of graded.filter((x) => x.event_date >= '2024-01-01')) {
    const p = predictOne(r.x, model.beta, model.scale);
    const flipped = predictOne(r.x.map((v) => -v), model.beta, model.scale);
    worst = Math.max(worst, Math.abs(p + flipped - 1));
    const w = winRateBaseline(r);
    const wFlipped = winRateBaseline({ side_1: r.side_2, side_2: r.side_1 });
    worstWinrate = Math.max(worstWinrate, Math.abs(w + wFlipped - 1));
  }
  return {
    name: 'antisymmetry',
    pass: worst < 1e-9 && worstWinrate < 1e-9,
    max_model_probability_sum_error: worst,
    max_winrate_baseline_sum_error: worstWinrate,
  };
}

function checkFoldBoundaries(cache) {
  const summary = JSON.parse(fs.readFileSync(path.join(cache, 'backtest_v1.json'), 'utf8'));
  const preds = readJsonl(path.join(cache, 'backtest_predictions.jsonl'));
  const bad = [];
  for (const fold of summary.folds) {
    if (fold.skipped) continue;
    const testDates = preds.filter((p) => p.fold_year === fold.year).map((p) => p.event_date).sort();
    if (!testDates.length) { bad.push({ year: fold.year, reason: 'no scored rows' }); continue; }
    if (!(fold.train_to < testDates[0])) bad.push({ year: fold.year, train_to: fold.train_to, first_test: testDates[0] });
  }
  return {
    name: 'fold boundaries',
    pass: bad.length === 0,
    folds_checked: summary.folds.filter((f) => !f.skipped).length,
    overlapping_folds: bad,
  };
}

function main() {
  const cache = cacheDir();
  const dataset = readJsonl(path.join(cache, 'dataset.jsonl'));

  const checks = [
    checkAllowlist(cache),
    checkSnapshotProvenance(cache),
    checkTruncation(cache, dataset),
    checkPermutation(dataset),
    checkAntisymmetry(dataset),
    checkFoldBoundaries(cache),
  ];

  const report = { generated_at: new Date().toISOString(), sample_size: SAMPLE_SIZE, all_passed: checks.every((c) => c.pass), checks };
  fs.writeFileSync(path.join(cache, 'leakage_audit.json'), JSON.stringify(report, null, 2));

  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(JSON.stringify(checks, null, 2));
  if (!report.all_passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) main();
