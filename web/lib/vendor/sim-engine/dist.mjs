// Sampling distributions over the engine's RNG.
//
// Counts use INVERSION sampling wherever practical (Poisson, binomial): the
// sampled value is a monotone function of a single uniform, which keeps common
// random numbers meaningful during the anchor search (a small change in the
// mean moves a count by at most one at the margin instead of re-rolling it).
// Gamma uses Marsaglia-Tsang, which is not monotone but is only used for
// dispersion and control time.

export function uniform(rng) { return rng.nextFloat(); }

export function normal(rng) {
  let u1 = rng.nextFloat();
  if (u1 < 1e-300) u1 = 1e-300;
  const u2 = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape k, scale theta). */
export function gamma(rng, k, theta = 1) {
  if (!(k > 0) || !(theta > 0)) return 0;
  if (k < 1) {
    const u = rng.nextFloat();
    return gamma(rng, k + 1, theta) * Math.pow(u < 1e-300 ? 1e-300 : u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng.nextFloat();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * theta;
    if (Math.log(u < 1e-300 ? 1e-300 : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * theta;
  }
}

/** Poisson by inversion (monotone in the uniform). Means above 400 are clamped. */
export function poisson(rng, lambda) {
  if (!(lambda > 0)) return 0;
  const lam = lambda > 400 ? 400 : lambda;
  const u = rng.nextFloat();
  let k = 0;
  let p = Math.exp(-lam);
  let cdf = p;
  while (u > cdf && k < 2000) {
    k++;
    p *= lam / k;
    cdf += p;
    if (p < 1e-18 && k > lam) break;
  }
  return k;
}

/** Binomial(n, p) by inversion (monotone in the uniform). */
export function binomial(rng, n, p) {
  n = Math.max(0, Math.floor(n));
  if (n === 0) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return n;
  const u = rng.nextFloat();
  const q = 1 - p;
  let k = 0;
  let pk = Math.pow(q, n);
  let cdf = pk;
  while (u > cdf && k < n) {
    pk *= ((n - k) / (k + 1)) * (p / q);
    k++;
    cdf += pk;
    if (!(pk > 0)) break;
  }
  return k;
}

/** Negative binomial as gamma-Poisson: mean `mean`, dispersion `k` (variance = mean + mean^2/k). */
export function negbin(rng, mean, k) {
  if (!(mean > 0)) return 0;
  if (!(k > 0) || k > 1e6) return poisson(rng, mean);
  const rate = gamma(rng, k, mean / k);
  return poisson(rng, rate);
}

/** Index sampled proportionally to non-negative weights; returns -1 when all weights are zero. */
export function categorical(rng, weights) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  const u = rng.nextFloat() * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] > 0 ? weights[i] : 0;
    if (u < acc) return i;
  }
  return weights.length - 1;
}

/** Split `n` items across categories with the given shares (sequential binomials; deterministic order). */
export function multinomial(rng, n, shares) {
  const out = new Array(shares.length).fill(0);
  let remaining = n;
  let remainingShare = shares.reduce((a, s) => a + (s > 0 ? s : 0), 0);
  for (let i = 0; i < shares.length - 1; i++) {
    if (remaining <= 0 || !(remainingShare > 0)) break;
    const p = (shares[i] > 0 ? shares[i] : 0) / remainingShare;
    const x = binomial(rng, remaining, p);
    out[i] = x;
    remaining -= x;
    remainingShare -= shares[i] > 0 ? shares[i] : 0;
  }
  out[shares.length - 1] = remaining > 0 ? remaining : 0;
  return out;
}
