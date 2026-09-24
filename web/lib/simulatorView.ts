/* Presentation model for the PBE Fight Simulator page. Pure: no I/O, no React.
 *
 * What the page may show, per docs/FIGHT_SIMULATOR_PHASE3.md section 13:
 *   READY               winner probability (anchored to the PBE Fight Model)
 *   LIMITED / labelled  method distribution, goes distance, strike volume and
 *                       takedown-attempt ranges, the representative path
 *   NOT READY (hidden)  finish round, finish time or window, round winners,
 *                       point estimates for control, takedowns landed,
 *                       knockdowns, submission attempts, pace retention
 * Every number below is read from the simulator artifact; nothing is derived
 * that the engine did not produce, except the per-method sums across fighters. */
import type { SimArtifact, RoundStats, SimCoverage } from "./vendor/sim-engine/simulate.mjs";

export type SimGate = "FULL" | "LIMITED" | "INSUFFICIENT_DATA";

export const UNAVAILABLE_COPY = "Not enough verified Fight DNA history to simulate this matchup reliably yet.";

/* Phase 3 walk-forward figures (docs/FIGHT_SIMULATOR_PHASE3.md sections 4-5, 4,149 simulated bouts, 2016-2026). */
export const MODEL_CARD = Object.freeze({
  evaluation: "Walk-forward 2016–2026, 4,519 bouts (4,149 simulated), each scored only with data and parameters from earlier years",
  rows: [
    { metric: "Winner Brier", simulator: "0.2327", baseline: "0.2328", baselineLabel: "PBE Fight Model alone" },
    { metric: "Method log loss", simulator: "0.9729", baseline: "1.0034", baselineLabel: "weight-class frequency" },
    { metric: "Goes-distance Brier", simulator: "0.2394", baseline: "0.2459", baselineLabel: "weight-class frequency" },
  ],
  notShown: [
    "finish round or finish time",
    "round-by-round winners",
    "point estimates for control time, takedowns landed, knockdowns or submission attempts",
    "pace-retention claims",
  ],
});

/** Gate as the reader sees it. The engine calls a clean pass OFFICIAL; the page calls it FULL. */
export function simGate(a: SimArtifact | null): SimGate {
  if (!a || a.status === "INSUFFICIENT_DATA" || a.status === "REJECTED_SNAPSHOT" || !a.probabilities) return "INSUFFICIENT_DATA";
  return a.status === "LIMITED" ? "LIMITED" : "FULL";
}

export const pct = (p: number | null | undefined, digits = 1): string => (p == null || !Number.isFinite(p) ? "—" : `${(p * 100).toFixed(digits)}%`);

export type MethodRow = { key: "KO_TKO" | "SUB" | "DEC"; label: string; total: number; f1: number; f2: number };

/** KO/TKO, Submission, Decision across both fighters, straight from artifact.methods. Draw is carried separately. */
export function methodRows(a: SimArtifact): { rows: MethodRow[]; draw: number; sum: number } {
  const m = a.methods!;
  const rows: MethodRow[] = [
    { key: "KO_TKO", label: "KO/TKO", f1: m.fighter_1_ko, f2: m.fighter_2_ko, total: m.fighter_1_ko + m.fighter_2_ko },
    { key: "SUB", label: "Submission", f1: m.fighter_1_sub, f2: m.fighter_2_sub, total: m.fighter_1_sub + m.fighter_2_sub },
    { key: "DEC", label: "Decision", f1: m.fighter_1_dec, f2: m.fighter_2_dec, total: m.fighter_1_dec + m.fighter_2_dec },
  ];
  const draw = a.probabilities?.draw ?? 0;
  return { rows, draw, sum: rows.reduce((s, r) => s + r.total, 0) + draw };
}

export type WinView = { f1: number; f2: number; draw: number; favouriteSide: "fighter_1" | "fighter_2" | null };
export function winView(a: SimArtifact): WinView {
  const p = a.probabilities!;
  return { f1: p.fighter_1_win, f2: p.fighter_2_win, draw: p.draw, favouriteSide: p.fighter_1_win === p.fighter_2_win ? null : p.fighter_1_win > p.fighter_2_win ? "fighter_1" : "fighter_2" };
}

/** Volume ranges shown as the middle 50% of fully fought simulated rounds. Only the LIMITED-ready stats. */
export const RANGE_STATS = [
  { key: "sig_l", label: "Sig. strikes landed" },
  { key: "sig_a", label: "Sig. strikes attempted" },
  { key: "td_a", label: "Takedown attempts" },
] as const;

