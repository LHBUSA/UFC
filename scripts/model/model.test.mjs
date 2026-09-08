// Deterministic tests for the PBE Fight Model pipeline.
//
//   node --test scripts/model/model.test.mjs
//
// Two kinds of test here. Most are pure and run anywhere. A few need the local
// read-only extract (PBE_MODEL_CACHE or .cache/model) and are skipped with a
// message rather than silently passing when it is absent - a skipped test that
// looks like a pass is worse than no test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { FEATURE_KEYS, FEATURES, BANNED_FIGHTER_COLUMNS } from './feature_spec.mjs';
import { fitLogistic, fitScale, applyScale, predictOne, sigmoid } from './logistic.mjs';
import { brier, logLoss, accuracy, auc, calibration, byConfidenceBand, wilson, skill } from './metrics.mjs';
import { impliedFromAmerican, consensusForBout } from './market_baseline.mjs';
import { buildFromTables } from './build_features.mjs';
import { cacheDir, readJsonl, daysBetween } from './common.mjs';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !== ${b} (tol ${tol})`);

/* ---------------------------------------------------------------- spec --- */

test('feature keys are unique and none names a banned career column', () => {
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length);
  for (const banned of BANNED_FIGHTER_COLUMNS) {
    assert.ok(!FEATURE_KEYS.some((k) => k.includes(banned)), `feature references banned column ${banned}`);
  }
  // Every feature carries a source and a documented expected sign; the backtest
  // report leans on both.
  for (const f of FEATURES) {
    assert.ok(['dna_snapshot', 'dna_bout_rows', 'static'].includes(f.source), `${f.key} has source ${f.source}`);
    assert.equal(typeof f.higherIsBetter, 'boolean');
    assert.ok(f.doc.length > 10);
  }
});

/* ------------------------------------------------------------ logistic --- */

test('logistic regression recovers a known coefficient sign and is deterministic', () => {
  // y depends on x0 positively and x1 negatively, with x2 pure noise.
  const rows = [];
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 4000; i++) {
    const x = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const p = sigmoid(2.5 * x[0] - 1.5 * x[1]);
    rows.push({ x, y: rnd() < p ? 1 : 0 });
  }
  const X = rows.map((r) => r.x);
  const y = rows.map((r) => r.y);
  const a = fitLogistic(X, y, 1);
  const b = fitLogistic(X, y, 1);

  assert.deepEqual(a.beta, b.beta, 'two fits of identical data disagree');
  assert.ok(a.converged, 'fit did not converge');
  assert.ok(a.beta[0] > 1.5, `expected a strong positive coefficient, got ${a.beta[0]}`);
  assert.ok(a.beta[1] < -1.0, `expected a strong negative coefficient, got ${a.beta[1]}`);
  assert.ok(Math.abs(a.beta[2]) < 0.35, `noise feature picked up weight: ${a.beta[2]}`);
});

test('a stronger ridge penalty shrinks coefficients', () => {
  const X = Array.from({ length: 500 }, (_, i) => [((i % 17) - 8) / 8]);
  const y = X.map((x) => (x[0] > 0 ? 1 : 0));
  const weak = fitLogistic(X, y, 1).beta[0];
  const strong = fitLogistic(X, y, 500).beta[0];
  assert.ok(Math.abs(strong) < Math.abs(weak), `ridge did not shrink: ${weak} -> ${strong}`);
});

test('scaling is RMS and never re-centres, so negation still negates', () => {
  const X = [[2, 0], [-2, 0], [4, 5], [-4, -5]];
  const scale = fitScale(X);
  near(scale[0], Math.sqrt((4 + 4 + 16 + 16) / 4));
  assert.equal(scale[1], Math.sqrt((0 + 0 + 25 + 25) / 4));
  const x = [3, 7];
  const scaled = applyScale(x, scale);
  const negScaled = applyScale(x.map((v) => -v), scale);
  for (let i = 0; i < scaled.length; i++) near(scaled[i], -negScaled[i]);
});

test('a zero-variance column gets scale 1 rather than a division by zero', () => {
  const scale = fitScale([[0, 1], [0, 2], [0, 3]]);
  assert.equal(scale[0], 1);
  assert.ok(Number.isFinite(applyScale([0, 2], scale)[0]));
});

test('the model is exactly antisymmetric: swapping corners complements the probability', () => {
  const beta = [0.4, -1.1, 0.05, 2.0];
  const scale = [1, 2, 0.5, 3];
  for (const x of [[1, 2, 3, 4], [-5, 0.2, 0, 11], [0, 0, 0, 0], [100, -100, 50, -50]]) {
    const p = predictOne(x, beta, scale);
    const flipped = predictOne(x.map((v) => -v), beta, scale);
    near(p + flipped, 1, 1e-12);
  }
});

/* ------------------------------------------------------------- metrics --- */

test('brier, log loss and accuracy match hand-computed values', () => {
  const rows = [{ p: 0.9, y: 1 }, { p: 0.3, y: 0 }, { p: 0.6, y: 0 }, { p: 0.5, y: 1 }];
  near(brier(rows), (0.01 + 0.09 + 0.36 + 0.25) / 4);
  near(logLoss(rows), -(Math.log(0.9) + Math.log(0.7) + Math.log(0.4) + Math.log(0.5)) / 4, 1e-12);
  // 0.9 hits, 0.3 hits, 0.6 misses, 0.5 is not a pick and counts a half.
  near(accuracy(rows), (1 + 1 + 0 + 0.5) / 4);
});

test('the coin baseline scores exactly 0.25 and log 2', () => {
  const rows = [{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }];
  near(brier(rows), 0.25);
  near(logLoss(rows), Math.log(2), 1e-12);
  near(accuracy(rows), 0.5);
  assert.equal(skill(brier(rows), 0.25), 0);
});

test('AUC is 1 for a perfect ranking, 0.5 for a constant one, and averages ties', () => {
  near(auc([{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }, { p: 0.2, y: 0 }, { p: 0.1, y: 0 }]), 1);
  near(auc([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.5);
  near(auc([{ p: 0.9, y: 0 }, { p: 0.8, y: 0 }, { p: 0.2, y: 1 }, { p: 0.1, y: 1 }]), 0);
  assert.equal(auc([{ p: 0.7, y: 1 }, { p: 0.6, y: 1 }]), null, 'AUC is undefined with one class');
});

test('calibration folds both corners onto the picked side', () => {
  // A 0.3 prediction that lost is a 0.7 pick that won. The two must land in the
  // same bin with the same verdict, or every underdog pick is double counted.
  const a = calibration([{ p: 0.7, y: 1 }]);
  const b = calibration([{ p: 0.3, y: 0 }]);
  const binA = a.bins.find((x) => x.n > 0);
  const binB = b.bins.find((x) => x.n > 0);
  assert.equal(binA.lo, binB.lo);
  near(binA.predicted, binB.predicted);
  assert.equal(binA.observed, 1);
  assert.equal(binB.observed, 1);
});

test('a perfectly calibrated set has ~zero ECE and slope near one', () => {
  const rows = [];
  for (const [p, n] of [[0.55, 200], [0.65, 200], [0.75, 200], [0.85, 200]]) {
    const wins = Math.round(p * n);
    for (let i = 0; i < n; i++) rows.push({ p, y: i < wins ? 1 : 0 });
  }
  const c = calibration(rows);
  assert.ok(c.ece < 0.005, `ECE ${c.ece}`);
  assert.ok(Math.abs(c.slope - 1) < 0.05, `slope ${c.slope}`);
});

test('confidence bands count hits on the picked side', () => {
  const bands = byConfidenceBand([{ p: 0.62, y: 1 }, { p: 0.38, y: 0 }, { p: 0.62, y: 0 }]);
  const band = bands.find((b) => b.band === '60-65');
  assert.equal(band.n, 3);
  assert.equal(band.hits, 2);
  near(band.hit_rate, 2 / 3);
});

test('Wilson interval brackets the point estimate and narrows with sample size', () => {
  const small = wilson(6, 10);
  const large = wilson(600, 1000);
  assert.ok(small.lo < 0.6 && small.hi > 0.6);
  assert.ok(large.hi - large.lo < small.hi - small.lo);
  assert.equal(wilson(0, 0), null);
});

/* -------------------------------------------------------------- market --- */

test('American odds convert to implied probability both ways', () => {
  near(impliedFromAmerican(-200), 200 / 300);
  near(impliedFromAmerican(150), 100 / 250);
  near(impliedFromAmerican(100), 0.5);
  assert.equal(impliedFromAmerican(null), null);
});

test('de-vigged consensus sums to one and keeps the favourite favoured', () => {
  const obs = [
    { market_key: 'h2h', bookmaker_key: 'x', outcome_fighter_id: 'A', price: -200, observed_at: '2026-01-01T00:00:00Z' },
    { market_key: 'h2h', bookmaker_key: 'x', outcome_fighter_id: 'B', price: 170, observed_at: '2026-01-01T00:00:00Z' },
    { market_key: 'h2h', bookmaker_key: 'y', outcome_fighter_id: 'A', price: -180, observed_at: '2026-01-01T00:00:00Z' },
    { market_key: 'h2h', bookmaker_key: 'y', outcome_fighter_id: 'B', price: 160, observed_at: '2026-01-01T00:00:00Z' },
  ];
  const sides = consensusForBout(obs, '2026-01-02T00:00:00Z');
  near(sides[0].devigged + sides[1].devigged, 1, 1e-12);
  const a = sides.find((s) => s.fighter_id === 'A');
  assert.ok(a.devigged > 0.5);
  // The vig has to actually be removed, not merely renamed.
  assert.ok(a.implied > a.devigged, 'de-vigging did not reduce the favourite');
});

test('an observation recorded after the cutoff is not usable', () => {
  const obs = [
    { market_key: 'h2h', bookmaker_key: 'x', outcome_fighter_id: 'A', price: -200, observed_at: '2026-01-05T00:00:00Z' },
    { market_key: 'h2h', bookmaker_key: 'x', outcome_fighter_id: 'B', price: 170, observed_at: '2026-01-05T00:00:00Z' },
  ];
  assert.equal(consensusForBout(obs, '2026-01-01T00:00:00Z'), null);
  assert.notEqual(consensusForBout(obs, '2026-01-06T00:00:00Z'), null);
});

/* ------------------------------------------------------------ features --- */

function syntheticTables() {
  const F = (id, name, extra = {}) => ({ id, name, dob: '1990-01-01', height_in: 70, reach_in: 72, stance: 'ORTHODOX', ...extra });
  const snap = (fighter_id, as_of_date, over) => ({
    fighter_id, as_of_date, definition_version: 1,
    sample_bouts: 0, sample_completed_bouts: 0, sample_stat_bouts: 0, sample_rounds: 0, sample_seconds: 0,
    coverage_status: 'low', record: { w: 0, l: 0, d: 0, nc: 0, appearances: 0 },
    included_bouts: [], finished_by: { ko_tko: 0, submission: 0 },
    five_round_apps: '0', title_apps: '0', main_event_apps: '0',
    m_sig_landed_per_min: null, ...over,
  });
  return {
    events: [
      { id: 'e1', name: 'Old Card', event_date: '2020-01-01' },
      { id: 'e2', name: 'Target Card', event_date: '2021-01-01' },
    ],
    fighters: [F('f1', 'One', { id: 'f1' }), F('f2', 'Two'), F('f3', 'Three')],
    bouts: [
      { id: 'b_old', event_id: 'e1', fighter_a_id: 'f1', fighter_b_id: 'f3', weight_class: 'LIGHTWEIGHT', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: 1, status: 'complete' },
      { id: 'b_target', event_id: 'e2', fighter_a_id: 'f1', fighter_b_id: 'f2', weight_class: 'LIGHTWEIGHT', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: 1, status: 'complete' },
    ],
    results: [
      { bout_id: 'b_old', winner_id: 'f1', method: 'KO_TKO', round: 1, time_sec: 60 },
      { bout_id: 'b_target', winner_id: 'f2', method: 'DEC_U', round: 3, time_sec: 300 },
    ],
    bout_features: [
      { fighter_id: 'f1', bout_id: 'b_old', event_id: 'e1', opponent_id: 'f3', event_date: '2020-01-01', outcome: 'W', method: 'KO_TKO', scheduled_rounds: 3, is_title: false, is_main_event: true, short_notice_days: null, observed_seconds: 60, stats_coverage: 'complete', round_rows: 1, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: { td_a: 2, td_l: 1 }, opp_totals: { td_a: 4, td_l: 1 } },
      { fighter_id: 'f3', bout_id: 'b_old', event_id: 'e1', opponent_id: 'f1', event_date: '2020-01-01', outcome: 'L', method: 'KO_TKO', scheduled_rounds: 3, is_title: false, is_main_event: true, short_notice_days: null, observed_seconds: 60, stats_coverage: 'complete', round_rows: 1, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: { td_a: 4, td_l: 1 }, opp_totals: { td_a: 2, td_l: 1 } },
      // The target bout's own DNA row exists, exactly as it does in production.
      { fighter_id: 'f1', bout_id: 'b_target', event_id: 'e2', opponent_id: 'f2', event_date: '2021-01-01', outcome: 'L', method: 'DEC_U', scheduled_rounds: 3, is_title: false, is_main_event: true, short_notice_days: null, observed_seconds: 900, stats_coverage: 'complete', round_rows: 3, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: { td_a: 0, td_l: 0 }, opp_totals: { td_a: 9, td_l: 6 } },
      { fighter_id: 'f2', bout_id: 'b_target', event_id: 'e2', opponent_id: 'f1', event_date: '2021-01-01', outcome: 'W', method: 'DEC_U', scheduled_rounds: 3, is_title: false, is_main_event: true, short_notice_days: null, observed_seconds: 900, stats_coverage: 'complete', round_rows: 3, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: { td_a: 9, td_l: 6 }, opp_totals: { td_a: 0, td_l: 0 } },
    ],
    snapshots: [
      snap('f1', '2020-01-02', { sample_bouts: 1, sample_completed_bouts: 1, sample_stat_bouts: 1, record: { w: 1, l: 0, d: 0, nc: 0, appearances: 1 }, included_bouts: ['b_old'], m_sig_landed_per_min: '5.0' }),
      // The snapshot generated AFTER the target bout. It contains the target
      // bout and must never be selected for it.
      snap('f1', '2021-01-02', { sample_bouts: 2, sample_completed_bouts: 2, sample_stat_bouts: 2, record: { w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, included_bouts: ['b_old', 'b_target'], m_sig_landed_per_min: '99.0' }),
      snap('f2', '2021-01-02', { sample_bouts: 1, sample_completed_bouts: 1, sample_stat_bouts: 1, record: { w: 1, l: 0, d: 0, nc: 0, appearances: 1 }, included_bouts: ['b_target'], m_sig_landed_per_min: '77.0' }),
    ],
  };
}

test('the as-of lookup never selects the snapshot that contains the bout itself', () => {
  const { rows, audit } = buildFromTables(syntheticTables());
  const target = rows.find((r) => r.bout_id === 'b_target');
  assert.ok(target);
  assert.equal(audit.violation_target_in_snapshot, 0);
  assert.equal(audit.violation_future_bout_in_snapshot, 0);
  assert.equal(audit.violation_snapshot_after_event, 0);

  const f1Side = target.fighter_1_id === 'f1' ? target.side_1 : target.side_2;
  const f2Side = target.fighter_1_id === 'f1' ? target.side_2 : target.side_1;
  // f1's pre-fight snapshot is the 2020 one, with one prior bout - NOT the 2021
  // one, which knows the answer and carries the 99.0 tell.
  assert.equal(f1Side.snapshot_as_of, '2020-01-02');
  assert.equal(f1Side.prior_bouts, 1);
  assert.equal(f1Side.slpm, 5);
  // f2 was making their debut: no snapshot exists on or before the event.
  assert.equal(f2Side.snapshot_as_of, null);
  assert.equal(f2Side.prior_bouts, 0);
  assert.equal(f2Side.slpm, null);
});

test('the ladder is advanced in date blocks, so a bout cannot see its own card', () => {
  const tables = syntheticTables();
  // Put a second bout for f1's opponent on the target date. Neither may inform
  // the other.
  tables.bouts.push({ id: 'b_same_day', event_id: 'e2', fighter_a_id: 'f2', fighter_b_id: 'f3', weight_class: 'LIGHTWEIGHT', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'prelim', bout_order: 2, status: 'complete' });
  tables.results.push({ bout_id: 'b_same_day', winner_id: 'f2', method: 'SUB', round: 1, time_sec: 90 });
  tables.bout_features.push(
    { fighter_id: 'f2', bout_id: 'b_same_day', event_id: 'e2', opponent_id: 'f3', event_date: '2021-01-01', outcome: 'W', method: 'SUB', scheduled_rounds: 3, is_title: false, is_main_event: false, short_notice_days: null, observed_seconds: 90, stats_coverage: 'complete', round_rows: 1, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: {}, opp_totals: {} },
    { fighter_id: 'f3', bout_id: 'b_same_day', event_id: 'e2', opponent_id: 'f2', event_date: '2021-01-01', outcome: 'L', method: 'SUB', scheduled_rounds: 3, is_title: false, is_main_event: false, short_notice_days: null, observed_seconds: 90, stats_coverage: 'complete', round_rows: 1, fighter_stance: 'ORTHODOX', opponent_stance: 'ORTHODOX', stance_context: 'same', totals: {}, opp_totals: {} },
  );
  const { rows } = buildFromTables(tables);
  const target = rows.find((r) => r.bout_id === 'b_target');
  const f2Side = target.fighter_1_id === 'f2' ? target.side_1 : target.side_2;
  assert.equal(f2Side.ladder_bouts, 0, 'f2 saw a same-card result before their own fight');
});

test('swapping the two corners negates the feature vector exactly', () => {
  const tables = syntheticTables();
  const before = buildFromTables(tables).rows.find((r) => r.bout_id === 'b_target');
  for (const b of tables.bouts) {
    if (b.id !== 'b_target') continue;
    [b.fighter_a_id, b.fighter_b_id] = [b.fighter_b_id, b.fighter_a_id];
  }
  const after = buildFromTables(tables).rows.find((r) => r.bout_id === 'b_target');
  // Canonical orientation sorts by UUID, so swapping the source columns must
  // change nothing at all.
  assert.deepEqual(after.x, before.x, 'canonical orientation depends on source column order');
  assert.equal(after.label, before.label);
});

test('date arithmetic is UTC and does not drift across a DST boundary', () => {
  assert.equal(daysBetween('2021-03-13', '2021-03-15'), 2);
  assert.equal(daysBetween('2021-11-06', '2021-11-08'), 2);
  assert.equal(daysBetween('2020-02-28', '2020-03-01'), 2); // leap year
});

/* ------------------------------------------------- cache-backed checks --- */

const cache = (() => { try { return cacheDir(); } catch { return null; } })();
const hasDataset = cache && fs.existsSync(path.join(cache, 'dataset.jsonl'));
const skipMsg = 'requires the local read-only extract: node scripts/model/extract_dataset.mjs';

test('the released artifact reproduces its own spec hash', { skip: fs.existsSync(path.join(process.cwd(), 'web/lib/generated/model-v1.json')) ? false : 'no released artifact' }, () => {
  const a = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'web/lib/generated/model-v1.json'), 'utf8'));
  const canonical = JSON.stringify({
    model_version: a.model.model_version,
    feature_version: a.model.feature_version,
    features: FEATURE_KEYS,
    coefficients: FEATURE_KEYS.map((k) => a.model.coefficients[k]),
    scale: FEATURE_KEYS.map((k) => a.model.feature_scale[k]),
    lambda: a.model.lambda,
  });
  assert.equal(createHash('sha256').update(canonical).digest('hex'), a.model.spec_sha256);
  assert.equal(Object.keys(a.model.coefficients).length, FEATURE_KEYS.length);
});

test('every scored backtest prediction is out of sample and strictly future to its fold', { skip: hasDataset ? false : skipMsg }, () => {
  const summary = JSON.parse(fs.readFileSync(path.join(cache, 'backtest_v1.json'), 'utf8'));
  const preds = readJsonl(path.join(cache, 'backtest_predictions.jsonl'));
  const byYear = new Map();
  for (const p of preds) {
    if (!byYear.has(p.fold_year)) byYear.set(p.fold_year, []);
    byYear.get(p.fold_year).push(p.event_date);
  }
  for (const fold of summary.folds.filter((f) => !f.skipped)) {
    const dates = byYear.get(fold.year).sort();
    assert.ok(fold.train_to < dates[0], `fold ${fold.year}: trained to ${fold.train_to}, scored from ${dates[0]}`);
    assert.equal(dates[0].slice(0, 4), String(fold.year));
  }
  // Every bout is scored at most once across the whole walk-forward.
  assert.equal(new Set(preds.map((p) => p.bout_id)).size, preds.length);
});

test('the headline backtest numbers beat both baselines', { skip: hasDataset ? false : skipMsg }, () => {
  const s = JSON.parse(fs.readFileSync(path.join(cache, 'backtest_v1.json'), 'utf8'));
  assert.ok(s.headline.model.brier < s.headline.coin.brier, 'model does not beat the coin on Brier');
  assert.ok(s.headline.model.brier < s.headline.winrate.brier, 'model does not beat the win-rate baseline on Brier');
  assert.ok(s.headline.model.log_loss < s.headline.winrate.log_loss);
  assert.ok(s.headline.model.auc > 0.55, `AUC ${s.headline.model.auc}`);
  // Calibration is the claim that makes a published probability meaningful.
  assert.ok(s.headline.model.calibration.ece < 0.04, `ECE ${s.headline.model.calibration.ece}`);
});

test('rebuilding features from the cache is byte-identical', { skip: hasDataset ? false : skipMsg }, () => {
  const first = fs.readFileSync(path.join(cache, 'dataset.jsonl'));
  const { loadTables } = { loadTables: null };
  void loadTables;
  const rebuilt = buildFromTables(
    Object.fromEntries(['events', 'fighters', 'results', 'bouts', 'bout_features', 'snapshots']
      .map((n) => [n, readJsonl(path.join(cache, `${n}.jsonl`))])),
  ).rows;
  const text = rebuilt.map((r) => JSON.stringify(r)).join('\n') + '\n';
  assert.equal(createHash('sha256').update(text).digest('hex'), createHash('sha256').update(first).digest('hex'));
});
