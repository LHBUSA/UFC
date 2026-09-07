/* PropBetEdge Fight DNA — central metric glossary.
 *
 * One dictionary for every technical label the UI shows. Definitions mirror
 * the versioned registry (docs/FIGHT_DNA_CONTRACT.md, migrations/004 and the
 * builder registry, definition_version 1) — nothing here redefines a metric,
 * and the UI never recomputes one. Plain-English lines translate a
 * definition; they never grade a value. Benchmarks, percentiles and words
 * like "elite" or "poor" are deliberately absent because no benchmark exists
 * in the data system. */

export type DnaFamily = "quick" | "coverage" | "stance" | "striking" | "grappling" | "finish" | "round" | "context" | "matchup";

export type GlossaryEntry = {
  key: string;
  shortLabel: string;
  fullName: string;
  plainEnglish: string;
  unitExplanation?: string;
  caution?: string;
  formula?: string;
  family: DnaFamily;
  /* result metrics count bouts; rate metrics count observed seconds */
  kind: "result" | "rate" | "record" | "distribution";
  learnAnchor: string;
  /* Short line shown under a tile when EXPLAIN STATS is on. */
  learnLine: string;
};

const RATE_UNIT_MIN = "Per minute of observed, stat-covered fight time.";
const RATE_UNIT_15 = "Normalized to 15 minutes of observed fight time (the length of a standard three-round bout).";
const SHARE_UNIT = "A share of this fighter's own significant-strike attempts, so the six shares describe where the offense went, not how much landed.";

