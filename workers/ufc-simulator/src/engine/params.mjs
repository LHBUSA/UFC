// Engine parameters for pbe-fight-simulator v1.0.
//
// STATUS: PRIORS. Every number below is a documented starting value chosen from
// the Phase 1 measurements over 42,166 fighter-rounds (means, dispersion) and
// the 2015-2026 finish distribution, NOT a fitted coefficient. Phase 3
// (walk-forward calibration) replaces them and the fitted set becomes the
// registered v1.0 coefficients. The engine spec hash covers this object, so a
// change here is a new engine spec by construction.
//
// Units: strikes per minute, takedowns/subs/knockdowns per 15 minutes, seconds.

export const SIMULATOR_FAMILY = 'pbe-fight-simulator';
export const SIMULATOR_VERSION = 'pbe-fight-simulator-v1.0-dev';
export const RULES_VERSION = 'pbe-sim-rules-v1';
export const DNA_DEFINITION_VERSION = 1;
export const FEATURE_VERSION = 1;

export const DEFAULT_PARAMS = Object.freeze({
  // League priors (Phase 1 table: sig att 35.2 and landed 15.8 per round; TD att 1.20 and landed 0.45 per round; sub 0.16; KD 0.09; control 55.8 s).
  league: {
    sig_att_per_min: 7.04, sig_landed_per_min: 3.16, sig_accuracy: 0.449, sig_defense: 0.551,
    td_att_per_15: 3.6, td_landed_per_15: 1.35, td_accuracy: 0.375, td_defense: 0.625,
    sub_att_per_15: 0.48, kd_per_15: 0.27, control_sec_per_round: 55.8, control_sec_per_td: 90,
    head_share: 0.66, body_share: 0.18, leg_share: 0.16,
    distance_share: 0.72, clinch_share: 0.12, ground_share: 0.16,
    ko_loss_rate: 0.20, sub_loss_rate: 0.12, ko_win_rate: 0.20, sub_win_rate: 0.12,
    pace_retention_r2: 0.96, pace_retention_r3: 0.93, championship_delta: 0.0, defensive_drift: 0.0,
  },
  // Shrinkage toward the league prior: weight of the prior in "rounds" of evidence.
  shrink_rounds: 6,
  shrink_bouts: 4,
  // Dispersion (negative binomial k): var = mu + mu^2/k. From var/mean 17.4 at mu 35 -> k ~ 2.1; TD var/mean 2.2 at mu 1.2 -> k ~ 1.
  k_sig_att: 2.1,
  k_td_att: 1.0,
  // Exchange coupling: how much an opponent's volume raises your own attempts (clamped).
  pressure_k: 0.15, pressure_min: 0.8, pressure_max: 1.25,
  // Fatigue: attempt multiplier = 1 - f_absorbed * absorbed_cum/100 - f_kd * kd_taken, floored.
  fatigue_absorbed: 0.06, fatigue_kd: 0.05, fatigue_floor: 0.55,
  // Defensive drift: relative accuracy uplift opponents get from round 3 (scaled by the fighter's drift metric).
  drift_k: 0.5, drift_cap: 0.25,
  // Ground share boost per minute of control this round.
  ground_boost_per_min: 0.12,
  // Control time: gamma shape when a TD landed; baseline control probability scale without a TD.
  control_shape: 1.2, control_cap_share: 0.85, control_base_prob_k: 0.5, control_base_mean: 20,
  // Submission attempt coupling to control (per minute of control).
  sub_control_k: 0.6, sub_control_cap_min: 2,
  // Knockdown coupling to head strikes landed this round (relative to league ~10 per round).
  kd_head_ref: 10, kd_head_k: 0.5, kd_cap: 3,
  // Finish hazards (per round, per fighter, per method). Tuned so a league-average pair over three rounds reproduces the
  // 2015-2026 marginals: finish 51% (KO/TKO 32%, SUB 19%), conditional finish hazard by round 0.22 / 0.17 / 0.13
  // (observed 0.27 / 0.22 / 0.15), draws 2% (observed 0.7%; the residual comes from offsetting 10-8 rounds).
  ko_base: 0.036, ko_kd: 0.28, ko_head_ref: 12, ko_head_k: 0.006, ko_damage_k: 0.015,
  sub_base: 0.019, sub_att_k: 0.08, sub_control_min_k: 0.02,
  // Finish timing within the round: t = L * u^shape (shape < 1 tilts late, > 1 tilts early). KD finishes tilt earlier.
  finish_time_shape: 0.9, finish_time_shape_kd: 1.4, finish_time_min: 8,
  // Round scoring weights (a published PBE rule, not a judge model).
  score: { head: 1.0, body: 0.8, leg: 0.6, kd: 6.0, td: 2.5, ctrl_per_min: 1.5, sub: 1.0, ten_eight_margin: 40, ten_eight_kd_margin: 14, draw_eps: 1e-9 },
  // Champion anchor tilt: log-odds style scalar applied to hazards, round margin, and mildly to exchange efficiency.
  tilt: { hazard_w: 1.0, round_w: 1.5, efficiency_w: 0.15, td_w: 0.15, search_max: 3.0, iterations: 18, calibration_sims: 2000, tolerance: 0.0025, residual_tolerance: 0.015, max_tilt: 1.0 },
  // Coverage gate thresholds.
  gate: { full_min_tier: 'medium', limited_min_tier: 'low', min_stat_bouts: 1, min_metric_availability: 0.6, medoid_min_cell: 300 },
  round_seconds: 300,
  max_rounds: 5,
});

export const TIER_RANK = Object.freeze({ insufficient: 0, low: 1, medium: 2, high: 3 });
