/* PBE Fight Simulator: from fetched rows to an artifact. Pure (no I/O), so the
 * whole path is testable on real fixtures; lib/simulator.ts does the reads.
 *
 * Inputs follow the engine contract (workers/ufc-simulator, Phase 2/3):
 *   - each corner's Fight DNA snapshot is the latest with as_of_date <= D that
 *     passes the EXCLUSIVE cutoff (no provenance bout dated on or after its
 *     as_of); a contaminated snapshot is skipped for the previous valid one;
 *   - the ladder is the fighter's per-bout rows dated strictly before D;
 *   - the anchor is the live PBE Fight Model probability for this pair as of
 *     D, assembled exactly as the ufc-algo Worker does (assembleBoutRow +
 *     predictOne over the registered coefficients), with only the model's DATA
 *     eligibility rules (prior bouts, features) passed to the gate. The pick
 *     publication rules (55% floor, lock window, event scope) are not
 *     simulator rules and are not applied. */
import { simulate } from "./vendor/sim-engine/simulate.mjs";
import type { SimArtifact } from "./vendor/sim-engine/simulate.mjs";
import { assembleBoutRow } from "./vendor/pbe-model/features_core.mjs";
import { FEATURE_KEYS } from "./vendor/pbe-model/feature_spec.mjs";
import { predictOne } from "./vendor/pbe-model/logistic.mjs";
import { RULES } from "./vendor/pbe-model/eligibility.mjs";
import artifact from "./generated/model-v1.json" with { type: "json" };

export const N_SIMS = 10000;

export type FighterRow = { id: string; name: string; dob: string | null; height_in: number | null; reach_in: number | null; stance: string | null };
export type SnapshotRow = Record<string, unknown> & { fighter_id: string; as_of_date: string; provenance?: { bouts?: string[] } | null };
export type BoutFeatureRow = { fighter_id: string; bout_id: string; opponent_id: string | null; event_date: string; outcome: string | null; opp_totals?: unknown };

export type CornerRows = {
  fighter: FighterRow;
  /** Candidate full snapshots, newest first, all with as_of_date <= D. */
  snapshots: SnapshotRow[];
  /** Model-feature snapshot rows (SNAPSHOT_SELECT) keyed by as_of_date. */
  modelSnapshots: Map<string, Record<string, unknown>>;
  /** Every per-bout row of this fighter (any date), used for dating provenance and for the ladder. */
  boutRows: BoutFeatureRow[];
};

export type MatchupSpec = {
  boutId: string | null;
  eventName: string;
  asOf: string;
  scheduledRounds: 3 | 5;
  weightClass: string | null;
  isTitle: boolean;
  isWomens: boolean;
};

/** Newest snapshot whose provenance contains no bout dated on or after its own as_of_date. */
export function pickValidSnapshot(snaps: SnapshotRow[], boutDates: Map<string, string>, asOf: string): { snapshot: SnapshotRow | null; rejected: string[] } {
  const rejected: string[] = [];
  for (const s of [...snaps].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))) {
    if (!(s.as_of_date <= asOf)) { rejected.push(s.as_of_date); continue; }
    const bad = (s.provenance?.bouts || []).some((id) => { const d = boutDates.get(id); return d != null && d >= s.as_of_date; });
    if (bad) { rejected.push(s.as_of_date); continue; }
    return { snapshot: s, rejected };
  }
  return { snapshot: null, rejected };
}

type ModelArtifact = { model: { model_version: string; spec_sha256: string; coefficients: Record<string, number>; feature_scale: Record<string, number> } };
const MODEL = (artifact as unknown as ModelArtifact).model;
const BETA = FEATURE_KEYS.map((k) => MODEL.coefficients[k]);
const SCALE = FEATURE_KEYS.map((k) => MODEL.feature_scale[k]);
export const CHAMPION_MODEL = { model_version: MODEL.model_version, spec_sha256: MODEL.spec_sha256 };

export type ChampionAnchor = {
  model_version: string; model_spec_sha256: string; prob: number; prob_for: string;
  eligibility: { decision: "ELIGIBLE" | "NO_MODEL_CALL"; reasons: string[] };
  available_count: number; min_prior_bouts: number;
};

