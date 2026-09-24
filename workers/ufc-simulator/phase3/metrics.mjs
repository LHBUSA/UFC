// Scoring rules and summaries for the Phase 3 report.

export const brier = (p, y) => (p - y) ** 2;
export const logloss = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const mae = (pairs) => mean(pairs.map(([p, y]) => Math.abs(p - y)));
export const rmse = (pairs) => { const m = mean(pairs.map(([p, y]) => (p - y) ** 2)); return m == null ? null : Math.sqrt(m); };
export const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
export const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e2) / 1e2);

export function quantiles(xs, qs = [0.5, 0.75, 0.9, 0.95, 1]) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, null]));
  const at = (q) => { const pos = (s.length - 1) * q; const lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
  return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, r4(at(q))]));
}

/** Expected calibration error with equal-width bins on p, plus the reliability table. */
export function calibration(rows, bins = 10) {
  const table = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [p, y] of rows) { const b = Math.min(bins - 1, Math.floor(p * bins)); table[b].n++; table[b].p += p; table[b].y += y; }
  let ece = 0;
  const out = table.map((t, i) => { const n = t.n; if (n) ece += (n / rows.length) * Math.abs(t.y / n - t.p / n); return { bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n, mean_p: n ? r4(t.p / n) : null, observed: n ? r4(t.y / n) : null }; });
  return { ece: r4(ece), table: out };
}

/** Multiclass log loss over method classes given a probability object and the true class. */
export function multiLogLoss(probs, truth) { const q = Math.min(1 - 1e-6, Math.max(1e-6, probs[truth] ?? 0)); return -Math.log(q); }

/** CRPS for a discrete distribution over ordered categories (rounds 1..R), truth as an index. */
export function crpsDiscrete(pmf, truthIdx) {
  let cdf = 0, s = 0;
  for (let i = 0; i < pmf.length; i++) { cdf += pmf[i]; const h = i >= truthIdx ? 1 : 0; s += (cdf - h) ** 2; }
  return s;
}

export function summarizeBinary(rows) {
  if (!rows.length) return { n: 0 };
  const c = calibration(rows);
  return { n: rows.length, brier: r4(mean(rows.map(([p, y]) => brier(p, y)))), logloss: r4(mean(rows.map(([p, y]) => logloss(p, y)))), accuracy: r4(mean(rows.map(([p, y]) => ((p >= 0.5 ? 1 : 0) === y ? 1 : 0)))), base_rate: r4(mean(rows.map(([, y]) => y))), mean_p: r4(mean(rows.map(([p]) => p))), ece: c.ece, reliability: c.table };
}

export function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
