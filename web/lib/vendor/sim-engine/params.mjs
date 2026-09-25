// Engine parameters for pbe-fight-simulator v1.0.
//
// STATUS: v1.0-rc2. Component models and finish-time shapes come from params_fitted_v1.mjs (walk-forward validated,
// docs/FIGHT_SIMULATOR_PHASE3.md). The remaining scalars below are structural priors, documented in that report.
// Original note: every number below was a documented starting value chosen from
// the Phase 1 measurements over 42,166 fighter-rounds (means, dispersion) and
// the 2015-2026 finish distribution, NOT a fitted coefficient. Phase 3
// (walk-forward calibration) replaces them and the fitted set becomes the
// registered v1.0 coefficients. The engine spec hash covers this object, so a
// change here is a new engine spec by construction.
//
// Units: strikes per minute, takedowns/subs/knockdowns per 15 minutes, seconds.

import { FITTED_MODELS_V1, FITTED_FINISH_TIME_V1 } from './params_fitted_v1.mjs';

export const SIMULATOR_FAMILY = 'pbe-fight-simulator';
export const SIMULATOR_VERSION = 'pbe-fight-simulator-v1.0-rc2';
export const RULES_VERSION = 'pbe-sim-rules-v1';
export const DNA_DEFINITION_VERSION = 1;
export const FEATURE_VERSION = 1;

/** GLM-form priors equivalent to the Phase 2 multiplicative priors at league inputs (starting values only). */
export const PRIOR_MODELS = Object.freeze({
  att: { beta: [0, 1, 0, -0.06, -0.05, 0, 0, 0], k: 2.1, provenance: 'phase2-prior' },
  acc: { beta: [0.205, 1, 1, 0.5, 0, 0], provenance: 'phase2-prior' },
  td_att: { beta: [0, 1, 0, 0, 0, 0], k: 1.0, provenance: 'phase2-prior' },
  td_acc: { beta: [0.51, 1, 1], provenance: 'phase2-prior' },
  ctrl_any: { beta: [-0.85, 0, 3, 0], provenance: 'phase2-prior' },
  ctrl_len: { beta: [-0.69, 1, 1, 0, 0], shape: 1.2, provenance: 'phase2-prior' },
  kd: { beta: [1.31, 1, 1, 0], provenance: 'phase2-prior' },
  sub: { beta: [0, 1, 0, 0.6], provenance: 'phase2-prior' },
  ko_haz: { beta: [-3.4, 1, 1, 2.1, 0.1, 0.2, 0], provenance: 'phase2-prior' },
  sub_haz: { beta: [-4.05, 1, 1, 1.2, 0.2, 0.1], provenance: 'phase2-prior' },
});

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
  // Exchange coupling and control caps kept from Phase 2 (structural, not fitted).
  ground_boost_per_min: 0.12,
  control_cap_share: 0.85,
  kd_cap: 3,
  // Component models (models.mjs). PRIOR_MODELS below reproduces the Phase 2 league-average behaviour in GLM form;
  // Phase 3 replaces `models` with walk-forward fitted coefficients carrying provenance.
  models: FITTED_MODELS_V1,
  // Finish timing within the round: t = L * u^shape (shape < 1 tilts late, > 1 tilts early). KD finishes tilt earlier.
  finish_time_shape: FITTED_FINISH_TIME_V1.finish_time_shape, finish_time_shape_kd: FITTED_FINISH_TIME_V1.finish_time_shape_kd, finish_time_min: 8,
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

/* ---- pbe-fight-simulator-v1.0-rc3 CANDIDATE (Phase 3B draw calibration). NOT the default: production runs
 * v1.0-rc2 (= rc1 calibration + the round-by-outcome table, another session, 2026-09-24). ----
 * Identical to the production default (every fitted coefficient, score rule, tilt and gate threshold) plus fight-level persistence:
 * a share rho of each fitted attempt model's extra-Poisson variance becomes a per-fighter, per-fight gamma frailty
 * (src/engine/fight.mjs), so each round's fitted mean and variance are unchanged. rho was chosen on 2016-2020 judge
 * card shapes only and never revisited on the 2021-2026 holdout (docs/FIGHT_SIMULATOR_PHASE3B.md). */
export const SIMULATOR_VERSION_RC3 = 'pbe-fight-simulator-v1.0-rc3';
export const PERSISTENCE_RC3 = Object.freeze({ rho: 0.7, applies_to: Object.freeze(['att', 'td_att']), selected_on: 'judge card shapes 2016-01-01..2020-12-31', holdout: '2021-2026 walk-forward, fold params' });
export const PARAMS_V1_0_RC3 = Object.freeze({ ...DEFAULT_PARAMS, persistence: PERSISTENCE_RC3 });
