// Deterministic generalised linear model fitting: Newton / Fisher scoring
// with a small ridge penalty, a deterministic backtracking line search on
// the penalised deviance, a fixed iteration budget and a Cholesky solve. No
// randomness, no early-stopping heuristics: the same rows in the same order
// give the same coefficients to the last bit.
//
// Families: poisson (log link, offset), binomial (logit; trials n), cloglog
// (binary, complementary log-log with offset: hazard models), gamma (log link,
// dispersion by moments). Negative-binomial dispersion k is estimated by the
// method of moments on the fitted Poisson means.

export function cholSolve(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 1e-12) s = 1e-12; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

const clampExp = (eta) => Math.exp(Math.min(30, Math.max(-30, eta)));

/** Per-row unit deviance and score/weight for one family at linear predictor eta. */
function rowTerms(family, eta, yi, ni) {
  if (family === 'poisson') {
    const mu = clampExp(eta);
    return { dev: 2 * ((yi > 0 ? yi * Math.log(yi / mu) : 0) - (yi - mu)), score: yi - mu, w: mu };
  }
  if (family === 'binomial') {
    const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
    const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
    const mu = ni * pc;
    const dev = 2 * ((yi > 0 ? yi * Math.log(yi / mu) : 0) + (ni - yi > 0 ? (ni - yi) * Math.log((ni - yi) / (ni - mu)) : 0));
    return { dev, score: yi - mu, w: ni * pc * (1 - pc) };
  }
  if (family === 'cloglog') {
    const e = clampExp(eta);
    const p = 1 - Math.exp(-e);
    const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
    const dp = e * Math.exp(-e); // dp/deta
    const dev = -2 * (yi ? Math.log(pc) : Math.log(1 - pc));
    return { dev, score: ((yi - pc) * dp) / (pc * (1 - pc)), w: (dp * dp) / (pc * (1 - pc)) };
  }
  if (family === 'gamma') {
    const mu = clampExp(eta);
    return { dev: 2 * (-Math.log(yi / mu) + (yi - mu) / mu), score: (yi - mu) / mu, w: 1 };
  }
  throw new Error('unknown family ' + family);
}

/**
 * @param {object} o
 * @param {number[][]} o.X   rows of features (first column should be the intercept 1)
 * @param {number[]} o.y     response (counts, successes, 0/1, or positive reals)
 * @param {number[]} [o.n]   binomial trials
 * @param {number[]} [o.offset] log offset per row
 * @param {'poisson'|'binomial'|'cloglog'|'gamma'} o.family
 * @param {number} [o.ridge=1e-3] penalty on non-intercept coefficients
 * @param {number} [o.iterations=50]
 */
export function fitGlm(o) {
  const { X, y, family } = o;
  const N = X.length, P = X[0].length;
  const n = o.n || null, off = o.offset || null;
  const ridge = o.ridge ?? 1e-3, iters = o.iterations ?? 50;
  const eta0 = (beta, i) => { let e = off ? off[i] : 0; for (let j = 0; j < P; j++) e += beta[j] * X[i][j]; return e; };
  const penalised = (beta) => { let d = 0; for (let i = 0; i < N; i++) d += rowTerms(family, eta0(beta, i), y[i], n ? n[i] : 1).dev; for (let j = 1; j < P; j++) d += ridge * beta[j] * beta[j]; return d; };

  let beta = new Float64Array(P);
  const meanOff = off ? off.reduce((a, v) => a + v, 0) / N : 0;
  const meanY = y.reduce((a, v, i) => a + v / (n ? Math.max(1, n[i]) : 1), 0) / N;
  if (family === 'poisson' || family === 'gamma') beta[0] = Math.log(Math.max(1e-6, meanY)) - meanOff;
  else if (family === 'binomial') beta[0] = Math.log(Math.max(1e-6, meanY) / Math.max(1e-6, 1 - meanY));
  else if (family === 'cloglog') beta[0] = Math.log(-Math.log(Math.max(1e-9, 1 - Math.min(0.999, meanY)))) - meanOff;

  let dev = penalised(beta);
  let converged = false, it = 0;
  for (; it < iters; it++) {
    const H = Array.from({ length: P }, () => new Float64Array(P));
    const g = new Float64Array(P);
    for (let i = 0; i < N; i++) {
      const x = X[i];
      const t = rowTerms(family, eta0(beta, i), y[i], n ? n[i] : 1);
      for (let j = 0; j < P; j++) { g[j] += x[j] * t.score; for (let k = 0; k <= j; k++) H[j][k] += t.w * x[j] * x[k]; }
    }
    for (let j = 0; j < P; j++) { for (let k = 0; k < j; k++) H[k][j] = H[j][k]; if (j > 0) { H[j][j] += ridge; g[j] -= ridge * beta[j]; } }
    const step = cholSolve(H, g);
    // Backtracking line search on the penalised deviance (deterministic halving, at most 12 tries).
    let scale = 1, accepted = false, newDev = dev, cand = null;
    for (let tries = 0; tries < 12; tries++) {
      cand = beta.map((b, j) => b + scale * step[j]);
      newDev = penalised(cand);
      if (Number.isFinite(newDev) && newDev <= dev + 1e-9) { accepted = true; break; }
      scale /= 2;
    }
    if (!accepted) break;
    const maxMove = Math.max(...step.map((s) => Math.abs(s * scale)));
    beta = Float64Array.from(cand);
    const improved = dev - newDev;
    dev = newDev;
    if (maxMove < 1e-8 || improved < 1e-10 * Math.max(1, Math.abs(dev))) { converged = true; break; }
  }
  const result = { beta: Array.from(beta).map((v) => Math.round(v * 1e6) / 1e6), deviance: dev, n: N, p: P, family, iterations: it + 1, converged };
  if (family === 'gamma') {
    let s = 0;
    for (let i = 0; i < N; i++) { const mu = clampExp(eta0(beta, i)); s += ((y[i] - mu) / mu) ** 2; }
    result.shape = Math.round(Math.max(0.2, Math.min(20, (N - P) / Math.max(1e-9, s))) * 1e4) / 1e4;
  }
  return result;
}

/** Negative-binomial dispersion k by moments: var = mu + mu^2/k  ->  k = sum(mu^2) / sum((y-mu)^2 - mu). */
export function nbDispersion(X, y, beta, offset = null) {
  let num = 0, den = 0;
  for (let i = 0; i < X.length; i++) {
    let eta = offset ? offset[i] : 0;
    for (let j = 0; j < beta.length; j++) eta += beta[j] * X[i][j];
    const mu = clampExp(eta);
    num += mu * mu; den += (y[i] - mu) ** 2 - mu;
  }
  const k = den > 0 ? num / den : 1e6;
  return Math.round(Math.max(0.05, Math.min(1e6, k)) * 1e4) / 1e4;
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))));