export const GLOSSARY: Record<string, GlossaryEntry> = {
  /* ---- striking ------------------------------------------------------- */
  sig_landed_per_min: { key: "sig_landed_per_min", shortLabel: "Sig. landed / min", fullName: "Significant strikes landed per minute", family: "striking", kind: "rate", learnAnchor: "striking",
    plainEnglish: "Offensive striking pace normalized by observed fight time: how many significant strikes this fighter landed for every minute the round stats cover.",
    unitExplanation: RATE_UNIT_MIN, formula: "sig_str_landed / observed_minutes",
    caution: "More volume is not automatically better. Accuracy, defense, position and opponent context matter too.",
    learnLine: "Striking pace: significant strikes landed for every minute observed." },
  sig_absorbed_per_min: { key: "sig_absorbed_per_min", shortLabel: "Sig. absorbed / min", fullName: "Significant strikes absorbed per minute", family: "striking", kind: "rate", learnAnchor: "striking-defense",
    plainEnglish: "How many significant strikes opponents landed on this fighter for each observed minute.",
    unitExplanation: RATE_UNIT_MIN, formula: "opponent_sig_str_landed / observed_minutes",
    caution: "This is exposure, not a complete measure of defense. A high-pace fighter can absorb more simply by being in more exchanges.",
    learnLine: "Exposure: significant strikes taken for every minute observed." },
  sig_diff_per_min: { key: "sig_diff_per_min", shortLabel: "Strike differential / min", fullName: "Significant strike differential per minute", family: "striking", kind: "rate", learnAnchor: "striking",
    plainEnglish: "Significant strikes landed minus significant strikes absorbed, per observed minute. Positive means this fighter landed more than they took.",
    unitExplanation: RATE_UNIT_MIN, formula: "(sig_str_landed − opponent_sig_str_landed) / observed_minutes",
    learnLine: "Landed minus absorbed, per minute observed." },
  sig_accuracy: { key: "sig_accuracy", shortLabel: "Sig. accuracy", fullName: "Significant strike accuracy", family: "striking", kind: "rate", learnAnchor: "pace-vs-accuracy",
    plainEnglish: "The share of significant-strike attempts that landed.",
    unitExplanation: "A percentage of this fighter's own attempts.", formula: "sig_str_landed / sig_str_att",
    caution: "Accuracy rises when a fighter throws less and picks shots; read it together with pace.",
    learnLine: "How often a thrown significant strike landed." },
  sig_defense: { key: "sig_defense", shortLabel: "Sig. defense", fullName: "Significant strike defense", family: "striking", kind: "rate", learnAnchor: "striking-defense",
    plainEnglish: "The share of opponents' significant-strike attempts that did not land.",
    unitExplanation: "A percentage of the opponents' attempts.", formula: "1 − opponent_sig_str_landed / opponent_sig_str_att",
    caution: "Defense counts avoided attempts, not damage. It says nothing about the strikes that did get through.",
    learnLine: "How often an opponent's significant strike missed." },
  head_attack_share: { key: "head_attack_share", shortLabel: "Head share", fullName: "Head attack share", family: "striking", kind: "rate", learnAnchor: "targeting",
    plainEnglish: "The share of this fighter's significant-strike attempts aimed at the head.", unitExplanation: SHARE_UNIT, formula: "head_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown at the head." },
  body_attack_share: { key: "body_attack_share", shortLabel: "Body share", fullName: "Body attack share", family: "striking", kind: "rate", learnAnchor: "targeting",
    plainEnglish: "The share of this fighter's significant-strike attempts aimed at the body.", unitExplanation: SHARE_UNIT, formula: "body_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown at the body." },
  leg_attack_share: { key: "leg_attack_share", shortLabel: "Leg share", fullName: "Leg attack share", family: "striking", kind: "rate", learnAnchor: "targeting",
    plainEnglish: "The share of this fighter's significant-strike attempts aimed at the legs.", unitExplanation: SHARE_UNIT, formula: "leg_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown at the legs." },
  distance_attack_share: { key: "distance_attack_share", shortLabel: "Distance share", fullName: "Distance attack share", family: "striking", kind: "rate", learnAnchor: "position",
    plainEnglish: "The share of this fighter's significant-strike attempts thrown at distance (on the feet, not in the clinch).", unitExplanation: SHARE_UNIT, formula: "distance_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown at distance." },
  clinch_attack_share: { key: "clinch_attack_share", shortLabel: "Clinch share", fullName: "Clinch attack share", family: "striking", kind: "rate", learnAnchor: "position",
    plainEnglish: "The share of this fighter's significant-strike attempts thrown in the clinch.", unitExplanation: SHARE_UNIT, formula: "clinch_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown in the clinch." },
  ground_attack_share: { key: "ground_attack_share", shortLabel: "Ground share", fullName: "Ground attack share", family: "striking", kind: "rate", learnAnchor: "position",
    plainEnglish: "The share of this fighter's significant-strike attempts thrown on the ground.", unitExplanation: SHARE_UNIT, formula: "ground_att / sig_str_att",
    learnLine: "Share of significant-strike attempts thrown on the ground." },
  knockdowns_per_15: { key: "knockdowns_per_15", shortLabel: "Knockdowns / 15", fullName: "Knockdowns per 15 minutes", family: "striking", kind: "rate", learnAnchor: "striking",
    plainEnglish: "Knockdowns scored, normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "kd × 900 / observed_seconds",
    caution: "Knockdowns are rare events; small samples move this number a lot.",
    learnLine: "Knockdowns scored per 15 minutes observed." },
  kd_per_15: { key: "kd_per_15", shortLabel: "Knockdowns / 15", fullName: "Knockdowns per 15 minutes", family: "striking", kind: "rate", learnAnchor: "striking",
    plainEnglish: "Knockdowns scored, normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "kd × 900 / observed_seconds",
    caution: "Knockdowns are rare events; small samples move this number a lot.",
    learnLine: "Knockdowns scored per 15 minutes observed." },
  knockdowns_absorbed_per_15: { key: "knockdowns_absorbed_per_15", shortLabel: "KD absorbed / 15", fullName: "Knockdowns absorbed per 15 minutes", family: "striking", kind: "rate", learnAnchor: "striking-defense",
    plainEnglish: "Times this fighter was knocked down, normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "opponent_kd × 900 / observed_seconds",
    learnLine: "Times knocked down per 15 minutes observed." },
  kd_absorbed_per_15: { key: "kd_absorbed_per_15", shortLabel: "KD absorbed / 15", fullName: "Knockdowns absorbed per 15 minutes", family: "striking", kind: "rate", learnAnchor: "striking-defense",
    plainEnglish: "Times this fighter was knocked down, normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "opponent_kd × 900 / observed_seconds",
    learnLine: "Times knocked down per 15 minutes observed." },

  /* ---- grappling ------------------------------------------------------ */
  td_attempts_per_15: { key: "td_attempts_per_15", shortLabel: "TD attempts / 15", fullName: "Takedown attempts per 15 minutes", family: "grappling", kind: "rate", learnAnchor: "takedowns",
    plainEnglish: "Takedown activity normalized to the length of a standard three-round UFC fight.", unitExplanation: RATE_UNIT_15, formula: "td_att × 900 / observed_seconds",
    learnLine: "How often this fighter shoots, per 15 minutes observed." },
  td_landed_per_15: { key: "td_landed_per_15", shortLabel: "TD landed / 15", fullName: "Takedowns landed per 15 minutes", family: "grappling", kind: "rate", learnAnchor: "takedowns",
    plainEnglish: "Successful takedowns normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "td_landed × 900 / observed_seconds",
    learnLine: "Takedowns completed per 15 minutes observed." },
  td_accuracy: { key: "td_accuracy", shortLabel: "TD accuracy", fullName: "Takedown accuracy", family: "grappling", kind: "rate", learnAnchor: "takedowns",
    plainEnglish: "The share of takedown attempts that were completed.", unitExplanation: "A percentage of this fighter's own attempts.", formula: "td_landed / td_att",
    caution: "A fighter who rarely shoots can post a high accuracy from a handful of attempts.",
    learnLine: "How often a takedown attempt succeeded." },
  control_seconds_per_td: { key: "control_seconds_per_td", shortLabel: "Control / TD", fullName: "Control time per takedown", family: "grappling", kind: "rate", learnAnchor: "control",
    plainEnglish: "How much recorded control time followed each successful takedown.", unitExplanation: "Seconds of control for every takedown landed.", formula: "ctrl_sec / td_landed",
    caution: "Control time is recorded per round by the source; it is not split by position or by who initiated the grappling.",
    learnLine: "Seconds of control time generated per landed takedown." },
  control_share: { key: "control_share", shortLabel: "Control share", fullName: "Control share of observed time", family: "grappling", kind: "rate", learnAnchor: "control",
    plainEnglish: "The share of observed fight time this fighter spent in recorded control.", unitExplanation: "A percentage of all observed, stat-covered seconds.", formula: "ctrl_sec / observed_seconds",
    learnLine: "Share of observed fight time spent in control." },
  sub_attempts_per_15: { key: "sub_attempts_per_15", shortLabel: "Sub attempts / 15", fullName: "Submission attempts per 15 minutes", family: "grappling", kind: "rate", learnAnchor: "submissions",
    plainEnglish: "Submission attempts normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "sub_att × 900 / observed_seconds",
    learnLine: "Submission attempts per 15 minutes observed." },
  reversals_per_15: { key: "reversals_per_15", shortLabel: "Reversals / 15", fullName: "Reversals per 15 minutes", family: "grappling", kind: "rate", learnAnchor: "control",
    plainEnglish: "Position reversals (as recorded by the source) normalized to 15 minutes of observed fight time.", unitExplanation: RATE_UNIT_15, formula: "rev × 900 / observed_seconds",
    learnLine: "Recorded position reversals per 15 minutes observed." },

  /* ---- finish --------------------------------------------------------- */
  finish_rate: { key: "finish_rate", shortLabel: "Finish rate", fullName: "Finish rate of wins", family: "finish", kind: "result", learnAnchor: "finish-rate",
    plainEnglish: "The percentage of recorded wins ending by KO/TKO or submission rather than decision.", unitExplanation: "A percentage of wins, not of all bouts.", formula: "(ko_tko_wins + submission_wins) / wins",
    caution: "A fighter with two wins and two finishes shows 100%. Read the sample beside it.",
    learnLine: "Share of wins that ended before a decision." },
  ko_finish_rate: { key: "ko_finish_rate", shortLabel: "KO/TKO share", fullName: "KO/TKO share of wins", family: "finish", kind: "result", learnAnchor: "finish-rate",
    plainEnglish: "The percentage of recorded wins that came by knockout or technical knockout.", unitExplanation: "A percentage of wins.", formula: "ko_tko_wins / wins",
    learnLine: "Share of wins by KO or TKO." },
  submission_finish_rate: { key: "submission_finish_rate", shortLabel: "Submission share", fullName: "Submission share of wins", family: "finish", kind: "result", learnAnchor: "finish-rate",
    plainEnglish: "The percentage of recorded wins that came by submission.", unitExplanation: "A percentage of wins.", formula: "submission_wins / wins",
    learnLine: "Share of wins by submission." },
  finish_time_median_sec: { key: "finish_time_median_sec", shortLabel: "Median finish time", fullName: "Median finish time", family: "finish", kind: "result", learnAnchor: "finish-rate",
    plainEnglish: "The median elapsed fight time of this fighter's finish wins, counted from the opening bell across rounds.", unitExplanation: "Minutes:seconds of total fight time; a 2:30 finish in round two shows as 7:30.", formula: "median((round − 1) × 300 + time_sec) over finish wins",
    learnLine: "Typical elapsed time when this fighter's finishes arrive." },
  finish_round_distribution: { key: "finish_round_distribution", shortLabel: "Finish wins by round", fullName: "Finish round distribution", family: "finish", kind: "distribution", learnAnchor: "finish-rate",
    plainEnglish: "How many of this fighter's finish wins ended in each round.", formula: "count finish wins by round",
    learnLine: "Which round the finishes came in." },
  finished_by_round_distribution: { key: "finished_by_round_distribution", shortLabel: "Finished by round", fullName: "Finished-by round distribution", family: "finish", kind: "distribution", learnAnchor: "finish-rate",
    plainEnglish: "How many of this fighter's KO/TKO or submission losses ended in each round.", formula: "count finish losses by round",
    learnLine: "Which round the losses by stoppage came in." },

  /* ---- round profile -------------------------------------------------- */
  sig_att_per_min: { key: "sig_att_per_min", shortLabel: "Attempts / min", fullName: "Significant-strike attempts per minute (this round)", family: "round", kind: "rate", learnAnchor: "round-profiles",
    plainEnglish: "Significant strikes attempted per observed minute of this round number, pooled across the sample.", unitExplanation: RATE_UNIT_MIN, formula: "rN_sig_str_att / rN_observed_minutes",
    learnLine: "Striking output attempted in this round, per minute observed." },
  pace_retention_r2_vs_r1: { key: "pace_retention_r2_vs_r1", shortLabel: "R2 pace retention", fullName: "Round-two pace retention", family: "round", kind: "rate", learnAnchor: "round-profiles",
    plainEnglish: "Round-two significant-strike attempt pace divided by round-one pace, over bouts where both rounds are covered. 100% means round two matched round one.", unitExplanation: "A ratio shown as a percentage of the round-one pace.", formula: "r2_sig_att_per_min / r1_sig_att_per_min",
    caution: "Only bouts with both rounds covered count, so early finishes are excluded by construction.",
    learnLine: "How much of the round-one output carried into round two." },
  pace_retention_r3_vs_r1: { key: "pace_retention_r3_vs_r1", shortLabel: "R3 pace retention", fullName: "Round-three pace retention", family: "round", kind: "rate", learnAnchor: "round-profiles",
    plainEnglish: "Round-three significant-strike attempt pace divided by round-one pace, over bouts where both rounds are covered.", unitExplanation: "A ratio shown as a percentage of the round-one pace.", formula: "r3_sig_att_per_min / r1_sig_att_per_min",
    caution: "Only bouts that reached round three with stats count.",
    learnLine: "How much of the round-one output carried into round three." },
  championship_round_delta: { key: "championship_round_delta", shortLabel: "Championship-round delta", fullName: "Championship-round pace delta", family: "round", kind: "rate", learnAnchor: "round-profiles",
    plainEnglish: "Rounds 4–5 significant-attempt pace minus rounds 1–3 pace, over bouts that reached round four. Negative means output fell in the championship rounds.", unitExplanation: "Attempts per minute, as a difference.", formula: "late_round_sig_att_per_min − early_round_sig_att_per_min",
    learnLine: "Change in output once a fight reaches rounds four and five." },
  defensive_drift_r3_vs_r1: { key: "defensive_drift_r3_vs_r1", shortLabel: "Defensive drift R3 vs R1", fullName: "Defensive drift, round three versus round one", family: "round", kind: "rate", learnAnchor: "round-profiles",
    plainEnglish: "Significant strikes absorbed per minute in round three minus the round-one rate, over bouts with both rounds covered. Positive means more strikes were getting through late.", unitExplanation: "Strikes absorbed per minute, as a difference.", formula: "r3_absorbed_per_min − r1_absorbed_per_min",
    learnLine: "Change in strikes taken per minute from round one to round three." },

  /* ---- stance ---------------------------------------------------------- */
  stance_record: { key: "stance_record", shortLabel: "Record", fullName: "Record versus opponent stance", family: "stance", kind: "record", learnAnchor: "stance-splits",
    plainEnglish: "Wins, losses, draws and no-contests against opponents with this listed stance.", formula: "aggregate outcomes grouped by opponent_stance",
    caution: "Historical split, not causation. Stance is the opponent's listed stance at the source, not observed switching.",
    learnLine: "Results against this listed stance." },
  stance_appearances: { key: "stance_appearances", shortLabel: "Appearances", fullName: "Appearances versus opponent stance", family: "stance", kind: "record", learnAnchor: "stance-splits",
    plainEnglish: "Completed bouts against opponents with this listed stance.",
    learnLine: "Bouts in this split." },
  stance_finish_rate: { key: "stance_finish_rate", shortLabel: "Finish rate", fullName: "Finish rate versus opponent stance", family: "stance", kind: "result", learnAnchor: "stance-splits",
    plainEnglish: "KO/TKO plus submission wins divided by wins against this listed stance.", unitExplanation: "A percentage of wins in the split.", formula: "(ko_tko_wins + submission_wins) / wins_vs_stance",
    learnLine: "Share of wins in this split that ended early." },
  stance_ko_rate: { key: "stance_ko_rate", shortLabel: "KO/TKO rate", fullName: "KO/TKO rate versus opponent stance", family: "stance", kind: "result", learnAnchor: "stance-splits",
    plainEnglish: "KO/TKO wins divided by completed appearances against this listed stance.", unitExplanation: "A percentage of appearances, not of wins.", formula: "ko_tko_wins / completed_appearances_vs_stance",
    learnLine: "Share of appearances in this split won by KO/TKO." },
  stance_sub_rate: { key: "stance_sub_rate", shortLabel: "Submission rate", fullName: "Submission rate versus opponent stance", family: "stance", kind: "result", learnAnchor: "stance-splits",
    plainEnglish: "Submission wins divided by completed appearances against this listed stance.", unitExplanation: "A percentage of appearances, not of wins.", formula: "submission_wins / completed_appearances_vs_stance",
    learnLine: "Share of appearances in this split won by submission." },
  stance_sig_diff_per_min: { key: "stance_sig_diff_per_min", shortLabel: "Strike differential / min", fullName: "Significant strike differential per minute versus opponent stance", family: "stance", kind: "rate", learnAnchor: "stance-splits",
    plainEnglish: "Significant strikes landed minus absorbed, per observed minute, in bouts against this listed stance.", unitExplanation: RATE_UNIT_MIN, formula: "(sig_str_landed − opponent_sig_str_landed) / observed_minutes",
    learnLine: "Landed minus absorbed per minute, inside this split." },
  stance_td_rate_15: { key: "stance_td_rate_15", shortLabel: "Takedowns / 15", fullName: "Takedowns landed per 15 minutes versus opponent stance", family: "stance", kind: "rate", learnAnchor: "stance-splits",
    plainEnglish: "Takedowns landed per 15 observed minutes in bouts against this listed stance.", unitExplanation: RATE_UNIT_15, formula: "td_landed × 900 / observed_seconds",
    learnLine: "Takedowns completed per 15 minutes, inside this split." },
  stance_kd_rate_15: { key: "stance_kd_rate_15", shortLabel: "Knockdowns / 15", fullName: "Knockdowns per 15 minutes versus opponent stance", family: "stance", kind: "rate", learnAnchor: "stance-splits",
    plainEnglish: "Knockdowns scored per 15 observed minutes in bouts against this listed stance.", unitExplanation: RATE_UNIT_15, formula: "kd × 900 / observed_seconds",
    learnLine: "Knockdowns per 15 minutes, inside this split." },

  /* ---- context --------------------------------------------------------- */
  three_round_record: { key: "three_round_record", shortLabel: "3-round bouts", fullName: "Three-round record", family: "context", kind: "record", learnAnchor: "context-splits", plainEnglish: "Results in bouts scheduled for three rounds.", formula: "aggregate outcomes where scheduled_rounds = 3", learnLine: "Results in three-round fights." },
  five_round_record: { key: "five_round_record", shortLabel: "5-round bouts", fullName: "Five-round record", family: "context", kind: "record", learnAnchor: "context-splits", plainEnglish: "Results in bouts scheduled for five rounds.", formula: "aggregate outcomes where scheduled_rounds = 5", learnLine: "Results in five-round fights." },
  title_bout_record: { key: "title_bout_record", shortLabel: "Title bouts", fullName: "Title bout record", family: "context", kind: "record", learnAnchor: "context-splits", plainEnglish: "Results in bouts contested for a title.", formula: "aggregate outcomes where is_title", learnLine: "Results in title fights." },
  main_event_record: { key: "main_event_record", shortLabel: "Main events", fullName: "Main event record", family: "context", kind: "record", learnAnchor: "context-splits", plainEnglish: "Results when the bout was the last on its card (highest bout order).", formula: "aggregate outcomes where is_main_event", learnLine: "Results in main events." },
  short_notice_record: { key: "short_notice_record", shortLabel: "Short notice", fullName: "Short-notice record", family: "context", kind: "record", learnAnchor: "context-splits", plainEnglish: "Results in bouts that carry a verified short-notice value in the record.", formula: "aggregate outcomes where short_notice_days is not null", caution: "Only bouts with a verified short-notice value are counted; the absence of a split does not mean a fighter never took short notice.", learnLine: "Results in verified short-notice bouts." },
};