export type RangeRow = { round: number; fightsReaching: number; f1: Record<string, string>; f2: Record<string, string> };
const range = (s: RoundStats[keyof RoundStats] | undefined) => (s && s.p25 != null && s.p75 != null ? (s.p25 === s.p75 ? `${s.p25}` : `${s.p25}–${s.p75}`) : "—");

export function roundRanges(a: SimArtifact): RangeRow[] {
  const per = a.distribution?.per_round || [];
  return per
    .filter((r) => r.fights_reaching > 0)
    .map((r) => ({
      round: r.round,
      fightsReaching: r.fights_reaching,
      f1: Object.fromEntries(RANGE_STATS.map((s) => [s.key, range(r.f1[s.key])])),
      f2: Object.fromEntries(RANGE_STATS.map((s) => [s.key, range(r.f2[s.key])])),
    }));
}

export type PathView = {
  winnerSide: "fighter_1" | "fighter_2";
  winnerName: string;
  methodLabel: string;
  roundsShown: number;
  cellShare: number;
  rounds: Array<{ round: number; f1: { sig_l: number; sig_a: number; td_a: number }; f2: { sig_l: number; sig_a: number; td_a: number } }>;
};
const METHOD_LABEL: Record<string, string> = { KO_TKO: "KO/TKO", SUB: "submission", DEC: "decision", DRAW: "draw" };

/** The medoid path, reduced to what may be shown: winner, method, and per-round strike and takedown-attempt counts.
 *  Knockdowns, control, takedowns landed, submission attempts, PBE round scores and the finish time are dropped. */
export function pathView(a: SimArtifact): PathView | null {
  const cp = a.canonical_projection;
  if (!cp) return null;
  const pick = (s: Record<string, number>) => ({ sig_l: s.sig_l, sig_a: s.sig_a, td_a: s.td_a });
  return {
    winnerSide: cp.winner,
    winnerName: cp.winner_name,
    methodLabel: METHOD_LABEL[cp.method] || cp.method,
    roundsShown: cp.rounds.length,
    cellShare: cp.selection.cell_share,
    rounds: cp.rounds.map((r) => ({ round: r.round, f1: pick(r.fighter_1), f2: pick(r.fighter_2) })),
  };
}

export const COVERAGE_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low", insufficient: "Insufficient", none: "No Fight DNA" };

export function coverageLine(c: SimCoverage | undefined): string {
  if (!c) return "No Fight DNA";
  return `${COVERAGE_LABEL[c.coverage_status] || c.coverage_status} · ${c.sample_stat_bouts} stat bouts · ${c.sample_rounds} rounds`;
}

/** Why a simulation is LIMITED or unavailable, in reader language. */
export function gateReasons(a: SimArtifact | null): string[] {
  const out: string[] = [];
  for (const r of a?.coverage?.reasons || a?.reasons || []) {
    const code = (r as { code: string }).code;
    if (code === "coverage_low") out.push("One or both fighters have low Fight DNA coverage, so round-level volume is less certain.");
    else if (code === "anchor_not_eligible") out.push("The PBE Fight Model has thin evidence for this pairing (a debut-level corner or too few pre-fight features).");
    else if (code === "many_fallbacks") out.push("Several Fight DNA metrics fall back to division-wide priors for this pairing.");
    else if (code === "coverage_insufficient" || code === "no_stat_bouts" || code === "no_snapshot") out.push("A fighter has no verified round-level UFC history yet.");
    else if (code === "metric_availability_low") out.push("Too few Fight DNA metrics are available for a fighter.");
    else if (code === "anchor_missing") out.push("The PBE Fight Model could not assemble a pre-fight probability for this pairing.");
    else if (code === "snapshot_contains_bout_on_or_after_as_of") out.push("A Fight DNA snapshot failed the as-of integrity check.");
  }
  return [...new Set(out)];
}

/** Coverage-based availability for list rows, mirroring the engine gate's tier thresholds (FULL: both medium+; LIMITED: both low+). */
export function expectedGate(t1: string | null, t2: string | null): SimGate {
  const rank = (t: string | null) => (t === "high" ? 3 : t === "medium" ? 2 : t === "low" ? 1 : 0);
  const lo = Math.min(rank(t1), rank(t2));
  return lo >= 2 ? "FULL" : lo >= 1 ? "LIMITED" : "INSUFFICIENT_DATA";
}
