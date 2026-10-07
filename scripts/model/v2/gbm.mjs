// Antisymmetric gradient-boosted trees, for the V2 nonlinear candidate. PURE.
//
// A tree ensemble has no natural antisymmetry, so it is imposed twice:
//   1. training data is augmented with every row's mirror (-x, 1-y), so the
//      ensemble F is fitted to a corner-symmetric problem;
//   2. the served score is f(x) = (F(x) - F(-x)) / 2, which is exactly odd, so
//      p(x) + p(-x) = 1 to floating-point precision whatever F learned.
// No intercept survives step 2, so the 93.5%-winner-listed-first artifact
// (METHODOLOGY.md section 2) cannot be learned either.
//
// Deterministic: quantile bins, no row or column sampling, fixed tie order.

import { sigmoid } from '../logistic.mjs';

export const GBM_DEFAULTS = Object.freeze({ depth: 3, minLeaf: 60, bins: 24, learningRate: 0.05, maxTrees: 400, l2: 5 });

function quantileEdges(values, bins) {
  const v = Float64Array.from(values).sort();
  const edges = [];
  for (let b = 1; b < bins; b++) {
    const e = v[Math.floor((b * v.length) / bins)];
    if (!edges.length || e > edges[edges.length - 1]) edges.push(e);
  }
  return edges;
}
const binOf = (edges, x) => { let lo = 0, hi = edges.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x <= edges[m]) hi = m; else lo = m + 1; } return lo; };

/** Fit F on mirrored data. Returns trees; `validate` optionally tracks validation log loss per tree. */
export function fitGbm(X, y, opts = {}, validate = null) {
  const o = { ...GBM_DEFAULTS, ...opts };
  const d = X[0].length;
  const rows = [], ys = [];
  for (let i = 0; i < X.length; i++) { rows.push(X[i]); ys.push(y[i]); rows.push(X[i].map((v) => -v)); ys.push(1 - y[i]); }
  const n = rows.length;
  const edges = Array.from({ length: d }, (_, j) => quantileEdges(rows.map((r) => r[j]), o.bins));
  const B = Array.from({ length: d }, (_, j) => Uint8Array.from(rows.map((r) => binOf(edges[j], r[j]))));
  const F = new Float64Array(n);
  const trees = [];
  const valTrace = [];
  let valF = validate ? new Float64Array(validate.X.length) : null;

  for (let t = 0; t < o.maxTrees; t++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = ys[i] - p; h[i] = Math.max(p * (1 - p), 1e-6); }
    const tree = growTree(B, edges, g, h, Uint32Array.from({ length: n }, (_, i) => i), o, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += o.learningRate * evalTreeBinned(tree, B, i);
    if (validate) {
      let ll = 0;
      for (let i = 0; i < validate.X.length; i++) {
        valF[i] += o.learningRate * (evalTree(tree, validate.X[i]) - evalTree(tree, validate.X[i].map((v) => -v))) / 2;
        const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(valF[i])));
        ll += validate.y[i] ? -Math.log(p) : -Math.log(1 - p);
      }
      valTrace.push(ll / validate.X.length);
    }
  }
  return { trees, learningRate: o.learningRate, valTrace };
}

function growTree(B, edges, g, h, idx, o, depth) {
  let G = 0, H = 0;
  for (const i of idx) { G += g[i]; H += h[i]; }
  const leaf = { leaf: G / (H + o.l2) };
  if (depth >= o.depth || idx.length < 2 * o.minLeaf) return leaf;
  const parentGain = (G * G) / (H + o.l2);
  let best = null;
  for (let j = 0; j < B.length; j++) {
    const nb = edges[j].length + 1;
    const gs = new Float64Array(nb), hs = new Float64Array(nb), cs = new Uint32Array(nb);
    const bj = B[j];
    for (const i of idx) { gs[bj[i]] += g[i]; hs[bj[i]] += h[i]; cs[bj[i]] += 1; }
    let gl = 0, hl = 0, cl = 0;
    for (let b = 0; b < nb - 1; b++) {
      gl += gs[b]; hl += hs[b]; cl += cs[b];
      const cr = idx.length - cl;
      if (cl < o.minLeaf || cr < o.minLeaf) continue;
      const gr = G - gl, hr = H - hl;
      const gain = (gl * gl) / (hl + o.l2) + (gr * gr) / (hr + o.l2) - parentGain;
      if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, j, b };
    }
  }
  if (!best) return leaf;
  const left = [], right = [];
  for (const i of idx) (B[best.j][i] <= best.b ? left : right).push(i);
  return {
    j: best.j, threshold: edges[best.j][best.b], bin: best.b,
    l: growTree(B, edges, g, h, Uint32Array.from(left), o, depth + 1),
    r: growTree(B, edges, g, h, Uint32Array.from(right), o, depth + 1),
  };
}

function evalTreeBinned(t, B, i) { while (t.leaf === undefined) t = B[t.j][i] <= t.bin ? t.l : t.r; return t.leaf; }
export function evalTree(t, x) { while (t.leaf === undefined) t = x[t.j] <= t.threshold ? t.l : t.r; return t.leaf; }

/** Exactly antisymmetric score: (F(x) - F(-x)) / 2. */
export function gbmScore(model, x, nTrees = model.trees.length) {
  const neg = x.map((v) => -v);
  let s = 0;
  for (let t = 0; t < nTrees; t++) s += evalTree(model.trees[t], x) - evalTree(model.trees[t], neg);
  return (model.learningRate * s) / 2;
}
export const gbmPredict = (model, x, nTrees) => sigmoid(gbmScore(model, x, nTrees));