/* Labels used by the existing UI map to glossary keys here so no definition
 * lives inside JSX. */
export const LABEL_KEY: Record<string, string> = {
  "Sig. landed / min": "sig_landed_per_min", "Sig. absorbed / min": "sig_absorbed_per_min", "Sig. accuracy": "sig_accuracy", "Sig. defence": "sig_defense", "Sig. defense": "sig_defense",
  "Head share": "head_attack_share", "Body share": "body_attack_share", "Leg share": "leg_attack_share", "Distance share": "distance_attack_share", "Clinch share": "clinch_attack_share", "Ground share": "ground_attack_share",
  "Knockdowns / 15": "knockdowns_per_15", "KD absorbed / 15": "knockdowns_absorbed_per_15",
  "TD attempts / 15": "td_attempts_per_15", "TD landed / 15": "td_landed_per_15", "TD accuracy": "td_accuracy", "Control / TD": "control_seconds_per_td", "Control share": "control_share", "Sub attempts / 15": "sub_attempts_per_15", "Reversals / 15": "reversals_per_15",
  "Finish rate (of wins)": "finish_rate", "Finish rate": "finish_rate", "KO/TKO share of wins": "ko_finish_rate", "Sub share of wins": "submission_finish_rate", "Submission share of wins": "submission_finish_rate", "Median finish time": "finish_time_median_sec",
  "R2 pace retention": "pace_retention_r2_vs_r1", "R3 pace retention": "pace_retention_r3_vs_r1", "Championship-round delta": "championship_round_delta", "Defensive drift R3 vs R1": "defensive_drift_r3_vs_r1",
  "KO/TKO rate": "stance_ko_rate", "Submission rate": "stance_sub_rate", "Sig. diff / min": "stance_sig_diff_per_min", "TD landed / 15 (stance)": "stance_td_rate_15",
};

