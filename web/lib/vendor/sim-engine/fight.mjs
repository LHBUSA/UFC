// One simulated fight: sequential rounds with carried state.
//
// Round N feeds round N+1 through: cumulative significant strikes absorbed
// (the damage proxy: there is no licensed damage measure, and the artifact
// says so), knockdowns taken, control suffered, and the finish hazard.
// Nothing resets between rounds.
//
// Every rate, probability and hazard is a fitted component model from
// models.mjs (features shared with the Phase 3 fitter) with coefficients in
// params.models. Order inside a round, per fighter, is fixed so the RNG
// stream is consumed identically every time:
//   takedowns -> control -> strike attempts -> landed -> targets/positions ->
//   knockdowns -> submission attempts -> finish hazards -> round score.
//
// `tilt` is the champion-anchor scalar (see anchor.mjs). It enters the finish
// hazards, the round margin and, mildly, exchange efficiency, always with the
// opposite sign for the two corners, so the engine stays antisymmetric.

import { negbin, binomial, poisson, gamma, multinomial } from './dist.mjs';
import { clamp } from './canonical.mjs';
import { COMPONENTS, linear, sigmoid } from './models.mjs';

export const STAT = Object.freeze({ sig_l: 0, sig_a: 1, head_l: 2, body_l: 3, leg_l: 4, dist_l: 5, clinch_l: 6, ground_l: 7, td_l: 8, td_a: 9, ctrl: 10, kd: 11, sub: 12 });
export const NSTAT = 13;
export const STAT_KEYS = Object.freeze(['sig_l', 'sig_a', 'head_l', 'body_l', 'leg_l', 'dist_l', 'clinch_l', 'ground_l', 'td_l', 'td_a', 'ctrl', 'kd', 'sub']);
export const METHOD = Object.freeze({ KO: 'KO_TKO', SUB: 'SUB', DEC: 'DEC', DRAW: 'DRAW' });

/** Engine-facing side numerics from a profile (shared with the Phase 3 fitter so observed rounds use identical inputs). */
export function sideFromProfile(p, params) {
  const lg = params.league;
  const rel = (v, base) => (base > 0 ? v / base : 1);
  return {
    id: p.id,
    att_rate: p.att_rate.slice(),
    accuracy: p.accuracy, defense: p.defense, drift_rel: p.drift_rel,
    shares: [p.shares.head, p.shares.body, p.shares.leg],
    positions: [p.positions.distance, p.positions.clinch, p.positions.ground],
    td15: p.td15, tdacc: p.tdacc, tddef: p.tddef, ctrl_per_td: p.ctrl_per_td, ctrl_share: p.ctrl_share, sub15: p.sub15,
    kd15: p.kd15, kdabs15: p.kdabs15,
    ko_prop: rel(p.ko_win, lg.ko_win_rate), sub_prop: rel(p.sub_win, lg.sub_win_rate),
    ko_vuln: rel(p.ko_loss, lg.ko_loss_rate), sub_vuln: rel(p.sub_loss, lg.sub_loss_rate),
  };
}

/** Precompute everything a fight needs from two profiles. */
export function prepareContext(p1, p2, scheduledRounds, params) {
  const L = params.round_seconds;
  const R = clamp(scheduledRounds | 0, 1, params.max_rounds);
  const sides = [p1, p2].map((p) => sideFromProfile(p, params));
  const M = params.models;
  for (const name of Object.keys(COMPONENTS)) if (!M?.[name]?.beta) throw new Error(`params.models.${name} missing`);
  return { sides, L, R, params, M };
}

