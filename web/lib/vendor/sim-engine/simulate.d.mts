/* Types for the vendored engine (simulate.mjs). Hand-written declarations; the .mjs is a byte copy. */
export type Stat = { median: number | null; p25: number | null; p75: number | null };
export type RoundStats = Record<"sig_l" | "sig_a" | "td_l" | "td_a" | "ctrl" | "kd" | "sub", Stat>;
export type SimFighter = { id: string; name: string; stance: string | null; reach_in: number | null; height_in: number | null; snapshot_as_of: string | null; coverage_status: string };
export type SimCoverage = { coverage_status: string; sample_bouts: number; sample_stat_bouts: number; sample_rounds: number; sample_seconds: number; metric_availability: { required: number; observed: number; ratio: number }; fallbacks: number };
export type SimArtifact = {
  status: "OFFICIAL" | "LIMITED" | "INSUFFICIENT_DATA" | "REJECTED_SNAPSHOT";
  simulation_id?: string; simulator_family?: string; simulator_version: string; engine_spec_sha256?: string;
  model_version?: string | null; model_spec_sha256?: string | null; dna_definition_version?: number;
  generated_from_as_of?: { fighter_1: string | null; fighter_2: string | null; data_through: string | null };
  scheduled_rounds?: number; n_sims?: number; inputs_sha256?: string; artifact_sha256?: string;
  fighters?: { fighter_1: SimFighter; fighter_2: SimFighter };
  probabilities: { fighter_1_win: number; fighter_2_win: number; draw: number; goes_distance: number } | null;
  methods: { fighter_1_ko: number; fighter_1_sub: number; fighter_1_dec: number; fighter_2_ko: number; fighter_2_sub: number; fighter_2_dec: number } | null;
  finish_distribution?: unknown;
  outcome_by_round?: Array<{ round: number; reaches_round: number; fighter_1_ko: number; fighter_1_sub: number; fighter_2_ko: number; fighter_2_sub: number; any_finish: number }>;
  distribution?: { fight_totals: unknown; per_round: Array<{ round: number; fights_reaching: number; f1: RoundStats; f2: RoundStats; round_win: unknown }> };
  canonical_projection: null | {
    winner: "fighter_1" | "fighter_2"; winner_id: string; winner_name: string; method: "KO_TKO" | "SUB" | "DEC" | "DRAW"; round: number | null;
    precision: "time" | "round"; selection: { rule: string; cell: string; cell_share: number; cell_size: number; method_conditional?: number };
    rounds: Array<{ round: number; fighter_1: Record<string, number>; fighter_2: Record<string, number> }>;
  };
  anchor?: { pre_anchor_probability: number; champion_probability: number; post_anchor_probability: number; tilt_applied: number; status: string; residual_within_tolerance: boolean; max_tilt: number } | null;
  coverage?: { fighter_1: SimCoverage; fighter_2: SimCoverage; gate: "FULL" | "LIMITED" | "INSUFFICIENT"; reasons: Array<{ code: string } & Record<string, unknown>>; message: string | null };
  reasons?: Array<{ fighter: string; code: string }>; message?: string;
};
export type SimInputCorner = { fighter: { id: string; name: string; stance?: string | null; reach_in?: number | null; height_in?: number | null }; snapshot: Record<string, unknown> | null; ladder: Array<Record<string, unknown>>; bout_dates?: Record<string, string> };
export function simulate(req: {
  fighter_a: SimInputCorner; fighter_b: SimInputCorner;
  anchor: { model_version: string; model_spec_sha256: string; prob: number; prob_for: string; eligibility?: { decision: string; reasons: string[] } } | null;
  settings: { scheduled_rounds: number; weight_class?: string | null; is_title?: boolean; is_womens?: boolean };
  n_sims?: number;
}, opts?: { runtime?: string; now?: () => string }): { artifact: SimArtifact; envelope: { generated_at: string; runtime: string; elapsed_ms: number }; input_order?: string };