export function lookup(keyOrLabel: string): GlossaryEntry | null {
  return GLOSSARY[keyOrLabel] || GLOSSARY[LABEL_KEY[keyOrLabel] || ""] || null;
}

/* ---- families ------------------------------------------------------------ */
export const FAMILY: Record<Exclude<DnaFamily, "quick" | "coverage">, { title: string; subtitle: string; anchor: string; primary: string[] }> = {
  finish: { title: "Finish DNA", subtitle: "How this fighter's recorded wins end and when they tend to end.", anchor: "finish-rate", primary: ["finish_rate", "ko_finish_rate", "submission_finish_rate", "finish_time_median_sec"] },
  striking: { title: "Striking DNA", subtitle: "Pace, efficiency, defensive exposure, targets and where exchanges occur.", anchor: "striking", primary: ["sig_landed_per_min", "sig_absorbed_per_min", "sig_accuracy", "sig_defense"] },
  grappling: { title: "Grappling DNA", subtitle: "Takedown activity, success, control and submission pressure.", anchor: "takedowns", primary: ["td_attempts_per_15", "td_landed_per_15", "td_accuracy", "control_seconds_per_td"] },
  round: { title: "Round profile", subtitle: "How pace and defensive performance change from round to round.", anchor: "round-profiles", primary: [] },
  stance: { title: "Stance DNA", subtitle: "Historical results against opponents with different listed stances.", anchor: "stance-splits", primary: [] },
  context: { title: "Context splits", subtitle: "How the recorded results differ across fight formats and situations.", anchor: "context-splits", primary: [] },
  matchup: { title: "Matchup DNA", subtitle: "Two fighter histories. One matchup-specific intelligence layer.", anchor: "matchup", primary: [] },
};

