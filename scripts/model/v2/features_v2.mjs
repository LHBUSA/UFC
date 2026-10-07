// PBE Fight Model V2 research - candidate feature families. PURE: no fs, no env.
//
// Every value here is point-in-time and antisymmetric, under the same contract
// as V1 (docs/model/METHODOLOGY.md section 2):
//   - a bout dated D only sees bout rows dated strictly before D, and
//     snapshots whose own as-of date is <= the date they describe;
//   - every feature is a corner difference, or a symmetric bout fact multiplied
//     by a corner difference, so swapping the corners negates the whole vector
//     and a no-intercept model stays exactly complementary.
//
// Market data never enters this file.

import { FEATURE_KEYS } from '../feature_spec.mjs';
import { latestAsOf } from '../features_core.mjs';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dif = (a, b) => (a == null || b == null ? 0 : a - b);
const IX = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, i]));

/* ------------------------------------------------------------- Elo ladder */

export const ELO_GRID = [16, 24, 32, 48, 64];
export const ELO_START = 1500;

/**
 * Chronological Elo over every graded bout. Ratings for bouts on date D are read
 * before any result dated D is applied (same date-block rule as the V1 ladder).
 * kFor(n) = k * (1 + 2 / (n + 1)): a fighter's first results move the rating
 * further, which is the standard provisional-rating treatment.
 *
 * @param bouts   [{ id, date, f1, f2, winner }]  winner: f1 | f2 | 'draw' | null (null = no contest / ungraded, skipped)
 * @returns Map bout_id -> { r1, r2, n1, n2 } pre-bout ratings and prior rated bouts
 */
export function eloLadder(bouts, k = 32) {
  const rating = new Map();
  const count = new Map();
  const out = new Map();
  const byDate = new Map();
  for (const b of bouts) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date).push(b); }
  for (const date of [...byDate.keys()].sort()) {
    const block = byDate.get(date);
    for (const b of block) out.set(b.id, { r1: rating.get(b.f1) ?? ELO_START, r2: rating.get(b.f2) ?? ELO_START, n1: count.get(b.f1) ?? 0, n2: count.get(b.f2) ?? 0 });
    for (const b of block) {
      if (!b.winner) continue;
      const pre = out.get(b.id);
      const s1 = b.winner === 'draw' ? 0.5 : b.winner === b.f1 ? 1 : 0;
      const e1 = 1 / (1 + 10 ** ((pre.r2 - pre.r1) / 400));
      const k1 = k * (1 + 2 / (pre.n1 + 1));
      const k2 = k * (1 + 2 / (pre.n2 + 1));
      rating.set(b.f1, (rating.get(b.f1) ?? ELO_START) + k1 * (s1 - e1));
      rating.set(b.f2, (rating.get(b.f2) ?? ELO_START) - k2 * (s1 - e1));
      count.set(b.f1, (count.get(b.f1) ?? 0) + 1);
      count.set(b.f2, (count.get(b.f2) ?? 0) + 1);
    }
  }
  return out;
}

/** Choose K on bouts strictly before `before` only (the pre-walk-forward era), by Elo-only log loss. */
export function chooseEloK(bouts, before, grid = ELO_GRID) {
  let best = null;
  const scan = [];
  for (const k of grid) {
    const pre = eloLadder(bouts, k);
    let ll = 0, n = 0;
    for (const b of bouts) {
      if (b.date >= before || !b.winner || b.winner === 'draw') continue;
      const r = pre.get(b.id);
      if (r.n1 === 0 && r.n2 === 0) continue;
      const p = Math.min(1 - 1e-9, Math.max(1e-9, 1 / (1 + 10 ** ((r.r2 - r.r1) / 400))));
      ll += b.winner === b.f1 ? -Math.log(p) : -Math.log(1 - p);
      n += 1;
    }
    scan.push({ k, log_loss: ll / n, n });
    if (!best || ll / n < best.log_loss) best = { k, log_loss: ll / n, n };
  }
  return { k: best.k, scan };
}

/* ------------------------------------------- opponent-adjusted Fight DNA */

