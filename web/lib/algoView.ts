/* PBE Algo presentation logic. Pure: no I/O, no environment, testable.
 *
 * Nothing here invents a reason. "Why the Algo leans this way" is the model's
 * own arithmetic: each feature's contribution to the log-odds is
 * coefficient x (stored feature value / stored scale), read from the locked
 * prediction's feature_vector and the release artifact whose spec hash the
 * scheduler verified against the registry. The largest contributions for and
 * against the pick are shown with the feature's documented meaning, and a
 * feature that was unavailable contributes nothing and is never listed. */

import artifact from "@/lib/generated/model-v1.json";
import { RULE_TEXT } from "@/lib/pbeProduct";

export type AlgoConfidence = "LEAN" | "MEDIUM" | "HIGH";
export type AlgoGradeResult = "WIN" | "LOSS" | "DRAW" | "NC" | "VOID";

/* Market comparison written by ufc-algo (src/market.js). Stored status 'FRESH'
 * means CURRENT under the fight-week contract (scripts/odds/fight_week_cadence.mjs:
 * <= 730 min at T-7d, <= 370 min at T-72h, <= 60 min in the final 24h, where the
 * lock passes run). current_until is the instant it stops being current, so a
 * render later than the hourly cycle re-checks with a timestamp comparison, not a
 * second copy of the rules. Past it (or stored STALE): LAST OBSERVED - the odds,
 * de-vigged probability and PBE Edge stored together in that same evaluation
 * are shown as labelled history, never as current and never official.
 * Older rows (pre-2026-09-15) carry no status and are treated as stale. */
export type AlgoMarketStatus = "FRESH" | "STALE" | "UNAVAILABLE";
export type AlgoMarket = {
  status?: AlgoMarketStatus; source?: string; fresh_limit_minutes?: number; freshness_band?: string | null; age_minutes?: number | null;
  current_until?: string | null; books?: number; raw_implied_pick?: number; devigged_pick?: number; pbe_delta_pts?: number | null; stale_delta_pts?: number | null;
  observed_at?: string; oldest_book_update?: string; newest_book_update?: string;
  opponent_fighter_id?: string | null; raw_implied_opponent?: number | null; devigged_opponent?: number | null;
  pick_consensus_odds?: number | null; pick_best_odds?: number | null; pick_best_book?: string | null;
  opponent_consensus_odds?: number | null; opponent_best_odds?: number | null; opponent_best_book?: string | null;
} | null;

/**
 * Which stored market a bout card presents (read path only; nothing is computed).
 *   locked prediction      its own sample_context.market (the comparison it locked with)
 *   latest evaluation is a no-call  the evaluation's market (no-calls stay evaluation-driven)
 *   unlocked prediction    sample_context.market, which ufc-algo refreshes right after each
 *                          fight-week snapshot (A+), else the latest evaluation's market
 */
export function selectBoutMarket(
  p: { locked_at: string | null; sample_context?: { market?: AlgoMarket } | null } | null,
  e: { decision: string; market: AlgoMarket } | null | undefined,
): AlgoMarket {
  if (p?.locked_at) return p.sample_context?.market ?? null;
  if (e && e.decision !== "ELIGIBLE") return e.market ?? null;
  if (p) return p.sample_context?.market ?? e?.market ?? null;
  return e?.market ?? null;
}

/** What PBE Picks may say about the market. */
export type AlgoMarketState = "CURRENT" | "LAST_OBSERVED" | "UNAVAILABLE";
export type AlgoMarketView = {
  state: AlgoMarketState;
  /** De-vigged consensus probability for the pick: the basis of PBE Edge. */
  implied: number | null;
  /** Raw (vigged) median implied probability for the pick. */
  raw: number | null;
  /** PBE Edge in probability points; only when CURRENT. */
  delta: number | null;
  /** LAST_OBSERVED only: the PBE Edge stored in the same evaluation as this market
   *  (model probability and snapshot scored together). History, never current. */
  historicalDelta: number | null;
  /** Minutes between observation and `now` (or the lock, for a locked call). */
  age: number | null;
  observedAt: string | null;
  books: number | null;
  band: string | null;
  limitMinutes: number | null;
  pick: { consensus: number | null; best: number | null; book: string | null };
  opponent: { fighterId: string | null; consensus: number | null; best: number | null; book: string | null };
};

