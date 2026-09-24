// One simulated fight: sequential rounds with carried state.
//
// Round N feeds round N+1 through: cumulative significant strikes absorbed
// (the damage proxy: there is no licensed damage measure, and the artifact
// says so), knockdowns taken, fatigue, control suffered, and the finish
// hazard. Nothing resets between rounds.
//
// Order inside a round, per fighter, in a fixed sequence so the RNG stream is
// consumed identically every time:
//   takedowns -> control -> strike attempts -> landed -> targets/positions ->
//   knockdowns -> submission attempts -> finish hazards -> round score.
//
// `tilt` is the champion-anchor scalar (see anchor.mjs). It enters the finish
// hazards, the round margin and, mildly, exchange efficiency, always with the
// opposite sign for the two corners, so the engine stays antisymmetric.

import { negbin, binomial, poisson, gamma, multinomial } from './dist.mjs';
import { clamp } from './canonical.mjs';

export const STAT = Object.freeze({ sig_l: 0, sig_a: 1, head_l: 2, body_l: 3, leg_l: 4, dist_l: 5, clinch_l: 6, ground_l: 7, td_l: 8, td_a: 9, ctrl: 10, kd: 11, sub: 12 });
export const NSTAT = 13;
export const STAT_KEYS = Object.freeze(['sig_l', 'sig_a', 'head_l', 'body_l', 'leg_l', 'dist_l', 'clinch_l', 'ground_l', 'td_l', 'td_a', 'ctrl', 'kd', 'sub']);
export const METHOD = Object.freeze({ KO: 'KO_TKO', SUB: 'SUB', DEC: 'DEC', DRAW: 'DRAW' });

