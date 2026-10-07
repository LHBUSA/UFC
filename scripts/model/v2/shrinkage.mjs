// Evidence-aware probability shrinkage (V2 candidate 1). PURE.
//
// V1 caps the confidence LABEL on thin samples but lets the probability itself
// run. This layer learns how far a base model's logit should be trusted as a
// function of how much evidence stands behind it:
//
//   p' = sigmoid( z * m(q) ),   m(q) = c0 + c1*phi1 + c2*phi2 + c3*phi3
//
//   z     base model logit (antisymmetric)
//   phi1  1 / (1 + min prior UFC bouts)        - thin record
//   phi2  1 / (1 + min stat-covered bouts)     - thin round-stat sample
//   phi3  share of features unavailable        - missing inputs
//
// m(q) is symmetric in the corners, so p'(x) + p'(-x) = 1 still holds exactly.
// It is linear in c, so fitting it is a no-intercept logistic regression on the
// four columns z*phi_k: deterministic and convex. m(q) < 1 shrinks toward 50%.
//
// The coefficients are fitted ONLY on walk-forward out-of-sample predictions
// from years before the year being scored. No live call is ever used, and no
// cap is hand-picked.

import { fitLogistic, sigmoid } from '../logistic.mjs';

export const SHRINK_LAMBDA = 1;
export const phis = (r) => [1, 1 / (1 + r.min_prior_bouts), 1 / (1 + r.min_stat_bouts), 1 - r.available_count / r.features_total];

const logit = (p) => Math.log(Math.min(1 - 1e-12, Math.max(1e-12, p)) / (1 - Math.min(1 - 1e-12, Math.max(1e-12, p))));

/** @param oof [{ p, y, min_prior_bouts, min_stat_bouts, available_count, features_total }] */
export function fitShrinkage(oof) {
  if (oof.length < 300) return null;
  const X = oof.map((r) => { const z = logit(r.p); return phis(r).map((f) => z * f); });
  const y = oof.map((r) => r.y);
  /* Ridge pulls c toward zero, i.e. toward 50%; the base logit already carries c0 ~ 1, so a tiny penalty suffices. */
  const { beta } = fitLogistic(X, y, SHRINK_LAMBDA);
  return { c: beta, n: oof.length };
}

export const multiplier = (shr, r) => (shr ? phis(r).reduce((a, f, k) => a + shr.c[k] * f, 0) : 1);
export const applyShrinkage = (shr, p, r) => (shr ? sigmoid(logit(p) * multiplier(shr, r)) : p);
