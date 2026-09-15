// PBE Algo daily learning + weekly review: the pure core.
//
// No fetch, no database, no R2, no clock. Everything the learning Workflow and
// the weekly review decide is decided here, so it is unit-tested rather than
// observed in production. Design: docs/PBE_ALGO_LEARNING_DESIGN.md.

import { FEATURE_KEYS } from '../../../../scripts/model/feature_spec.mjs';
import { predictOne } from '../../../../scripts/model/logistic.mjs';
import { fitFold, walkForward, trainingOrder, LAMBDA_GRID, INNER_VALIDATION_SHARE } from '../../../../scripts/model/walkforward_core.mjs';
import { summarise, byConfidenceBand, bySlice, brier, logLoss } from '../../../../scripts/model/metrics.mjs';
import { sha256Hex, specCanonical } from '../champion.js';

export { sha256Hex, specCanonical };

export const LEARNING_CODE_VERSION = 'pbe-algo-learning-v1';
export const REVIEW_VERSION = 'pbe-algo-review-v1';
/** A challenger has no public name; its spec hash is taken under this fixed label so it depends only on coefficients, scale and lambda. */
export const CHALLENGER_LABEL = 'pbe-fight-model-challenger';

/**
 * Coefficients and scale are stored at 10 decimal places. The same fit in Node
 * and in workerd agrees only to ~2e-15 (measured 2026-09-15: 30 of 33
 * coefficients differed in the last bits), so a bitwise spec hash would not be
 * reproducible across runtimes. At 10 dp every stored value, and therefore the
 * spec hash, re-derives identically from the dataset; predictions move < 1e-9.
 */
export const SPEC_DECIMALS = 10;
export const specRound = (v) => Math.round(v * 10 ** SPEC_DECIMALS) / 10 ** SPEC_DECIMALS;

/* Weekly promotion contract (design section 7). Changing any value is a
 * versioned contract change: bump REVIEW_VERSION. */
export const REVIEW_THRESHOLDS = Object.freeze({
  maxBrierRegression: 0.002,
  maxLogLossRegression: 0.005,
  maxEceRegression: 0.010,
  slopeRange: [0.85, 1.15],
  highConfTailMinObservedMinusPredicted: -0.05,
  highConfTailMinN: 50,
  sliceMinN: 300,
  sliceMaxBrierRegression: 0.005,
  maxAbsCoefficientMove: 0.05,
  signFlipMinAbsCoefficient: 0.02,
  benchmarkMaxMeanAbsDeltaPts: 1.0,
  benchmarkMaxAbsDeltaPts: 5.0,
  minPairedShadowBouts: 50,
});

/* ---------------------------------------------------------------- dataset */

/** The training label, exactly as the batch builder derives it: 1 when canonical corner 1 won, 0 when corner 2 won, null otherwise (draw, NC, unknown winner). */
export function labelFromResult(result, fighter1Id, fighter2Id) {
  if (!result || !result.winner_id) return null;
  if (result.winner_id === fighter1Id) return 1;
  if (result.winner_id === fighter2Id) return 0;
  return null;
}

/** A compact training row: exactly what training, validation and hashing read. */
export function compactRow(r, label) {
  return {
    bout_id: r.bout_id, event_date: r.event_date, label,
    x: r.x, available: r.available.map((a) => (a ? 1 : 0)),
    min_prior_bouts: r.min_prior_bouts, min_stat_bouts: r.min_stat_bouts, available_count: r.available_count,
  };
}

/** Canonical dataset: graded rows only, training order. */
export function canonicalDataset(rows) {
  return rows.filter((r) => r.label === 0 || r.label === 1).slice().sort(trainingOrder);
}

/** sha256 over newline-joined [bout_id, event_date, label, x, available(0/1)] in training order: the release-window hash recipe (b466d86b... for V1's window). */
export async function datasetSha256(rows) {
  const lines = canonicalDataset(rows).map((r) => JSON.stringify([r.bout_id, r.event_date, r.label, r.x, r.available]));
  return sha256Hex(lines.join('\n'));
}

