// Scoring for the PBE Fight Model.
//
// Brier and log loss lead because they are proper scoring rules: they are
// minimised only by the true probability, so a model cannot improve them by
// being confidently wrong in a way that flatters accuracy. Accuracy is reported
// because people ask for it, but it is deliberately not the headline - a fight
// model that says 51% and is right is not the same product as one that says 80%
// and is right, and accuracy cannot tell them apart.

const EPS = 1e-12;
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));

export const brier = (rows) => rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / (rows.length || 1);

export const logLoss = (rows) =>
  -rows.reduce((a, r) => a + (r.y ? Math.log(clip(r.p)) : Math.log(1 - clip(r.p))), 0) / (rows.length || 1);

export const accuracy = (rows) => {
  // A prediction of exactly 0.5 is not a pick. Counting it as a win half the
  // time is the only honest treatment and it matters for the coin baseline,
  // where every row is exactly 0.5.
  const hits = rows.reduce((a, r) => a + (r.p === 0.5 ? 0.5 : (r.p > 0.5) === (r.y === 1) ? 1 : 0), 0);
  return hits / (rows.length || 1);
};

/** Area under the ROC curve, by rank, with ties averaged. */
export function auc(rows) {
  const pos = rows.filter((r) => r.y === 1).length;
  const neg = rows.length - pos;
  if (!pos || !neg) return null;
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const ranks = new Array(sorted.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].y === 1) sumPos += ranks[i];
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Skill against a reference score. Positive means better than the reference. */
export const skill = (score, reference) => (reference > 0 ? 1 - score / reference : null);

/**
 * Calibration over the confidence half-line. Both corners of a bout are the
 * same prediction stated two ways, so binning raw p would double count and
 * produce a mirror-symmetric plot that says nothing. Instead each row is folded
 * to the side the model actually picked: confidence = max(p, 1-p), hit = did
 * that pick win.
 */
export function calibration(rows, edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 1.0001]) {
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inBin = rows.filter((r) => {
      const c = Math.max(r.p, 1 - r.p);
      return c >= lo && c < hi;
    });
    const hits = inBin.filter((r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0)).length;
    bins.push({
      lo: Number(lo.toFixed(4)),
      hi: Number(Math.min(hi, 1).toFixed(4)),
      n: inBin.length,
      predicted: inBin.length ? inBin.reduce((a, r) => a + Math.max(r.p, 1 - r.p), 0) / inBin.length : null,
      observed: inBin.length ? hits / inBin.length : null,
      hits,
    });
  }
  const n = rows.length || 1;
  const ece = bins.reduce((a, b) => (b.n ? a + (b.n / n) * Math.abs(b.predicted - b.observed) : a), 0);
  // Slope of observed on predicted through the bins, weighted by bin size. A
  // slope below one is the classic overconfidence signature.
  const used = bins.filter((b) => b.n > 0);
  let slope = null;
  if (used.length >= 2) {
    const wsum = used.reduce((a, b) => a + b.n, 0);
    const mx = used.reduce((a, b) => a + b.n * b.predicted, 0) / wsum;
    const my = used.reduce((a, b) => a + b.n * b.observed, 0) / wsum;
    const sxy = used.reduce((a, b) => a + b.n * (b.predicted - mx) * (b.observed - my), 0);
    const sxx = used.reduce((a, b) => a + b.n * (b.predicted - mx) ** 2, 0);
    slope = sxx > 1e-12 ? sxy / sxx : null;
  }
  return { bins, ece, slope };
}

export function summarise(rows, label) {
  const b = brier(rows);
  return {
    label,
    n: rows.length,
    brier: b,
    log_loss: logLoss(rows),
    accuracy: accuracy(rows),
    auc: auc(rows),
    brier_skill_vs_coin: skill(b, 0.25),
    calibration: calibration(rows),
  };
}

/** Slice a scored set by a key function and summarise each group. */
export function bySlice(rows, keyFn, { minN = 1 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length >= minN)
    .map(([k, v]) => ({
      key: k,
      n: v.length,
      brier: brier(v),
      log_loss: logLoss(v),
      accuracy: accuracy(v),
      auc: auc(v),
      brier_skill_vs_coin: skill(brier(v), 0.25),
    }))
    .sort((a, b) => b.n - a.n);
}

/**
 * Confidence bands, folded to the picked side exactly as calibration is.
 * `hit_rate` here is the number a reader of a tracker page cares about: of the
 * fights where the model claimed this much confidence, how many did the pick
 * win.
 */
export function byConfidenceBand(rows, edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.0001]) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inBand = rows.filter((r) => {
      const c = Math.max(r.p, 1 - r.p);
      return c >= lo && c < hi;
    });
    const hits = inBand.filter((r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0)).length;
    out.push({
      // No percent sign: this string is the band KEY and has to match the
      // confidence_band values the prediction table constrains, so that a live
      // band and a backtest band are the same label rather than two spellings.
      band: `${(lo * 100).toFixed(0)}-${(Math.min(hi, 1) * 100).toFixed(0)}`,
      lo, hi: Math.min(hi, 1),
      n: inBand.length,
      hits,
      hit_rate: inBand.length ? hits / inBand.length : null,
      mean_confidence: inBand.length ? inBand.reduce((a, r) => a + Math.max(r.p, 1 - r.p), 0) / inBand.length : null,
      brier: inBand.length ? brier(inBand) : null,
    });
  }
  return out;
}

/**
 * Wilson score interval. Reported beside every hit rate because a 62% hit rate
 * over 40 fights and over 400 fights are different claims, and a tracker that
 * shows only the point estimate invites the reader to confuse them.
 */
export function wilson(hits, n, z = 1.96) {
  if (!n) return null;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: (centre - margin) / denom, hi: (centre + margin) / denom };
}