/* ---- confidence (documented thresholds, definition v1) -------------------- */
export const CONFIDENCE_EXPLAINER = {
  summary: "Confidence reflects the amount of supporting sample for this metric. It does not mean PropBetEdge is predicting the fighter will reproduce the number in the next fight.",
  tiers: [
    { key: "high", label: "High", short: "larger supporting sample", detail: "Result metrics: 8 or more bouts. Rate metrics: 5,400 or more observed seconds (90 minutes)." },
    { key: "medium", label: "Medium", short: "useful but still limited sample", detail: "Result metrics: 3–7 bouts. Rate metrics: 1,800–5,399 observed seconds (30–89 minutes)." },
    { key: "low", label: "Low", short: "small sample — interpret carefully", detail: "The metric's minimum is met, but result metrics have fewer than 3 bouts or rate metrics fewer than 1,800 observed seconds (30 minutes)." },
    { key: "insufficient", label: "Insufficient", short: "not enough observed evidence to publish the metric", detail: "Below the metric's registry minimum (minimum bouts, rounds or seconds), or no denominator at all. The value is withheld rather than shown as zero." },
  ],
  source: "Thresholds are the definition v1 rules recorded in the Fight DNA contract; they are applied by the builder, not by this page.",
} as const;

export const PBE_DERIVED_EXPLAINER = {
  title: "PBE Derived",
  body: "Calculated by PropBetEdge from normalized event, bout and round-level source records using a versioned Fight DNA definition. It is not an official UFC statistic, is not simply copied from a source page, and is not a prediction.",
  fields: ["Definition", "Sample", "Confidence", "As of"],
} as const;