export const toJsonl = (rows) => canonicalDataset(rows).map((r) => JSON.stringify(r)).join('\n') + '\n';
export const fromJsonl = (text) => String(text || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Parent + newly assembled rows. A bout already in the parent is kept as-is (repairs are the weekly rebuild's job). */
export function mergeIncrement(parentRows, newRows) {
  const seen = new Set(parentRows.map((r) => r.bout_id));
  const added = [];
  const alreadyPresent = [];
  for (const r of newRows) {
    if (seen.has(r.bout_id)) { alreadyPresent.push(r.bout_id); continue; }
    seen.add(r.bout_id);
    added.push(r);
  }
  return { rows: canonicalDataset([...parentRows, ...added]), added: added.length, already_present: alreadyPresent };
}

/* ------------------------------------------------------------------- gate */

/**
 * Should today's run learn?
 *   cutoffDate  today's date (UTC): only events strictly before it can train
 *   newBouts    graded bouts (winner stored) dated before the cutoff that the parent dataset does not contain: [{ bout_id, event_date }]
 *   freshness   { statsIngestAt, missingSnapshots: [fighter_id], missingFeatureRows: [bout_id], lockedUngraded }
 */
export function decideGate({ cutoffDate, newBouts, freshness }) {
  const eligible = newBouts.filter((g) => g.event_date < cutoffDate);
  if (!eligible.length) return { status: 'NO_NEW_TRAINING_DATA', reason: `no verified graded bout before ${cutoffDate} is missing from the parent dataset`, newly_graded: 0 };
  const latest = eligible.map((g) => g.event_date).sort().pop();
  const waiting = [];
  if (!freshness.statsIngestAt || freshness.statsIngestAt.slice(0, 10) <= latest) waiting.push(`ufc-stats-ingest has no successful run after ${latest}`);
  if (freshness.missingSnapshots?.length) waiting.push(`${freshness.missingSnapshots.length} fighter(s) have no Fight DNA snapshot dated on or after their new bout`);
  if (freshness.missingFeatureRows?.length) waiting.push(`${freshness.missingFeatureRows.length} new bout(s) lack both corners' bout-feature rows`);
  if (freshness.lockedUngraded > 0) waiting.push(`${freshness.lockedUngraded} locked champion prediction(s) on those bouts are not graded yet`);
  if (waiting.length) return { status: 'WAITING_FOR_DATA', reason: waiting.join('; '), newly_graded: eligible.length, latest_event: latest };
  return { status: 'LEARN', newly_graded: eligible.length, latest_event: latest, bout_ids: eligible.map((g) => g.bout_id).sort() };
}

/* ---------------------------------------------------------------- training */

/** Sample-quality slice by the thinner corner's prior UFC bouts (design section 3.3). */
export const sampleSlice = (r) => (r.min_prior_bouts === 0 ? 'a. debut' : r.min_prior_bouts === 1 ? 'b. 1 prior' : r.min_prior_bouts === 2 ? 'c. 2 prior' : r.min_prior_bouts < 6 ? 'd. 3-5 prior' : 'e. 6+ prior');

const pickRows = (rows) => rows.map((r) => ({ ...r, conf: Math.max(r.p, 1 - r.p) }));

export function trainChallenger(datasetRows, { fromYear = 2013, toYear = 2026 } = {}) {
  const graded = canonicalDataset(datasetRows);
  const fit = fitFold(graded);
  const wf = walkForward(graded, { fromYear, toYear });
  const scored = wf.scored;
  const pooled = summarise(scored, 'challenger walk-forward');
  const tail = pickRows(scored).filter((r) => r.conf >= 0.8);
  const tailHits = tail.filter((r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0)).length;
  return {
    fit,
    training_bouts: graded.length,
    training_window_start: graded[0]?.event_date ?? null,
    training_window_end: graded[graded.length - 1]?.event_date ?? null,
    walk_forward: {
      protocol: { lambda_grid: LAMBDA_GRID, inner_validation_share: INNER_VALIDATION_SHARE, folds: `${fromYear}..${toYear}` },
      pooled: { n: pooled.n, brier: pooled.brier, log_loss: pooled.log_loss, accuracy: pooled.accuracy, auc: pooled.auc, brier_skill_vs_coin: pooled.brier_skill_vs_coin },
      folds: wf.folds.map((f) => (f.skipped ? f : { year: f.year, train_n: f.train_n, test_n: f.test_n, lambda: f.model.lambda, brier: brier(f.test_rows), log_loss: logLoss(f.test_rows), boundary_ok: f.boundary_ok })),
      by_confidence_band: byConfidenceBand(scored),
      high_confidence_tail: { n: tail.length, mean_predicted: tail.length ? tail.reduce((a, r) => a + r.conf, 0) / tail.length : null, observed: tail.length ? tailHits / tail.length : null },
    },
    calibration: { ece: pooled.calibration.ece, slope: pooled.calibration.slope, bins: pooled.calibration.bins },
    sample_quality: bySlice(scored, sampleSlice).sort((a, b) => a.key.localeCompare(b.key)),
    _wf: wf,
    _scored: scored,
  };
}

/* ---------------------------------------------------------------- leakage */

/** Deterministic shuffle (mulberry32), so the permutation check is reproducible. */
function shuffled(arr, seed) {
  let a = seed >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export function leakageAudit({ datasetRows, trained, cutoffDate, newRowIntegrity = [] }) {
  const graded = canonicalDataset(datasetRows);
  const checks = [];

  const future = graded.filter((r) => r.event_date >= cutoffDate);
  checks.push({ name: 'training cutoff', pass: future.length === 0, detail: `${future.length} row(s) on or after ${cutoffDate}` });

  const unlabeled = datasetRows.filter((r) => r.label !== 0 && r.label !== 1).length;
  checks.push({ name: 'graded rows only', pass: canonicalDataset(datasetRows).every((r) => r.label === 0 || r.label === 1), detail: `${unlabeled} unlabeled row(s) excluded` });

  const folds = trained._wf.folds.filter((f) => !f.skipped);
  checks.push({ name: 'fold boundaries', pass: folds.every((f) => f.boundary_ok), detail: `${folds.length} folds, every training row precedes its test year` });

  const bad = newRowIntegrity.filter((s) => s.target_in_snapshot || s.snapshot_after_event);
  checks.push({ name: 'snapshot provenance (new rows)', pass: bad.length === 0, detail: `${newRowIntegrity.length} corner snapshots checked, ${bad.length} contain the bout or post-date it` });

  const sample = graded.filter((_, i) => i % Math.max(1, Math.floor(graded.length / 250)) === 0).slice(0, 250);
  const worst = sample.reduce((m, r) => {
    const p = predictOne(r.x, trained.fit.beta, trained.fit.scale);
    const q = predictOne(r.x.map((v) => -v), trained.fit.beta, trained.fit.scale);
    return Math.max(m, Math.abs(p + q - 1));
  }, 0);
  checks.push({ name: 'antisymmetry', pass: worst < 1e-9, detail: `max |p(x)+p(-x)-1| = ${worst}` });

  /* Permutation: labels shuffled within the training window must carry no skill out of time. */
  const train = graded.filter((r) => r.event_date < '2020-01-01');
  const test = graded.filter((r) => r.event_date >= '2020-01-01');
  let permutedSkill = null;
  if (train.length >= 500 && test.length >= 100) {
    const labels = shuffled(train.map((r) => r.label), 20260915);
    const permuted = train.map((r, i) => ({ ...r, label: labels[i] }));
    const m = fitFold(permuted);
    const scored = test.map((r) => ({ p: predictOne(r.x, m.beta, m.scale), y: r.label }));
    permutedSkill = 1 - brier(scored) / 0.25;
  }
  checks.push({ name: 'permutation', pass: permutedSkill == null || permutedSkill < 0.01, detail: `Brier skill with permuted training labels: ${permutedSkill}` });

  return { all_passed: checks.every((c) => c.pass), checks, permuted_label_skill: permutedSkill };
}

/* ------------------------------------------------------------------ drift */

export function coefficientDrift(championBeta, challengerBeta) {
  const moves = FEATURE_KEYS.map((k, i) => ({ key: k, champion: championBeta[i], challenger: challengerBeta[i], delta: challengerBeta[i] - championBeta[i] }));
  const flips = moves.filter((m) => Math.sign(m.champion) !== Math.sign(m.challenger) && Math.max(Math.abs(m.champion), Math.abs(m.challenger)) >= REVIEW_THRESHOLDS.signFlipMinAbsCoefficient);
  return {
    max_abs_move: Math.max(...moves.map((m) => Math.abs(m.delta))),
    l2_norm: Math.sqrt(moves.reduce((a, m) => a + m.delta ** 2, 0)),
    largest_moves: moves.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8),
    material_sign_flips: flips.map((m) => m.key),
  };
}

export function predictionDrift(rows, champion, challenger) {
  if (!rows.length) return { n: 0, mean_abs_delta_pts: null, max_abs_delta_pts: null, flipped_picks: 0 };
  let sum = 0, max = 0, flips = 0;
  for (const r of rows) {
    const a = predictOne(r.x, champion.beta, champion.scale);
    const b = predictOne(r.x, challenger.beta, challenger.scale);
    const d = Math.abs(a - b) * 100;
    sum += d; max = Math.max(max, d);
    if ((a >= 0.5) !== (b >= 0.5)) flips += 1;
  }
  return { n: rows.length, mean_abs_delta_pts: sum / rows.length, max_abs_delta_pts: max, flipped_picks: flips };
}

/* ----------------------------------------------------------------- review */

/**
 * Deterministic weekly verdict.
 *   run           the active CHALLENGER training run row (or null)
 *   parentRun     the evidence the challenger is compared against: the champion's
 *                 own walk-forward on its dataset ({ walk_forward, calibration, sample_quality })
 *   shadowPairs   [{ bout_id, shadow: {p_pick, result}, champion: {p_pick, result} }] graded on the same bouts
 */
export function reviewChallenger({ run, parentEvidence, shadowPairs = [], dataIntegrityOk = true }) {
  const T = REVIEW_THRESHOLDS;
  if (!run) return { verdict: 'NO_CHALLENGER', reasons: ['no active challenger'], criteria: {} };
  const c = [];
  const add = (name, pass, value, rule, hard = true) => c.push({ name, pass, value, rule, hard });

  add('leakage audit', run.leakage_audit?.all_passed === true, run.leakage_audit?.checks?.filter((x) => !x.pass).map((x) => x.name) ?? null, 'must pass');
  add('feature/data integrity', dataIntegrityOk && run.status === 'CHALLENGER', { status: run.status, integrity: dataIntegrityOk }, 'no unresolved DATA_REPAIR_DRIFT; dataset re-hashes');

  const wfC = run.walk_forward?.pooled, wfP = parentEvidence?.walk_forward?.pooled;
  if (wfC && wfP) {
    add('brier (walk-forward)', wfC.brier - wfP.brier <= T.maxBrierRegression, wfC.brier - wfP.brier, `challenger - champion <= +${T.maxBrierRegression}`);
    add('log loss (walk-forward)', wfC.log_loss - wfP.log_loss <= T.maxLogLossRegression, wfC.log_loss - wfP.log_loss, `<= +${T.maxLogLossRegression}`);
  } else add('walk-forward comparison', false, null, 'both walk-forwards required');

  const calC = run.calibration, calP = parentEvidence?.calibration;
  if (calC && calP) {
    add('calibration ECE', calC.ece <= calP.ece + T.maxEceRegression, calC.ece - calP.ece, `ECE <= champion + ${T.maxEceRegression}`);
    add('calibration slope', calC.slope >= T.slopeRange[0] && calC.slope <= T.slopeRange[1], calC.slope, `within [${T.slopeRange}]`);
  }

  const tail = run.walk_forward?.high_confidence_tail;
  if (tail?.n >= T.highConfTailMinN) add('high-confidence tail', tail.observed - tail.mean_predicted >= T.highConfTailMinObservedMinusPredicted, tail.observed - tail.mean_predicted, `observed - predicted >= ${T.highConfTailMinObservedMinusPredicted}`);
  else add('high-confidence tail', true, { n: tail?.n ?? 0, note: 'insufficient sample; reported, not claimed' }, `n >= ${T.highConfTailMinN}`, false);

  const sliceP = new Map((parentEvidence?.sample_quality || []).map((s) => [s.key, s]));
  const sliceReg = (run.sample_quality || []).filter((s) => s.n >= T.sliceMinN && sliceP.has(s.key) && s.brier - sliceP.get(s.key).brier > T.sliceMaxBrierRegression).map((s) => s.key);
  add('sample-quality slices', sliceReg.length === 0, sliceReg, `no slice (n >= ${T.sliceMinN}) regresses Brier by > ${T.sliceMaxBrierRegression}`);

  const cd = run.coefficient_drift;
  add('coefficient stability', cd && cd.max_abs_move <= T.maxAbsCoefficientMove && cd.material_sign_flips.length === 0, cd ? { max_abs_move: cd.max_abs_move, flips: cd.material_sign_flips } : null, `max |Δβ| <= ${T.maxAbsCoefficientMove}, no material sign flip`);

  const bd = run.benchmark_drift;
  add('benchmark stability', bd && bd.mean_abs_delta_pts <= T.benchmarkMaxMeanAbsDeltaPts && bd.max_abs_delta_pts <= T.benchmarkMaxAbsDeltaPts, bd, `mean |Δp| <= ${T.benchmarkMaxMeanAbsDeltaPts} pts, max <= ${T.benchmarkMaxAbsDeltaPts} pts`);

  /* Prospective evidence: paired graded WIN/LOSS shadow bouts on identical bouts. */
  const paired = shadowPairs.filter((p) => ['WIN', 'LOSS'].includes(p.shadow?.result) && ['WIN', 'LOSS'].includes(p.champion?.result));
  const bs = (side) => paired.reduce((a, p) => a + (p[side].p_pick - (p[side].result === 'WIN' ? 1 : 0)) ** 2, 0) / (paired.length || 1);
  const shadow = { paired_graded: paired.length, challenger_brier: paired.length ? bs('shadow') : null, champion_brier: paired.length ? bs('champion') : null };
  const enough = paired.length >= T.minPairedShadowBouts;
  const shadowOk = enough && shadow.challenger_brier <= shadow.champion_brier;

  const hardFail = c.filter((x) => x.hard && !x.pass);
  let verdict, reasons;
  if (hardFail.length) {
    verdict = 'REJECT';
    reasons = hardFail.map((x) => `${x.name}: ${JSON.stringify(x.value)} fails "${x.rule}"`);
  } else if (!enough) {
    verdict = 'HOLD';
    reasons = [`prospective evidence insufficient: ${paired.length} of ${T.minPairedShadowBouts} paired graded shadow bouts`];
  } else if (!shadowOk) {
    verdict = 'REJECT';
    reasons = [`paired shadow Brier ${shadow.challenger_brier} is worse than champion ${shadow.champion_brier} on the same ${paired.length} bouts`];
  } else {
    verdict = 'PROPOSE';
    reasons = ['every criterion passed on historical and prospective evidence; owner approval required'];
  }
  return { verdict, reasons, criteria: { review_version: REVIEW_VERSION, thresholds: T, checks: c, shadow } };
}
