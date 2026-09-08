// PBE Fight Model v1 - the feature contract.
//
// FEATURE_VERSION is part of every stored prediction. Changing any definition
// below, adding a feature or removing one requires a bump, because a
// prediction is only interpretable against the feature set that produced it.
export const FEATURE_VERSION = 'pbe-fight-features-v1';
export const MODEL_FAMILY = 'pbe-fight-model';
export const MODEL_VERSION = 'pbe-fight-model-v1';

// ---------------------------------------------------------------------------
// Antisymmetry
// ---------------------------------------------------------------------------
// Every feature is a DIFFERENCE between the two corners, and the model is
// fitted with NO INTERCEPT. Two consequences, both deliberate:
//
//   1. Swapping the corners negates the feature vector, so the predicted
//      probabilities are exactly complementary: p(A) + p(B) = 1, always, with
//      no renormalisation step that could hide an inconsistency.
//   2. The model cannot learn a corner bias. That matters enormously here: in
//      this database the fighter listed first (fighter_a_id) wins 93.5% of
//      completed bouts, purely because the UFCStats ingest lists the winner
//      first. A model with an intercept, or with non-differential features,
//      would learn that artifact and report ~93% accuracy for nothing. The
//      canonical orientation used everywhere below sorts the two fighter UUIDs
//      lexicographically, which is independent of the result: the base rate
//      under that orientation is 50.45%.
//
// Bout-level facts that are the same for both corners (weight class, scheduled
// rounds, title status) are therefore not model inputs in v1: a symmetric term
// carries no information about WHICH fighter wins. They are still recorded and
// used to slice the reporting.

/**
 * Ordered feature list. `key` is stable and stored; the order fixes the
 * coefficient vector layout.
 *
 * family     - reporting group
 * source     - 'dna_snapshot'  value read from a repaired as-of Fight DNA snapshot
 *              'dna_bout_rows' derived by walking ufc_fighter_bout_features rows
 *                              dated strictly before the bout
 *              'static'        physical constant from the fighter profile
 * higherIsBetter - documentation only. The sign is learned; a coefficient that
 *              disagrees with the fight-sense prior is worth a hard look and is
 *              flagged in the backtest report rather than silently corrected.
 */
