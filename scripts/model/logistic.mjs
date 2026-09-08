// Deterministic ridge logistic regression, no dependencies.
//
// Fitted by Newton-Raphson (IRLS) with a Cholesky solve. Thirty-three features
// makes the Hessian a 33x33 matrix, so the exact second-order method is both
// affordable and reproducible to the last bit - there is no random
// initialisation, no shuffling, and no early-stopping heuristic that could make
// two runs of the same data disagree. Re-running the backtest must produce
// byte-identical numbers or the result is not evidence of anything.
//
// NO INTERCEPT, AND NO MEAN-CENTRING
// ----------------------------------
// The feature vector is antisymmetric: swapping the two corners negates it.
// An intercept, or subtracting a per-feature mean, would break that - the
// negated vector would no longer produce the complementary probability. So the
// only scaling applied is division by the root-mean-square of each feature over
// the training fold, which commutes with negation. Features are already
// differences centred on zero by construction, so RMS is the right scale
// measure; using a variance about a fitted mean would reintroduce the very
// offset being avoided.

export const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Per-feature RMS over the training rows. Zero-variance columns get scale 1
 *  so the column simply contributes nothing rather than producing a NaN. */
export function fitScale(X) {
  const d = X[0]?.length ?? 0;
  const scale = new Array(d).fill(1);
  if (!X.length) return scale;
  for (let j = 0; j < d; j++) {
    let ss = 0;
    for (let i = 0; i < X.length; i++) ss += X[i][j] * X[i][j];
    const rms = Math.sqrt(ss / X.length);
    scale[j] = rms > 1e-9 ? rms : 1;
  }
  return scale;
}

export const applyScale = (x, scale) => x.map((v, j) => v / scale[j]);

/** Cholesky solve of A b = r for symmetric positive definite A. */
function cholSolve(A, r) {
  const n = r.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return null; // not positive definite; caller falls back
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = r[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const b = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * b[k];
    b[i] = s / L[i][i];
  }
  return b;
}

/**
 * @param {number[][]} X  scaled design matrix
 * @param {number[]}   y  labels in {0,1}
 * @param {number}     lambda  L2 penalty on the scaled coefficients
 */
export function fitLogistic(X, y, lambda, { maxIter = 60, tol = 1e-9 } = {}) {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const beta = new Float64Array(d);
  if (!n || !d) return { beta: Array.from(beta), iterations: 0, converged: true, logLik: 0 };

  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    const H = Array.from({ length: d }, () => new Float64Array(d));
    const g = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = 0;
      for (let j = 0; j < d; j++) z += beta[j] * xi[j];
      const p = sigmoid(z);
      // Floor the IRLS weight: a saturated row otherwise contributes an exactly
      // singular row block and the Cholesky fails on data it should handle.
      const w = Math.max(p * (1 - p), 1e-8);
      const resid = y[i] - p;
      for (let j = 0; j < d; j++) {
        g[j] += resid * xi[j];
        const wxij = w * xi[j];
        for (let k = 0; k <= j; k++) H[j][k] += wxij * xi[k];
      }
    }
    for (let j = 0; j < d; j++) {
      g[j] -= 2 * lambda * beta[j];
      H[j][j] += 2 * lambda;
      for (let k = 0; k < j; k++) H[k][j] = H[j][k];
    }
    const step = cholSolve(H, g);
    if (!step) break;
    let delta = 0;
    for (let j = 0; j < d; j++) { beta[j] += step[j]; delta = Math.max(delta, Math.abs(step[j])); }
    if (delta < tol) { converged = true; iterations += 1; break; }
  }

  let logLik = 0;
  for (let i = 0; i < n; i++) {
    let z = 0;
    for (let j = 0; j < d; j++) z += beta[j] * X[i][j];
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
    logLik += y[i] ? Math.log(p) : Math.log(1 - p);
  }
  return { beta: Array.from(beta), iterations, converged, logLik };
}

/** Probability that canonical corner one wins, from an UNSCALED feature row. */
export function predictOne(x, beta, scale) {
  let z = 0;
  for (let j = 0; j < beta.length; j++) z += beta[j] * (x[j] / scale[j]);
  return sigmoid(z);
}