export const SAMPLE_EXPLAINER = {
  title: "Why sample size matters",
  body: "A fighter with one observed round should not be interpreted the same way as a fighter with many fully captured fights. Every Fight DNA number is shown with the bouts, rounds and minutes behind it, and its confidence tier follows that sample rather than the size of the number.",
} as const;

export const SOURCE_VS_DERIVED = {
  source: ["Event date and venue", "Bout result, method and round", "Significant strikes landed and attempted", "Takedowns landed and attempted", "Control time, knockdowns, submission attempts", "Per-round UFC Stats rows"],
  derived: ["Stance-specific records and finish rates", "Significant-strike differential by opponent stance", "Head / body / leg target shares", "Distance / clinch / ground position shares", "Pace retention round to round", "Finish-round distributions and median finish time", "Per-15-minute normalized takedown, knockdown and submission rates", "Control time per takedown and control share", "Matchup comparisons and supported observations"],
} as const;

/* ---- Quick Read: fact translation, never judgment -------------------------- */
export type QuickFact = { key: string; text: string; confidence: string; sample: string };

type MetricLike = { value: number | null; unit?: string; confidence: string; sample_bouts?: number; sample_rounds?: number; sample_seconds?: number; numerator?: number | null; denominator?: number | null };

const RANK: Record<string, number> = { insufficient: 0, low: 1, medium: 2, high: 3 };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const two = (v: number) => v.toFixed(2);

