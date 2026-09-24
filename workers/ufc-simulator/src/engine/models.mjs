// Component models of the round engine: ONE definition of every feature
// vector, used both by the Phase 3 fitter (on observed rounds) and by the
// simulator (on simulated state). If the fitter and the engine ever computed
// features differently, the fitted coefficients would be meaningless; sharing
// this module is the guarantee.
//
// Each component: name, family, offset rule, and a feature function over
// (attacker profile s, defender profile o, attacker state, defender state,
// round number r, within-round values v). The intercept is always x[0] = 1.
// Coefficients live in params.models[name].beta (+ k for negative binomial,
// shape for gamma). Rate inputs enter as log(rate + eps) so a zero rate is
// finite; probabilities enter as logits.

const EPS = 0.05;
export const lg = (v) => Math.log(Math.max(0, v) + EPS);
export const lgt = (p) => { const q = Math.max(1e-4, Math.min(1 - 1e-4, p)); return Math.log(q / (1 - q)); };

export const COMPONENTS = {
  // Significant strike attempts per round. NB, offset log(L/60).
  att: { family: 'negbin', offset: (L) => Math.log(L / 60), names: ['1', 'log_dna_att_r', 'log_opp_dna_att_r', 'absorbed_cum', 'kd_taken', 'r2', 'r3plus', 'r4plus'],
    x: (s, o, st, ot, r) => [1, lg(s.att_rate[Math.min(r, s.att_rate.length) - 1]), lg(o.att_rate[Math.min(r, o.att_rate.length) - 1]), st.absorbed / 100, st.kdTaken, r === 2 ? 1 : 0, r >= 3 ? 1 : 0, r >= 4 ? 1 : 0] },
  // Landed | attempts. Binomial.
  acc: { family: 'binomial', names: ['1', 'logit_acc', 'logit_opp_miss', 'r3_drift_opp', 'absorbed_cum', 'ctrl_min'],
    x: (s, o, st, ot, r, v) => [1, lgt(s.accuracy), lgt(1 - o.defense), r >= 3 ? o.drift_rel : 0, st.absorbed / 100, (v?.ctrl || 0) / 60] },
  // Takedown attempts. NB, offset log(L/900).
  td_att: { family: 'negbin', offset: (L) => Math.log(L / 900), names: ['1', 'log_td15', 'log_opp_td15', 'absorbed_cum', 'r2plus', 'r3plus'],
    x: (s, o, st, ot, r) => [1, lg(s.td15), lg(o.td15), st.absorbed / 100, r >= 2 ? 1 : 0, r >= 3 ? 1 : 0] },
  // Takedown landed | attempts. Binomial.
  td_acc: { family: 'binomial', names: ['1', 'logit_tdacc', 'logit_opp_tdmiss'],
    x: (s, o) => [1, lgt(s.tdacc), lgt(1 - o.tddef)] },
  // Any control time this round. Binomial (1 trial).
  ctrl_any: { family: 'binomial', names: ['1', 'td_l', 'td_landed_any', 'ctrl_share'],
    x: (s, o, st, ot, r, v) => [1, v.td_l, v.td_l > 0 ? 1 : 0, s.ctrl_share] },
  // Control seconds | any. Gamma, log link.
  ctrl_len: { family: 'gamma', names: ['1', 'log1p_td_l', 'log_ctrl_per_td', 'ctrl_share', 'log_L_300'],
    x: (s, o, st, ot, r, v, L) => [1, Math.log1p(v.td_l), Math.log(Math.max(5, s.ctrl_per_td)), s.ctrl_share, Math.log((L || 300) / 300)] },
  // Knockdowns scored. Poisson, offset log(L/900).
  kd: { family: 'poisson', offset: (L) => Math.log(L / 900), names: ['1', 'log_kd15', 'log_opp_kdabs15', 'head_l_10'],
    x: (s, o, st, ot, r, v) => [1, lg(s.kd15), lg(o.kdabs15), (v.head_l || 0) / 10] },
  // Submission attempts. Poisson, offset log(L/900).
  sub: { family: 'poisson', offset: (L) => Math.log(L / 900), names: ['1', 'log_sub15', 'log_opp_sub_vuln', 'ctrl_min'],
    x: (s, o, st, ot, r, v) => [1, lg(s.sub15), lg(o.sub_vuln), (v.ctrl || 0) / 60] },
  // KO/TKO finish by the attacker in this round. Complementary log-log, offset log(L/300).
  ko_haz: { family: 'cloglog', offset: (L) => Math.log(L / 300), names: ['1', 'log_ko_prop', 'log_opp_ko_vuln', 'kd', 'head_l_10', 'opp_absorbed_cum', 'r3plus'],
    x: (s, o, st, ot, r, v) => [1, lg(s.ko_prop), lg(o.ko_vuln), v.kd || 0, (v.head_l || 0) / 10, ot.absorbed / 100, r >= 3 ? 1 : 0] },
  // Submission finish by the attacker in this round. Complementary log-log, offset log(L/300).
  sub_haz: { family: 'cloglog', offset: (L) => Math.log(L / 300), names: ['1', 'log_sub_prop', 'log_opp_sub_vuln', 'sub_att', 'ctrl_min', 'td_l'],
    x: (s, o, st, ot, r, v) => [1, lg(s.sub_prop), lg(o.sub_vuln), v.sub || 0, (v.ctrl || 0) / 60, v.td_l || 0] },
};

export const COMPONENT_NAMES = Object.keys(COMPONENTS);

export function linear(beta, x) { let z = 0; for (let j = 0; j < beta.length; j++) z += beta[j] * x[j]; return z; }
export const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