/** Precompute everything a fight needs from two profiles. */
export function prepareContext(p1, p2, scheduledRounds, params) {
  const L = params.round_seconds;
  const R = clamp(scheduledRounds | 0, 1, params.max_rounds);
  const lg = params.league;
  const rel = (v, base) => (base > 0 ? v / base : 1);
  const sides = [p1, p2].map((p) => ({
    id: p.id,
    att_rate: p.att_rate.slice(0, R),
    accuracy: p.accuracy, defense: p.defense, drift_rel: p.drift_rel,
    shares: [p.shares.head, p.shares.body, p.shares.leg],
    positions: [p.positions.distance, p.positions.clinch, p.positions.ground],
    td15: p.td15, tdacc: p.tdacc, tddef: p.tddef, ctrl_per_td: p.ctrl_per_td, ctrl_share: p.ctrl_share, sub15: p.sub15,
    kd15: p.kd15, kdabs15: p.kdabs15,
    ko_prop: rel(p.ko_win, lg.ko_win_rate), sub_prop: rel(p.sub_win, lg.sub_win_rate),
    ko_vuln: rel(p.ko_loss, lg.ko_loss_rate), sub_vuln: rel(p.sub_loss, lg.sub_loss_rate),
  }));
  return { sides, L, R, params };
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
  const { sides, L, R, params: P } = ctx;
  const lg = P.league;
  const stats = new Int16Array(R * 2 * NSTAT);
  const scores = new Uint8Array(R * 2);
  const absorbed = [0, 0];
  const kdTaken = [0, 0];
  const tiltSign = [1, -1];
  const effMul = [Math.exp(tilt * P.tilt.efficiency_w), Math.exp(-tilt * P.tilt.efficiency_w)];
  const tdMul = [Math.exp(tilt * P.tilt.td_w), Math.exp(-tilt * P.tilt.td_w)];
  const hazMul = [Math.exp(tilt * P.tilt.hazard_w), Math.exp(-tilt * P.tilt.hazard_w)];
  let totals = [0, 0];

  for (let r = 0; r < R; r++) {
    const base = r * 2 * NSTAT;
    const roundNo = r + 1;
    const fat = [0, 1].map((i) => clamp(1 - P.fatigue_absorbed * (absorbed[i] / 100) - P.fatigue_kd * kdTaken[i], P.fatigue_floor, 1));
    const rate = [0, 1].map((i) => sides[i].att_rate[r] ?? sides[i].att_rate[sides[i].att_rate.length - 1]);
    const pressure = [0, 1].map((i) => clamp(1 + P.pressure_k * (rate[1 - i] / lg.sig_att_per_min - 1), P.pressure_min, P.pressure_max));

    // Takedowns and control.
    const tdL = [0, 0], tdA = [0, 0], ctrl = [0, 0];
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j];
      const mu = s.td15 * (L / 900) * pressure[i] * fat[i];
      tdA[i] = negbin(rng, mu, P.k_td_att);
      const q = clamp((s.tdacc * (1 - o.tddef)) / (lg.td_accuracy * (1 - lg.td_defense)) * lg.td_accuracy * tdMul[i], 0.03, 0.95);
      tdL[i] = binomial(rng, tdA[i], q);
      if (tdL[i] > 0) {
        ctrl[i] = Math.min(L * P.control_cap_share, gamma(rng, P.control_shape, (s.ctrl_per_td * tdL[i]) / P.control_shape));
      } else if (rng.nextFloat() < s.ctrl_share * P.control_base_prob_k) {
        ctrl[i] = Math.min(60, gamma(rng, 1, P.control_base_mean));
      }
    }
    if (ctrl[0] + ctrl[1] > L) { const k = L / (ctrl[0] + ctrl[1]); ctrl[0] *= k; ctrl[1] *= k; }
    for (let i = 0; i < 2; i++) ctrl[i] = Math.round(ctrl[i]);

    // Strikes.
    const landed = [0, 0], headL = [0, 0], kd = [0, 0], subA = [0, 0];
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j];
      const mu = rate[i] * (L / 60) * fat[i] * pressure[i];
      const att = negbin(rng, mu, P.k_sig_att);
      let p = (s.accuracy * (1 - o.defense)) / (1 - lg.sig_defense);
      if (roundNo >= 3) p *= 1 + P.drift_k * o.drift_rel;
      p = clamp(p * effMul[i], 0.05, 0.9);
      const l = binomial(rng, att, p);
      landed[i] = l;
      const tgt = multinomial(rng, l, s.shares);
      const ctrlMin = ctrl[i] / 60;
      const gShare = clamp(s.positions[2] + P.ground_boost_per_min * ctrlMin, 0, 0.95);
      const rest = 1 - gShare;
      const dc = s.positions[0] + s.positions[1];
      const pos = multinomial(rng, l, [dc > 0 ? rest * (s.positions[0] / dc) : rest, dc > 0 ? rest * (s.positions[1] / dc) : 0, gShare]);
      headL[i] = tgt[0];
      const o0 = base + i * NSTAT;
      stats[o0 + STAT.sig_l] = l; stats[o0 + STAT.sig_a] = att;
      stats[o0 + STAT.head_l] = tgt[0]; stats[o0 + STAT.body_l] = tgt[1]; stats[o0 + STAT.leg_l] = tgt[2];
      stats[o0 + STAT.dist_l] = pos[0]; stats[o0 + STAT.clinch_l] = pos[1]; stats[o0 + STAT.ground_l] = pos[2];
      stats[o0 + STAT.td_l] = tdL[i]; stats[o0 + STAT.td_a] = tdA[i]; stats[o0 + STAT.ctrl] = ctrl[i];
    }
    // Knockdowns and submission attempts (after both strike lines so head counts exist).
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j];
      const kdRate = Math.sqrt(Math.max(1e-9, s.kd15 * o.kdabs15)) / Math.max(1e-9, lg.kd_per_15) * lg.kd_per_15;
      const lam = kdRate * (L / 900) * (1 - P.kd_head_k + P.kd_head_k * (headL[i] / P.kd_head_ref)) * effMul[i];
      kd[i] = Math.min(P.kd_cap, poisson(rng, lam));
      const subLam = s.sub15 * (L / 900) * (1 + P.sub_control_k * Math.min(P.sub_control_cap_min, ctrl[i] / 60));
      subA[i] = poisson(rng, subLam);
      const o0 = base + i * NSTAT;
      stats[o0 + STAT.kd] = kd[i]; stats[o0 + STAT.sub] = subA[i];
    }

    // Finish hazards.
    const hz = new Array(4); // [ko1, sub1, ko2, sub2]
    for (let i = 0; i < 2; i++) {
      const j = 1 - i, s = sides[i], o = sides[j];
      const koIntensity = (P.ko_base * s.ko_prop * o.ko_vuln + P.ko_kd * kd[i] + P.ko_head_k * Math.max(0, headL[i] - P.ko_head_ref) + P.ko_damage_k * ((absorbed[j] + landed[i]) / 100) * o.ko_vuln) * hazMul[i];
      const subIntensity = (P.sub_base * s.sub_prop * o.sub_vuln + P.sub_att_k * subA[i] * o.sub_vuln + P.sub_control_min_k * (ctrl[i] / 60) * o.sub_vuln) * hazMul[i];
      hz[i * 2] = 1 - Math.exp(-Math.max(0, koIntensity));
      hz[i * 2 + 1] = 1 - Math.exp(-Math.max(0, subIntensity));
    }
    const pEnd = 1 - (1 - hz[0]) * (1 - hz[1]) * (1 - hz[2]) * (1 - hz[3]);
    const uEnd = rng.nextFloat();
    const uWhich = rng.nextFloat();
    const uTime = rng.nextFloat();
    // Round score on the full round; an ending round is re-scored below on its elapsed-time stats so the record stays coherent.
    const [s1, s2] = scoreRound(stats, base, P, tilt);
    scores[r * 2] = s1; scores[r * 2 + 1] = s2;
    totals[0] += s1; totals[1] += s2;

    if (uEnd < pEnd) {
      const total = hz[0] + hz[1] + hz[2] + hz[3];
      let acc = 0, which = 3;
      for (let k = 0; k < 4; k++) { acc += hz[k] / total; if (uWhich < acc) { which = k; break; } }
      const winner = which < 2 ? 1 : 2;
      const method = which % 2 === 0 ? METHOD.KO : METHOD.SUB;
      const shape = method === METHOD.KO && kd[winner - 1] > 0 ? P.finish_time_shape_kd : P.finish_time_shape;
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
    absorbed[0] += landed[1]; absorbed[1] += landed[0];
    kdTaken[0] += kd[1]; kdTaken[1] += kd[0];
  }

  const winner = totals[0] > totals[1] ? 1 : totals[1] > totals[0] ? 2 : 0;
  return { winner, method: winner ? METHOD.DEC : METHOD.DRAW, end_round: R, end_time: L, rounds: R, stats, scores };
}