/** PBE round score (published rule): 10-9 to the higher weighted total, 10-8 on a wide margin or a knockdown with a clear margin, 10-10 only on an exact tie. */
function scoreRound(stats, base, P, tilt) {
  const sc = P.score;
  const rs = [0, 1].map((i) => {
    const o0 = base + i * NSTAT;
    return sc.head * stats[o0 + STAT.head_l] + sc.body * stats[o0 + STAT.body_l] + sc.leg * stats[o0 + STAT.leg_l] + sc.kd * stats[o0 + STAT.kd] + sc.td * stats[o0 + STAT.td_l] + sc.ctrl_per_min * (stats[o0 + STAT.ctrl] / 60) + sc.sub * stats[o0 + STAT.sub];
  });
  const kd0 = stats[base + STAT.kd], kd1 = stats[base + NSTAT + STAT.kd];
  const margin = rs[0] - rs[1] + tilt * P.tilt.round_w;
  let s1 = 10, s2 = 10;
  if (margin > sc.draw_eps) { s2 = 9; if (margin >= sc.ten_eight_margin || (kd0 >= 1 && margin >= sc.ten_eight_kd_margin)) s2 = 8; }
  else if (margin < -sc.draw_eps) { s1 = 9; if (-margin >= sc.ten_eight_margin || (kd1 >= 1 && -margin >= sc.ten_eight_kd_margin)) s1 = 8; }
  return [s1, s2];
}

/** Rescale a group of integer parts so they sum to `total` (largest-remainder rounding, deterministic). */
function scaleGroup(stats, o0, idx, total) {
  const cur = idx.map((q) => stats[o0 + q]);
  const sum = cur.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) { for (const q of idx) stats[o0 + q] = 0; if (total > 0) stats[o0 + idx[0]] = total; return; }
  const raw = cur.map((v) => (v * total) / sum);
  const floors = raw.map(Math.floor);
  let rem = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let j = 0; j < order.length && rem > 0; j++, rem--) floors[order[j][1]]++;
  idx.forEach((q, i) => { stats[o0 + q] = floors[i]; });
}

/**
 * @returns {{winner:number, method:string, end_round:number, end_time:number, rounds:number, stats:Int16Array, scores:Uint8Array}}
 * winner: 1 | 2 | 0 (draw). stats laid out [round][side][stat]. scores laid out [round][side] as 10/9/8.
 */