/** Slim snapshot record: only what the V2 opponent-quality features read. */
export function slimSnapshot(s) {
  const apps = num(s.record?.appearances) ?? 0;
  return {
    as_of_date: s.as_of_date,
    stat_bouts: num(s.sample_stat_bouts) ?? 0,
    sig_diff: num(s.m_sig_diff_per_min),
    slpm: num(s.m_sig_landed_per_min),
    sapm: num(s.m_sig_absorbed_per_min),
    ctrl: num(s.m_control_share),
    td15: num(s.m_td_landed_per_15),
    dist_share: num(s.m_distance_attack_share),
    ko_loss: apps > 0 ? (num(s.finished_by?.ko_tko) ?? 0) / apps : null,
    apps,
  };
}

const SHRINK_K = 2; // pseudo-bouts of "average opponent" (zero difference) mixed into every mean

/**
 * Opponent-quality summary for one fighter immediately before `date`.
 * Each prior bout dated d_r < date is scored against the OPPONENT'S snapshot as
 * of d_r (latest as_of_date <= d_r), so the opponent is measured as they stood
 * when they were fought - never by what they did afterwards.
 *
 * @param priorRows  this fighter's bout-feature rows (any order); only rows dated < date are read
 * @param snapsOf    fighter_id -> slim snapshots sorted by as_of_date
 * @param popMeans   population means used to centre opponent metrics (computed from pre-walk-forward data)
 */
export function opponentQuality(priorRows, snapsOf, date, popMeans) {
  const acc = { sd: [], ctrl: [], dur: [], perf: [], qwins: 0, n: 0 };
  for (const r of priorRows) {
    if (!(r.event_date < date)) continue;
    acc.n += 1;
    const o = latestAsOf(snapsOf.get(r.opponent_id) || [], r.event_date);
    if (!o || o.as_of_date > r.event_date) continue;
    if (o.stat_bouts >= 1 && o.sig_diff != null) acc.sd.push(o.sig_diff - popMeans.sig_diff);
    if (o.stat_bouts >= 1 && o.ctrl != null) acc.ctrl.push(o.ctrl - popMeans.ctrl);
    if (o.apps >= 1 && o.ko_loss != null) acc.dur.push(popMeans.ko_loss - o.ko_loss);
    if (r.outcome === 'W' && o.stat_bouts >= 3 && o.sig_diff != null && o.sig_diff > 0) acc.qwins += 1;
    /* Performance against expectation: what this fighter landed beyond what the opponent normally absorbs,
     * plus what they absorbed below what the opponent normally lands. Needs round stats for this bout. */
    const t = r.totals, ot = r.opp_totals;
    const mins = num(r.observed_seconds) / 60;
    if (t && ot && mins > 0.5 && o.stat_bouts >= 1 && o.sapm != null && o.slpm != null && r.stats_coverage && r.stats_coverage !== 'none') {
      const landed = (num(t.sig_l) ?? 0) / mins, absorbed = (num(ot.sig_l) ?? 0) / mins;
      acc.perf.push((landed - o.sapm) + (o.slpm - absorbed));
    }
  }
  const shrunk = (arr) => (arr.length ? arr.reduce((a, v) => a + v, 0) / (arr.length + SHRINK_K) : null);
  return {
    opp_sigdiff: shrunk(acc.sd),
    opp_ctrl: shrunk(acc.ctrl),
    opp_durability: shrunk(acc.dur),
    perf_vs_expect: shrunk(acc.perf),
    dna_quality_wins: acc.n ? Math.log1p(acc.qwins) : null,
  };
}

/* ------------------------------------------------------- feature families */

export const C2_KEYS = ['elo_diff', 'opp_sigdiff_diff', 'opp_ctrl_diff', 'opp_durability_diff', 'perf_vs_expect_diff', 'dna_quality_wins_diff'];

export const C3_KEYS = [
  'age_x_five_round', 'age_x_older', 'layoff_x_age', 'cardio_x_five_round', 'champ_delta_x_five_round',
  'reach_x_distance', 'reach_x_heavy', 'grapple_matchup', 'power_matchup', 'strike_matchup', 'experience_x_thin', 'title_exp_x_title',
];