/** "42 min", "3.5 h", "10.2 days". */
export function ageText(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "unknown age";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

/** "14 min ago", "2h 35m ago", "3.2 days ago". */
export function agoText(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "at an unknown time";
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m ago`;
  return `${(m / 1440).toFixed(1)} days ago`;
}

/** American odds as printed: +150, -130, +100. */
export function oddsText(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? (v > 0 ? `+${v}` : `${v}`) : "\u2014";
}

/**
 * The comparison a card may present. Never a stale delta as current.
 *   locked call   the comparison recorded at lock is final: CURRENT if it was
 *                 current then, with its age at lock.
 *   otherwise     CURRENT only while `now` is before current_until (legacy rows:
 *                 observed_at + their stored limit); past it the same odds are
 *                 LAST_OBSERVED and no edge is shown.
 */
export function marketView(m: AlgoMarket, opts: { now?: number; lockedAt?: string | null } = {}): AlgoMarketView {
  const empty = { consensus: null, best: null, book: null };
  if (!m || m.status === "UNAVAILABLE" || m.devigged_pick == null) {
    return { state: "UNAVAILABLE", implied: null, raw: null, delta: null, historicalDelta: null, age: null, observedAt: null, books: null, band: null, limitMinutes: null, pick: empty, opponent: { fighterId: null, ...empty } };
  }
  const now = opts.now ?? Date.now();
  const observed = m.observed_at ? Date.parse(m.observed_at) : NaN;
  let current: boolean;
  let age: number | null;
  if (opts.lockedAt) {
    current = m.status === "FRESH";
    age = m.age_minutes ?? null;
  } else {
    const until = m.current_until ? Date.parse(m.current_until) : Number.isFinite(observed) ? observed + (m.fresh_limit_minutes ?? 60) * 60_000 : NaN;
    current = m.status === "FRESH" && Number.isFinite(until) && now < until;
    age = Number.isFinite(observed) ? Math.max(0, (now - observed) / 60_000) : m.age_minutes ?? null;
  }
  return {
    state: current ? "CURRENT" : "LAST_OBSERVED",
    implied: m.devigged_pick ?? null, raw: m.raw_implied_pick ?? null,
    delta: current ? m.pbe_delta_pts ?? null : null,
    historicalDelta: current ? null : m.pbe_delta_pts ?? m.stale_delta_pts ?? null,
    age, observedAt: m.observed_at ?? null, books: m.books ?? null, band: m.freshness_band ?? null, limitMinutes: m.fresh_limit_minutes ?? null,
    pick: { consensus: m.pick_consensus_odds ?? null, best: m.pick_best_odds ?? null, book: m.pick_best_book ?? null },
    opponent: { fighterId: m.opponent_fighter_id ?? null, consensus: m.opponent_consensus_odds ?? null, best: m.opponent_best_odds ?? null, book: m.opponent_best_book ?? null },
  };
}

/** One bout on a card, as a UFC Pro member sees it. */
export type AlgoBoutView = {
  bout_id: string;
  event_id: string;
  event_name: string;
  event_date: string;
  event_slug: string;
  fight_slug: string;
  card_position: string | null;
  order: number | null;
  fighter_a: { id: string; name: string };
  fighter_b: { id: string; name: string };
  decision: "ELIGIBLE" | "NO_MODEL_CALL" | "NOT_EVALUATED";
  reasons: string[];
  confidence: AlgoConfidence | null;
  pick_fighter_id: string | null;
  pick_probability: number | null;
  features_available: number | null;
  sample: { min_prior_bouts?: number; min_stat_bouts?: number } | null;
  market: AlgoMarket;
  model_version: string | null;
  feature_version: string | null;
  evaluated_at: string | null;
  prediction: {
    id: string;
    generated_at: string;
    locked_at: string | null;
    prob_a: number;
    prob_b: number;
    pick_fighter_id: string;
    pick_probability: number;
    confidence_band: string;
    feature_vector: Record<string, number>;
    feature_availability: Record<string, boolean>;
    market_implied_prob_pick: number | null;
    model_edge_pts: number | null;
    /** The lock-time comparison, including its status and age. */
    market?: AlgoMarket;
  } | null;
  grade: { result: AlgoGradeResult; revision: number; graded_at: string; revision_reason: string | null } | null;
  /** Every grade revision, oldest first. Record page only; superseded entries stay visible. */
  grade_history?: Array<{ result: AlgoGradeResult; revision: number; graded_at: string; revision_reason: string | null }>;
};

export const REASON_COPY: Record<string, string> = {
  EVENT_OUT_OF_SCOPE: "Not a UFC card in PBE Algo scope",
  BOUT_NOT_SCHEDULED: "Bout off the card, changed or already fought",
  IDENTITY_UNRESOLVED: "Fighter identity not fully reconciled",
  MODEL_VERSION_UNAVAILABLE: "No live model version",
  FEATURES_NOT_ASSEMBLED: "Pre-fight features could not be assembled",
  STALE_FIGHTER_DATA: "Latest fight not yet in Fight DNA",
  DEBUT_CORNER: "A fighter is making their UFC debut",
  INSUFFICIENT_FEATURES: `Fewer than ${RULE_TEXT.minFeatures} features available`,
  LOW_CONFIDENCE: `Too close to call (below ${RULE_TEXT.minPick})`,
  LOCK_WINDOW_CLOSED: "Lock window closed before a call was made",
};

export const FEATURES_TOTAL = artifact.features.length;

export function confidenceCopy(c: AlgoConfidence | null): string {
  return c === "HIGH" ? "High" : c === "MEDIUM" ? "Medium" : c === "LEAN" ? "Lean" : "—";
}

export function pctText(p: number | null | undefined, dp = 1): string {
  return p == null || !Number.isFinite(p) ? "—" : `${(p * 100).toFixed(dp)}%`;
}

export function deltaText(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} pts`;
}

/** ET wall-clock for a lock timestamp, e.g. "Sep 18 · 12:41 PM ET". */
export function lockedText(iso: string | null): string {
  if (!iso) return "Not locked";
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return `${date} · ${time} ET`;
}

export type Driver = { key: string; label: string; family: string; doc: string; contribution: number; pickMinusOpponent: number };

/** Short names for the 33 features. Differences are always PICK minus OPPONENT. */
export const FEATURE_LABEL: Record<string, string> = {
  age_diff_years: "Age (years)", reach_diff_in: "Reach (in)", height_diff_in: "Height (in)",
  experience_log_diff: "Experience (prior bouts)", five_round_exp_diff: "Five-round experience", title_exp_diff: "Title-fight experience",
  winrate_diff: "Career win rate", recent5_winrate_diff: "Last-5 win rate", streak_diff: "Current streak", layoff_log_diff: "Layoff length",
  slpm_diff: "Sig. strikes landed / min", sapm_diff: "Sig. strikes absorbed / min", sig_diff_per_min_diff: "Striking differential / min",
  sig_accuracy_diff: "Striking accuracy", sig_defense_diff: "Striking defence", kd_per15_diff: "Knockdowns scored / 15",
  kd_absorbed_per15_diff: "Knockdowns absorbed / 15", td_landed_per15_diff: "Takedowns / 15", td_accuracy_diff: "Takedown accuracy",
  td_defense_diff: "Takedown defence", control_share_diff: "Control-time share", sub_att_per15_diff: "Submission attempts / 15",
  finish_rate_diff: "Finish rate", ko_rate_diff: "KO/TKO win share", sub_rate_diff: "Submission win share",
  ko_loss_rate_diff: "Stopped by strikes", sub_loss_rate_diff: "Submitted", pace_retention_diff: "Round-3 pace retention",
  champ_round_delta_diff: "Championship-round pace", southpaw_edge: "Southpaw edge", sos_diff: "Strength of schedule",
  quality_wins_diff: "Quality wins", stat_sample_log_diff: "Stat-covered sample",
};

/**
 * Contributions to the PICKED fighter's log-odds. The stored feature vector is
 * in canonical orientation (corner 1 = the lexicographically smaller fighter
 * id), so contributions are negated when the pick is corner 2.
 */
export function drivers(pred: NonNullable<AlgoBoutView["prediction"]>, fighterAId: string, fighterBId: string): { supporting: Driver[]; opposing: Driver[]; available: number } {
  const corner1 = fighterAId < fighterBId ? fighterAId : fighterBId;
  const sign = pred.pick_fighter_id === corner1 ? 1 : -1;
  const coef = artifact.model.coefficients as Record<string, number>;
  const scale = artifact.model.feature_scale as Record<string, number>;
  const all: Driver[] = [];
  let available = 0;
  for (const f of artifact.features) {
    if (!pred.feature_availability?.[f.key]) continue;
    available += 1;
    const x = Number(pred.feature_vector?.[f.key]);
    if (!Number.isFinite(x) || !scale[f.key]) continue;
    const c = sign * coef[f.key] * (x / scale[f.key]);
    if (Math.abs(c) < 1e-6) continue;
    all.push({ key: f.key, label: FEATURE_LABEL[f.key] || f.key, family: f.family, doc: f.doc, contribution: c, pickMinusOpponent: sign * x });
  }
  const supporting = all.filter((d) => d.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 4);
  const opposing = all.filter((d) => d.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, 3);
  return { supporting, opposing, available };
}

/** One stored feature, re-oriented to PICK minus OPPONENT; null when it was unavailable. */
export function pickOriented(pred: NonNullable<AlgoBoutView["prediction"]>, fighterAId: string, fighterBId: string, key: string): number | null {
  if (!pred.feature_availability?.[key]) return null;
  const x = Number(pred.feature_vector?.[key]);
  if (!Number.isFinite(x)) return null;
  const corner1 = fighterAId < fighterBId ? fighterAId : fighterBId;
  return pred.pick_fighter_id === corner1 ? x : -x;
}

export type BandEvidence = { band: string; n: number; hitRate: number; lo: number; hi: number; meanConfidence: number };

/**
 * The out-of-sample walk-forward result for picks in the same probability band:
 * the legitimate comparable for "how often does a call like this come in". It is
 * committed release evidence (a backtest), labelled as such wherever it renders,
 * and never mixed into the live record. Interval: Wilson 95%.
 */
export function bandEvidence(p: number | null | undefined): BandEvidence | null {
  if (p == null || !Number.isFinite(p)) return null;
  const rows = artifact.evidence.by_confidence_band as Array<{ band: string; lo: number; hi: number; n: number; hits: number; hit_rate: number; mean_confidence: number }>;
  const r = rows.find((x) => p >= x.lo && (p < x.hi || (x.hi >= 1 && p <= 1)));
  if (!r || !r.n) return null;
  const z = 1.96, n = r.n, ph = r.hits / n;
  const den = 1 + (z * z) / n;
  const mid = (ph + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return { band: r.band, n, hitRate: r.hit_rate, lo: mid - half, hi: mid + half, meanConfidence: r.mean_confidence };
}

export const FAMILY_COPY: Record<string, string> = {
  age: "Age", reach: "Size & reach", experience: "Experience", form: "Form", striking: "Striking output",
  accuracy: "Accuracy", durability: "Durability", takedowns: "Takedowns", control: "Control", finishing: "Finishing",
  pace: "Pace", stance: "Stance", opponent: "Opponent quality", confidence: "Sample depth",
};

/** Status line for a bout card cell. */
export function algoStatus(b: AlgoBoutView): { label: string; tone: "locked" | "provisional" | "nocall" | "graded" | "pending" } {
  if (b.grade) return { label: b.grade.result, tone: "graded" };
  if (b.prediction?.locked_at) return { label: "LOCKED", tone: "locked" };
  if (b.decision === "ELIGIBLE" && b.prediction) return { label: "PROVISIONAL", tone: "provisional" };
  if (b.decision === "NO_MODEL_CALL") return { label: "NO MODEL CALL", tone: "nocall" };
  return { label: "AWAITING EVALUATION", tone: "pending" };
}

/* Aggregate public record. Only counts and proper scores: never a pick. */
export type AlgoPublicRecord = {
  model_version: string;
  feature_version: string;
  locked_predictions: number;
  decided: number;
  wins: number;
  losses: number;
  no_decision: number;
  pending: number;
  hit_rate: number | null;
  brier: number | null;
  first_locked_at: string | null;
  last_locked_at: string | null;
  calibration: Array<{ band: string; decided: number; predicted: number | null; observed: number | null }>;
};