/** The live PBE Fight Model probability for this pair as of spec.asOf, or null when features cannot be assembled cleanly. */
export function championAnchor(spec: MatchupSpec, a: CornerRows, b: CornerRows, chosen: Map<string, string>, opponentRows: BoutFeatureRow[]): ChampionAnchor | null {
  const D = spec.asOf;
  const fighters = new Map<string, Record<string, unknown>>([[a.fighter.id, a.fighter], [b.fighter.id, b.fighter]]);
  const snapsOf = new Map<string, Array<Record<string, unknown>>>();
  for (const c of [a, b]) {
    const asOf = chosen.get(c.fighter.id);
    const row = asOf ? c.modelSnapshots.get(asOf) : undefined;
    snapsOf.set(c.fighter.id, row ? [row] : []);
  }
  const rowsOf = new Map<string, Array<Record<string, unknown>>>();
  const add = (r: BoutFeatureRow) => { if (!(r.event_date < D)) return; const list = rowsOf.get(r.fighter_id) || []; if (!list.some((x) => x.bout_id === r.bout_id)) list.push(r as unknown as Record<string, unknown>); rowsOf.set(r.fighter_id, list); };
  for (const r of [...a.boutRows, ...b.boutRows, ...opponentRows]) add(r);
  const bout = { id: spec.boutId || "simulated-matchup", event_id: null, fighter_a_id: a.fighter.id, fighter_b_id: b.fighter.id, weight_class: spec.weightClass, is_womens: spec.isWomens, is_title: spec.isTitle, scheduled_rounds: spec.scheduledRounds, card_position: null, status: "announced" };
  const row = assembleBoutRow(bout, { name: spec.eventName, event_date: D }, fighters, snapsOf, rowsOf);
  if (row.snapshot_integrity.some((s) => s.target_in_snapshot || s.snapshot_after_event)) return null;
  const p1 = predictOne(row.x, BETA, SCALE);
  if (!Number.isFinite(p1)) return null;
  const reasons: string[] = [];
  if (row.min_prior_bouts < RULES.minPriorBoutsPerCorner) reasons.push("DEBUT_CORNER");
  if (row.available_count < RULES.minFeaturesAvailable) reasons.push("INSUFFICIENT_FEATURES");
  return {
    model_version: MODEL.model_version, model_spec_sha256: MODEL.spec_sha256, prob: p1, prob_for: row.fighter_1_id,
    eligibility: { decision: reasons.length ? "NO_MODEL_CALL" : "ELIGIBLE", reasons },
    available_count: row.available_count, min_prior_bouts: row.min_prior_bouts,
  };
}

export type SimulationResult = {
  artifact: SimArtifact;
  anchor: ChampionAnchor | null;
  snapshotAsOf: Record<string, string | null>;
  rejectedSnapshots: Record<string, string[]>;
  elapsedMs: number;
};

export function runSimulationFromRows(spec: MatchupSpec, a: CornerRows, b: CornerRows, opponentRows: BoutFeatureRow[], nSims = N_SIMS): SimulationResult {
  const D = spec.asOf;
  const chosen = new Map<string, string>();
  const corner = (c: CornerRows) => {
    const dates = new Map(c.boutRows.map((r) => [r.bout_id, r.event_date] as const));
    const { snapshot, rejected } = pickValidSnapshot(c.snapshots, dates, D);
    if (snapshot) chosen.set(c.fighter.id, snapshot.as_of_date);
    const ladder = c.boutRows.filter((r) => r.event_date < D).map((r) => ({ bout_id: r.bout_id, event_date: r.event_date, raw_stats: { opp_totals: r.opp_totals ?? null } }));
    return { input: { fighter: c.fighter, snapshot, ladder, bout_dates: Object.fromEntries(dates) }, rejected, asOf: snapshot?.as_of_date ?? null };
  };
  const ca = corner(a), cb = corner(b);
  const anchor = chosen.size === 2 ? championAnchor(spec, a, b, chosen, opponentRows) : null;
  const { artifact: out, envelope } = simulate({
    fighter_a: ca.input, fighter_b: cb.input,
    anchor: anchor ? { model_version: anchor.model_version, model_spec_sha256: anchor.model_spec_sha256, prob: anchor.prob, prob_for: anchor.prob_for, eligibility: anchor.eligibility } : null,
    settings: { scheduled_rounds: spec.scheduledRounds, weight_class: spec.weightClass, is_title: spec.isTitle, is_womens: spec.isWomens },
    n_sims: nSims,
  }, { runtime: "vercel-node" });
  return {
    artifact: out, anchor,
    snapshotAsOf: { [a.fighter.id]: ca.asOf, [b.fighter.id]: cb.asOf },
    rejectedSnapshots: { [a.fighter.id]: ca.rejected, [b.fighter.id]: cb.rejected },
    elapsedMs: envelope.elapsed_ms,
  };
}