const HEAVY = new Set(['HEAVYWEIGHT', 'LIGHT_HEAVYWEIGHT']);

/**
 * Extended vector for one dataset row.
 * @param row     a build_features row (x, side_1, side_2, scheduled_rounds, ...)
 * @param extra   { elo: {r1, r2}, oq1, oq2, snap1, snap2 } point-in-time extras for corner 1 and 2
 */
export function extendRow(row, extra) {
  const s1 = row.side_1, s2 = row.side_2;
  const x = row.x;
  const five = row.scheduled_rounds === 5 ? 1 : 0;
  const meanAge = s1.age_years != null && s2.age_years != null ? (s1.age_years + s2.age_years) / 2 : null;
  const olderOver30 = meanAge == null ? 0 : Math.max(0, meanAge - 30);
  const ageC = meanAge == null ? 0 : (meanAge - 30) / 5;
  const dist = extra.snap1?.dist_share != null && extra.snap2?.dist_share != null ? (extra.snap1.dist_share + extra.snap2.dist_share) / 2 : 0;
  const thin = 1 / (1 + Math.min(s1.prior_bouts, s2.prior_bouts));
  /* Cross-matchup terms: f(A,B) - f(B,A) is antisymmetric for any f. */
  const cross = (a1, d2, a2, d1) => (a1 == null || d2 == null || a2 == null || d1 == null ? 0 : a1 * d2 - a2 * d1);

  const c2 = {
    elo_diff: extra.elo ? (extra.elo.r1 - extra.elo.r2) / 100 : 0,
    opp_sigdiff_diff: dif(extra.oq1?.opp_sigdiff, extra.oq2?.opp_sigdiff),
    opp_ctrl_diff: dif(extra.oq1?.opp_ctrl, extra.oq2?.opp_ctrl),
    opp_durability_diff: dif(extra.oq1?.opp_durability, extra.oq2?.opp_durability),
    perf_vs_expect_diff: dif(extra.oq1?.perf_vs_expect, extra.oq2?.perf_vs_expect),
    dna_quality_wins_diff: dif(extra.oq1?.dna_quality_wins, extra.oq2?.dna_quality_wins),
  };
  const c3 = {
    age_x_five_round: x[IX.age_diff_years] * five,
    age_x_older: x[IX.age_diff_years] * olderOver30,
    layoff_x_age: x[IX.layoff_log_diff] * ageC,
    cardio_x_five_round: x[IX.pace_retention_diff] * five,
    champ_delta_x_five_round: x[IX.champ_round_delta_diff] * five,
    reach_x_distance: x[IX.reach_diff_in] * dist,
    reach_x_heavy: x[IX.reach_diff_in] * (HEAVY.has(row.weight_class) ? 1 : 0),
    grapple_matchup: cross(s1.td_landed_per15, s2.td_defense == null ? null : 1 - s2.td_defense, s2.td_landed_per15, s1.td_defense == null ? null : 1 - s1.td_defense),
    power_matchup: cross(s1.kd_per15, s2.ko_loss_rate, s2.kd_per15, s1.ko_loss_rate),
    strike_matchup: cross(s1.slpm, s2.sig_defense == null ? null : 1 - s2.sig_defense, s2.slpm, s1.sig_defense == null ? null : 1 - s1.sig_defense),
    experience_x_thin: x[IX.experience_log_diff] * thin,
    title_exp_x_title: x[IX.title_exp_diff] * (row.is_title ? 1 : 0),
  };
  return { c2: C2_KEYS.map((k) => c2[k]), c3: C3_KEYS.map((k) => c3[k]) };
}

/** Swap the corners of the extras: used by the antisymmetry tests. */
export const swapExtra = (e) => ({ elo: e.elo ? { r1: e.elo.r2, r2: e.elo.r1 } : null, oq1: e.oq2, oq2: e.oq1, snap1: e.snap2, snap2: e.snap1 });