export const FEATURES = [
  { key: 'age_diff_years',         family: 'age',        source: 'static',        higherIsBetter: false, doc: 'Age in years at the event date. Older is normally worse.' },
  { key: 'reach_diff_in',          family: 'reach',      source: 'static',        higherIsBetter: true,  doc: 'Reach in inches.' },
  { key: 'height_diff_in',         family: 'reach',      source: 'static',        higherIsBetter: true,  doc: 'Height in inches.' },

  { key: 'experience_log_diff',    family: 'experience', source: 'dna_snapshot',  higherIsBetter: true,  doc: 'log1p of completed prior bouts in the snapshot sample.' },
  { key: 'five_round_exp_diff',    family: 'experience', source: 'dna_snapshot',  higherIsBetter: true,  doc: 'log1p of prior scheduled-five-round appearances.' },
  { key: 'title_exp_diff',         family: 'experience', source: 'dna_snapshot',  higherIsBetter: true,  doc: 'log1p of prior title-bout appearances.' },

  { key: 'winrate_diff',           family: 'form',       source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Laplace-smoothed prior win rate, (w+1)/(appearances+2).' },
  { key: 'recent5_winrate_diff',   family: 'form',       source: 'dna_bout_rows', higherIsBetter: true,  doc: 'Win rate over the last five completed bouts before the event date.' },
  { key: 'streak_diff',            family: 'form',       source: 'dna_bout_rows', higherIsBetter: true,  doc: 'Signed current win or loss streak, clamped to plus or minus five.' },
  { key: 'layoff_log_diff',        family: 'form',       source: 'dna_bout_rows', higherIsBetter: false, doc: 'log1p of days since the previous bout. A long layoff is normally a negative.' },

  { key: 'slpm_diff',              family: 'striking',   source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Significant strikes landed per minute.' },
  { key: 'sapm_diff',              family: 'striking',   source: 'dna_snapshot',  higherIsBetter: false, doc: 'Significant strikes absorbed per minute.' },
  { key: 'sig_diff_per_min_diff',  family: 'striking',   source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Significant strikes landed minus absorbed, per minute.' },
  { key: 'sig_accuracy_diff',      family: 'accuracy',   source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Significant strike accuracy.' },
  { key: 'sig_defense_diff',       family: 'accuracy',   source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Significant strike defence, one minus opponent accuracy.' },
  { key: 'kd_per15_diff',          family: 'striking',   source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Knockdowns scored per fifteen minutes.' },
  { key: 'kd_absorbed_per15_diff', family: 'durability', source: 'dna_snapshot',  higherIsBetter: false, doc: 'Knockdowns conceded per fifteen minutes.' },

  { key: 'td_landed_per15_diff',   family: 'takedowns',  source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Takedowns landed per fifteen minutes.' },
  { key: 'td_accuracy_diff',       family: 'takedowns',  source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Takedown accuracy.' },
  { key: 'td_defense_diff',        family: 'takedowns',  source: 'dna_bout_rows', higherIsBetter: true,  doc: 'One minus opponent takedown accuracy across prior stat-covered bouts.' },
  { key: 'control_share_diff',     family: 'control',    source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Control time as a share of observed fight time.' },
  { key: 'sub_att_per15_diff',     family: 'control',    source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Submission attempts per fifteen minutes.' },

  { key: 'finish_rate_diff',       family: 'finishing',  source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Finishes as a share of prior wins.' },
  { key: 'ko_rate_diff',           family: 'finishing',  source: 'dna_snapshot',  higherIsBetter: true,  doc: 'KO/TKO wins as a share of prior wins.' },
  { key: 'sub_rate_diff',          family: 'finishing',  source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Submission wins as a share of prior wins.' },
  { key: 'ko_loss_rate_diff',      family: 'durability', source: 'dna_snapshot',  higherIsBetter: false, doc: 'Times stopped by strikes as a share of prior appearances.' },
  { key: 'sub_loss_rate_diff',     family: 'durability', source: 'dna_snapshot',  higherIsBetter: false, doc: 'Times submitted as a share of prior appearances.' },

  { key: 'pace_retention_diff',    family: 'pace',       source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Round-three attempt pace divided by round-one pace.' },
  { key: 'champ_round_delta_diff', family: 'pace',       source: 'dna_snapshot',  higherIsBetter: true,  doc: 'Rounds four and five pace minus rounds one to three pace.' },

  { key: 'southpaw_edge',          family: 'stance',     source: 'static',        higherIsBetter: true,  doc: 'Plus one when this corner is the only southpaw, minus one when the opponent is, otherwise zero. Antisymmetric by construction.' },

  { key: 'sos_diff',               family: 'opponent',   source: 'dna_bout_rows', higherIsBetter: true,  doc: 'Mean pre-fight win rate of prior opponents, each measured as of the date they were fought.' },
  { key: 'quality_wins_diff',      family: 'opponent',   source: 'dna_bout_rows', higherIsBetter: true,  doc: 'log1p of prior wins over opponents who were above a .600 pre-fight win rate at the time.' },

  { key: 'stat_sample_log_diff',   family: 'confidence', source: 'dna_snapshot',  higherIsBetter: true,  doc: 'log1p of stat-covered prior bouts. Carries how much evidence each corner actually has.' },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);
export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

// Columns of ufc_fighters that must never reach a feature: present-day career
// accumulators, which describe the fighter after every bout being predicted.
export const BANNED_FIGHTER_COLUMNS = [
  'record_w', 'record_l', 'record_d', 'record_nc', 'is_active', 'fight_history_count',
  'career_slpm', 'career_str_acc', 'career_sapm', 'career_str_def',
  'career_td_avg', 'career_td_acc', 'career_td_def', 'career_sub_avg',
];

// Tables that describe the bout being predicted. Label side and market side
// only; never a feature source.
export const BANNED_FEATURE_SOURCES = ['ufc_bout_results', 'ufc_bout_round_stats', 'ufc_market_observations'];