export function simulateFight(ctx, rng, tilt = 0) {
  const { sides, L, R, params: P, M } = ctx;
  const stats = new Int16Array(R * 2 * NSTAT);
  const scores = new Uint8Array(R * 2);
  const state = [{ absorbed: 0, kdTaken: 0 }, { absorbed: 0, kdTaken: 0 }];
  const effT = [tilt * P.tilt.efficiency_w, -tilt * P.tilt.efficiency_w];
  const tdT = [tilt * P.tilt.td_w, -tilt * P.tilt.td_w];
  const hazT = [tilt * P.tilt.hazard_w, -tilt * P.tilt.hazard_w];
  const totals = [0, 0];
  const offAtt = COMPONENTS.att.offset(L), offTd = COMPONENTS.td_att.offset(L), off900 = COMPONENTS.kd.offset(L), offHaz = COMPONENTS.ko_haz.offset(L);

  /* Fight-level persistence (Phase 3B draw calibration, optional; absent = the v1.0-rc1 engine, byte for byte).
   * The fitted attempt models are negative binomial per round: all of their extra-Poisson variance is drawn fresh
   * every round, so who wins a round is nearly independent of who won the last one, and the single PBE card comes
   * out even (a draw) three to five times as often as real judges' cards. A share `rho` of that same variance is
   * moved to a per-fighter, per-fight gamma frailty drawn once; the round-level dispersion is re-solved so each
   * round's marginal mean and variance are exactly the fitted ones: frailty variance rho/k, residual dispersion
   * k' = (k + rho) / (1 - rho), and (1 + rho/k)(1 + 1/k') = 1 + 1/k. No fitted coefficient changes. */
  const rho = P.persistence?.rho || 0;
  let gAtt = [1, 1], gTd = [1, 1], kAtt = M.att.k, kTd = M.td_att.k;
  if (rho > 0 && rho < 1) {
    const aA = M.att.k / rho, aT = M.td_att.k / rho;
    gAtt = [gamma(rng, aA, 1 / aA), gamma(rng, aA, 1 / aA)];
    gTd = [gamma(rng, aT, 1 / aT), gamma(rng, aT, 1 / aT)];
    kAtt = (M.att.k + rho) / (1 - rho); kTd = (M.td_att.k + rho) / (1 - rho);
  }

  for (let r = 0; r < R; r++) {
    const base = r * 2 * NSTAT;
    const roundNo = r + 1;
    const v = [{ td_l: 0, td_a: 0, ctrl: 0, head_l: 0, kd: 0, sub: 0, landed: 0 }, { td_l: 0, td_a: 0, ctrl: 0, head_l: 0, kd: 0, sub: 0, landed: 0 }];

    // Takedowns and control.
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j], st = state[i], ot = state[j];
      const mu = Math.exp(linear(M.td_att.beta, COMPONENTS.td_att.x(s, o, st, ot, roundNo)) + offTd);
      v[i].td_a = negbin(rng, mu * gTd[i], kTd);
      const q = sigmoid(linear(M.td_acc.beta, COMPONENTS.td_acc.x(s, o, st, ot, roundNo)) + tdT[i]);
      v[i].td_l = binomial(rng, v[i].td_a, q);
      const pAny = sigmoid(linear(M.ctrl_any.beta, COMPONENTS.ctrl_any.x(s, o, st, ot, roundNo, v[i])));
      if (rng.nextFloat() < pAny) {
        const mean = Math.exp(linear(M.ctrl_len.beta, COMPONENTS.ctrl_len.x(s, o, st, ot, roundNo, v[i], L)));
        v[i].ctrl = Math.min(L * P.control_cap_share, gamma(rng, M.ctrl_len.shape, mean / M.ctrl_len.shape));
      }
    }
    if (v[0].ctrl + v[1].ctrl > L) { const k = L / (v[0].ctrl + v[1].ctrl); v[0].ctrl *= k; v[1].ctrl *= k; }
    for (let i = 0; i < 2; i++) v[i].ctrl = Math.round(v[i].ctrl);

    // Strikes.
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j], st = state[i], ot = state[j];
      const mu = Math.exp(linear(M.att.beta, COMPONENTS.att.x(s, o, st, ot, roundNo)) + offAtt);
      const att = negbin(rng, mu * gAtt[i], kAtt);
      const p = clamp(sigmoid(linear(M.acc.beta, COMPONENTS.acc.x(s, o, st, ot, roundNo, v[i])) + effT[i]), 0.02, 0.95);
      const l = binomial(rng, att, p);
      v[i].landed = l;
      const tgt = multinomial(rng, l, s.shares);
      const gShare = clamp(s.positions[2] + P.ground_boost_per_min * (v[i].ctrl / 60), 0, 0.95);
      const rest = 1 - gShare;
      const dc = s.positions[0] + s.positions[1];
      const pos = multinomial(rng, l, [dc > 0 ? rest * (s.positions[0] / dc) : rest, dc > 0 ? rest * (s.positions[1] / dc) : 0, gShare]);
      v[i].head_l = tgt[0];
      const o0 = base + i * NSTAT;
      stats[o0 + STAT.sig_l] = l; stats[o0 + STAT.sig_a] = att;
      stats[o0 + STAT.head_l] = tgt[0]; stats[o0 + STAT.body_l] = tgt[1]; stats[o0 + STAT.leg_l] = tgt[2];
      stats[o0 + STAT.dist_l] = pos[0]; stats[o0 + STAT.clinch_l] = pos[1]; stats[o0 + STAT.ground_l] = pos[2];
      stats[o0 + STAT.td_l] = v[i].td_l; stats[o0 + STAT.td_a] = v[i].td_a; stats[o0 + STAT.ctrl] = v[i].ctrl;
    }
    // Knockdowns and submission attempts.
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j], st = state[i], ot = state[j];
      const lam = Math.exp(linear(M.kd.beta, COMPONENTS.kd.x(s, o, st, ot, roundNo, v[i])) + off900 + effT[i]);
      v[i].kd = Math.min(P.kd_cap, poisson(rng, lam));
      const subLam = Math.exp(linear(M.sub.beta, COMPONENTS.sub.x(s, o, st, ot, roundNo, v[i])) + off900);
      v[i].sub = poisson(rng, subLam);
      const o0 = base + i * NSTAT;
      stats[o0 + STAT.kd] = v[i].kd; stats[o0 + STAT.sub] = v[i].sub;
    }

    // Finish hazards.
    const hz = new Array(4); // [ko1, sub1, ko2, sub2]
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j], st = state[i], ot = state[j];
      const eKo = Math.exp(Math.min(30, linear(M.ko_haz.beta, COMPONENTS.ko_haz.x(s, o, st, ot, roundNo, v[i])) + offHaz + hazT[i]));
      const eSub = Math.exp(Math.min(30, linear(M.sub_haz.beta, COMPONENTS.sub_haz.x(s, o, st, ot, roundNo, v[i])) + offHaz + hazT[i]));
      hz[i * 2] = 1 - Math.exp(-eKo);
      hz[i * 2 + 1] = 1 - Math.exp(-eSub);
    }
    const pEnd = 1 - (1 - hz[0]) * (1 - hz[1]) * (1 - hz[2]) * (1 - hz[3]);
    const uEnd = rng.nextFloat();
    const uWhich = rng.nextFloat();
    const uTime = rng.nextFloat();
    const [s1, s2] = scoreRound(stats, base, P, tilt);
    scores[r * 2] = s1; scores[r * 2 + 1] = s2;
    totals[0] += s1; totals[1] += s2;

    if (uEnd < pEnd) {
      const total = hz[0] + hz[1] + hz[2] + hz[3];
      let acc = 0, which = 3;
      for (let k = 0; k < 4; k++) { acc += hz[k] / total; if (uWhich < acc) { which = k; break; } }
      const winner = which < 2 ? 1 : 2;
      const method = which % 2 === 0 ? METHOD.KO : METHOD.SUB;
      const shape = method === METHOD.KO && v[winner - 1].kd > 0 ? P.finish_time_shape_kd : P.finish_time_shape;
      const t = clamp(Math.round(L * Math.pow(uTime, shape)), P.finish_time_min, L - 1);
      // The ending round's stats are scaled to the elapsed time so the record never claims a full round of output.
      const k = t / L;
      for (let i = 0; i < 2; i++) {
        const o0 = base + i * NSTAT;
        const sigL = Math.round(stats[o0 + STAT.sig_l] * k);
        stats[o0 + STAT.sig_l] = sigL;
        stats[o0 + STAT.sig_a] = Math.max(sigL, Math.round(stats[o0 + STAT.sig_a] * k));
        scaleGroup(stats, o0, [STAT.head_l, STAT.body_l, STAT.leg_l], sigL);
        scaleGroup(stats, o0, [STAT.dist_l, STAT.clinch_l, STAT.ground_l], sigL);
        const tdl = Math.round(stats[o0 + STAT.td_l] * k);
        stats[o0 + STAT.td_l] = tdl;
        stats[o0 + STAT.td_a] = Math.max(tdl, Math.round(stats[o0 + STAT.td_a] * k));
        stats[o0 + STAT.ctrl] = Math.min(t, Math.round(stats[o0 + STAT.ctrl] * k));
      }
      const [e1, e2] = scoreRound(stats, base, P, tilt);
      scores[r * 2] = e1; scores[r * 2 + 1] = e2;
      return { winner, method, end_round: roundNo, end_time: t, rounds: roundNo, stats, scores };
    }

    // Carry state.
    state[0].absorbed += v[1].landed; state[1].absorbed += v[0].landed;
    state[0].kdTaken += v[1].kd; state[1].kdTaken += v[0].kd;
  }

  const winner = totals[0] > totals[1] ? 1 : totals[1] > totals[0] ? 2 : 0;
  return { winner, method: winner ? METHOD.DEC : METHOD.DRAW, end_round: R, end_time: L, rounds: R, stats, scores };
}
