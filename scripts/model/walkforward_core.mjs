// Training and walk-forward validation core. PURE: no fs, no env, no clock.
//
// One implementation shared by the Node release/backtest scripts and the
// Cloudflare daily learning run (workers/ufc-algo), so a challenger trained in
// the Worker is produced by exactly the recipe that produced V1's evidence:
// ridge logistic, no intercept, lambda from an inner chronological split,
// expanding window refit per calendar year.
//
// Deterministic: identical rows in identical order give identical
// coefficients, scale, lambda and spec hash.

import { fitLogistic, fitScale, applyScale, predictOne } from './logistic.mjs';
import { logLoss } from './metrics.mjs';

export const LAMBDA_GRID = [1, 2, 5, 10, 20, 40, 80, 160, 320];
export const INNER_VALIDATION_SHARE = 0.2;

/** Canonical training order: event_date, then bout_id. */
export const trainingOrder = (a, b) => (a.event_date === b.event_date ? a.bout_id.localeCompare(b.bout_id) : a.event_date.localeCompare(b.event_date));

export function fitFold(trainRows, { lambdaGrid = LAMBDA_GRID } = {}) {
  const cut = Math.max(1, Math.floor(trainRows.length * (1 - INNER_VALIDATION_SHARE)));
  const inner = trainRows.slice(0, cut);
  const holdout = trainRows.slice(cut);

  let chosen = lambdaGrid[Math.floor(lambdaGrid.length / 2)];
  const lambdaScan = [];
  if (holdout.length >= 50 && inner.length >= 200) {
    const scaleInner = fitScale(inner.map((r) => r.x));
    const Xi = inner.map((r) => applyScale(r.x, scaleInner));
    const yi = inner.map((r) => r.label);
    let best = Infinity;
    for (const lambda of lambdaGrid) {
      const { beta } = fitLogistic(Xi, yi, lambda);
      const scored = holdout.map((r) => ({ p: predictOne(r.x, beta, scaleInner), y: r.label }));
      const ll = logLoss(scored);
      lambdaScan.push({ lambda, validation_log_loss: ll });
      if (ll < best) { best = ll; chosen = lambda; }
    }
  }

  const scale = fitScale(trainRows.map((r) => r.x));
  const X = trainRows.map((r) => applyScale(r.x, scale));
  const y = trainRows.map((r) => r.label);
  const fit = fitLogistic(X, y, chosen);
  return { beta: fit.beta, scale, lambda: chosen, lambdaScan, iterations: fit.iterations, converged: fit.converged, n: trainRows.length };
}

/**
 * Chronological walk-forward. `graded` must already be in trainingOrder.
 * For each calendar year, train on everything strictly before Jan 1 and score
 * that year. Returns the fold models and the out-of-sample (p, y) rows; the
 * caller decides what extra columns to carry via `rowFor`.
 */
export function walkForward(graded, { fromYear = 2013, toYear = 2026, rowFor = null } = {}) {
  const folds = [];
  const scored = [];
  for (let year = fromYear; year <= toYear; year++) {
    const boundary = `${year}-01-01`;
    const nextBoundary = `${year + 1}-01-01`;
    const train = graded.filter((r) => r.event_date < boundary);
    const test = graded.filter((r) => r.event_date >= boundary && r.event_date < nextBoundary);
    if (test.length < 25 || train.length < 500) {
      folds.push({ year, skipped: true, train_n: train.length, test_n: test.length });
      continue;
    }
    const model = fitFold(train);
    const rows = test.map((r) => {
      const p = predictOne(r.x, model.beta, model.scale);
      return rowFor ? rowFor(r, p, year) : { bout_id: r.bout_id, event_date: r.event_date, fold_year: year, min_prior_bouts: r.min_prior_bouts, available_count: r.available_count, p, y: r.label };
    });
    scored.push(...rows);
    folds.push({
      year, model, test_rows: rows,
      train_n: train.length, train_from: train[0]?.event_date ?? null, train_to: train[train.length - 1]?.event_date ?? null,
      test_n: test.length,
      /* Boundary evidence for the leakage audit: every training row precedes every test row. */
      boundary_ok: (train[train.length - 1]?.event_date ?? '') < (test[0]?.event_date ?? '￿'),
    });
  }
  return { folds, scored };
}