function sampleText(m: MetricLike): string {
  const parts: string[] = [];
  if (m.sample_bouts != null) parts.push(`${m.sample_bouts} bout${m.sample_bouts === 1 ? "" : "s"}`);
  if (m.sample_rounds) parts.push(`${m.sample_rounds} round${m.sample_rounds === 1 ? "" : "s"}`);
  if (m.sample_seconds) parts.push(`${Math.round(m.sample_seconds / 60)} min`);
  return parts.join(" · ");
}

/* Each translator states the stored fact in plain English with its scope.
 * Wording is fixed per metric; no adjectives, no benchmarks. */
const TRANSLATE: Array<{ key: string; priority: number; text: (m: MetricLike) => string | null }> = [
  { key: "finish_rate", priority: 10, text: (m) => m.value == null ? null : m.value >= 0.999 ? "All archived wins in this sample ended before a decision." : m.value <= 0.001 ? "Every archived win in this sample went to a decision." : `${pct(m.value)} of archived wins in this sample ended by KO/TKO or submission.` },
  { key: "sig_landed_per_min", priority: 9, text: (m) => m.value == null ? null : `${two(m.value)} significant strikes were landed per minute across the observed round-stat sample.` },
  { key: "sig_absorbed_per_min", priority: 8, text: (m) => m.value == null ? null : `${two(m.value)} significant strikes per minute were absorbed across the same observed sample.` },
  { key: "sig_accuracy", priority: 7, text: (m) => m.value == null ? null : `${pct(m.value)} of significant-strike attempts landed.` },
  { key: "sig_defense", priority: 6, text: (m) => m.value == null ? null : `${pct(m.value)} of opponents' significant-strike attempts did not land.` },
  { key: "head_attack_share", priority: 5, text: (m) => m.value == null ? null : `${pct(m.value)} of recorded significant-strike offense targeted the head.` },
  { key: "distance_attack_share", priority: 5, text: (m) => m.value == null ? null : `${pct(m.value)} of recorded significant-strike offense occurred at distance.` },
  { key: "td_landed_per_15", priority: 6, text: (m) => m.value == null ? null : m.value === 0 ? "No takedowns were landed across the observed round-stat sample." : `${two(m.value)} takedowns were landed per 15 observed minutes.` },
  { key: "td_attempts_per_15", priority: 4, text: (m) => m.value == null ? null : m.value === 0 ? "No takedowns were attempted across the observed round-stat sample." : `${two(m.value)} takedowns were attempted per 15 observed minutes.` },
  { key: "control_share", priority: 4, text: (m) => m.value == null ? null : `${pct(m.value)} of observed fight time was spent in recorded control.` },
  { key: "sub_attempts_per_15", priority: 3, text: (m) => m.value == null || m.value === 0 ? null : `${two(m.value)} submission attempts were recorded per 15 observed minutes.` },
  { key: "ko_finish_rate", priority: 5, text: (m) => m.value == null || m.value === 0 ? null : `${pct(m.value)} of archived wins came by KO/TKO.` },
  { key: "submission_finish_rate", priority: 5, text: (m) => m.value == null || m.value === 0 ? null : `${pct(m.value)} of archived wins came by submission.` },
];

export function quickRead(metrics: Record<string, MetricLike | undefined>, finish: Record<string, MetricLike | undefined>, max = 6): QuickFact[] {
  const pool: Array<QuickFact & { score: number }> = [];
  for (const t of TRANSLATE) {
    const m = metrics[t.key] || finish[t.key];
    if (!m || m.value == null || (RANK[m.confidence] ?? 0) < 1) continue;
    const text = t.text(m);
    if (!text) continue;
    pool.push({ key: t.key, text, confidence: m.confidence, sample: sampleText(m), score: (RANK[m.confidence] ?? 0) * 100 + t.priority });
  }
  /* Balance the read: at most two target/position shares, and never absorbed without landed. */
  const out: QuickFact[] = [];
  let shares = 0;
  for (const f of pool.sort((a, b) => b.score - a.score)) {
    if (/_attack_share$/.test(f.key)) { if (shares >= 2) continue; shares += 1; }
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}
