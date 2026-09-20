import "server-only";
import fs from "node:fs";
import { cache } from "react";
import type { UfcAccess } from "@/lib/accessDecision";
import { eventSlug, matchupSlug } from "@/lib/slug";
import { selectBoutMarket, type AlgoBoutView, type AlgoPublicRecord } from "@/lib/algoView";
import artifact from "@/lib/generated/model-v1.json";
import { ufcSiteDate } from "@/lib/siteClock";
import { getCurrentOrNextUfcEvent } from "@/lib/currentEvent";
import {
  ArchiveReadError, UNRESOLVED_EVENT, calibrationSummary, eventOfPrediction, loadIndex, lockPrice, oneUnitReturn, pageOfEvent, paginate, readByIds, recentGradedIds, summarizePerformance,
  type ArchiveIndex, type ArchiveIntegrity, type CalibrationSummary, type EventSummary, type GradeResult, type IndexPred, type PerformanceSlice,
} from "@/lib/algoArchive";

/* PBE Algo data access. Server only.
 *
 * PUBLIC functions return aggregate proof plus sanitized, graded historical
 * proof only — never an upcoming or provisional fighter call.
 * PRO functions take the request's verified access decision and refuse to read
 * a single pick for anyone without it: the check is inside the data layer, so a
 * page that forgets to gate still cannot fetch the data, let alone render it.
 *
 * Local QA only: PBE_ALGO_FIXTURE_FILE (never honoured on Vercel) replaces the
 * card/record reads with a fixture built from a real scheduler dry run, so the
 * Pro surfaces and the leak matrix can be exercised before the first lock. */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MODEL_VERSION = artifact.model.model_version;

export class ProRequiredError extends Error {
  constructor() { super("pbe_algo_requires_ufc_pro"); }
}
function requirePro(access: Pick<UfcAccess, "pro">) {
  if (access?.pro !== true) throw new ProRequiredError();
}

function fixture(): { bouts: AlgoBoutView[]; record: AlgoPublicRecord } | null {
  const file = process.env.PBE_ALGO_FIXTURE_FILE;
  if (!file || process.env.VERCEL || process.env.VERCEL_ENV) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function rest<T>(path: string): Promise<T[]> {
  if (!URL_ || !KEY) return [];
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    console.error(`[algo] ${path.split("?")[0]} -> HTTP ${res.status}`);
    return [];
  }
  return (await res.json()) as T[];
}
/* The archive's reader. rest() above answers a failed read with an empty list,
 * which is right for an optional module and wrong for a record: "no picks" and
 * "could not read the picks" must never render the same. This one throws. */
async function restStrict<T>(path: string): Promise<T[]> {
  if (!URL_ || !KEY) throw new ArchiveReadError("record store is not configured");
  let res: Response;
  try {
    res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, accept: "application/json" }, cache: "no-store" });
  } catch (e) {
    throw new ArchiveReadError(`${path.split("?")[0]} unreachable: ${String((e as Error)?.message || e).slice(0, 120)}`);
  }
  if (!res.ok) throw new ArchiveReadError(`${path.split("?")[0]} -> HTTP ${res.status}`);
  return (await res.json()) as T[];
}
const inList = (ids: string[]) => `(${[...new Set(ids)].map((x) => `"${x}"`).join(",")})`;

/* ---- public: aggregate proof only -------------------------------------- */

/** True once the release is registered live in ufc_model_versions. Uncached: an
 *  existence question whose answer flips exactly once. Fails closed. */
export async function algoLive(): Promise<boolean> {
  if (fixture()) return true;
  const rows = await rest<{ status: string }>(`ufc_model_versions?model_version=eq.${encodeURIComponent(MODEL_VERSION)}&status=eq.live&select=status`);
  return rows.length > 0;
}

export async function getAlgoPublicRecord(): Promise<AlgoPublicRecord> {
  const fx = fixture();
  if (fx) return fx.record;
  type Rec = { locked_predictions: number | null; decided: number | null; wins: number | null; losses: number | null; no_decision: number | null; pending: number | null; hit_rate: number | null; brier: number | null; first_locked_at: string | null; last_locked_at: string | null; feature_version: string | null };
  type Cal = { confidence_band: string; decided: number | null; predicted: number | null; observed: number | null };
  const q = `model_version=eq.${encodeURIComponent(MODEL_VERSION)}`;
  const [rec, cal] = await Promise.all([
    rest<Rec>(`ufc_model_live_record?${q}&select=locked_predictions,decided,wins,losses,no_decision,pending,hit_rate,brier,first_locked_at,last_locked_at,feature_version`),
    rest<Cal>(`ufc_model_live_calibration?${q}&select=confidence_band,decided,predicted,observed&order=confidence_band.asc`),
  ]);
  const r = rec[0];
  return {
    model_version: MODEL_VERSION,
    feature_version: r?.feature_version || artifact.model.feature_version,
    locked_predictions: Number(r?.locked_predictions || 0),
    decided: Number(r?.decided || 0),
    wins: Number(r?.wins || 0),
    losses: Number(r?.losses || 0),
    no_decision: Number(r?.no_decision || 0),
    pending: Number(r?.pending || 0),
    hit_rate: r?.hit_rate ?? null,
    brier: r?.brier ?? null,
    first_locked_at: r?.first_locked_at ?? null,
    last_locked_at: r?.last_locked_at ?? null,
    calibration: cal.map((c) => ({ band: c.confidence_band, decided: Number(c.decided || 0), predicted: c.predicted, observed: c.observed })),
  };
}


export type AlgoUpsetProof = {
  showcase_threshold_odds: number;
  total: number;
  decided: number;
  wins: number;
  losses: number;
  no_decision: number;
  hit_rate: number | null;
  average_consensus_odds: number | null;
  /** True when the record could not be read; the counts are then placeholders. */
  unavailable?: boolean;
  /** The canonical lifetime slice this subset was cut from: the same object the
   *  archive and the tracker report, so every surface reconciles. */
  official_lifetime?: PerformanceSlice;
  biggest_wins: Array<{
    prediction_id: string;
    event_name: string;
    event_date: string;
    pick_name: string;
    opponent_name: string;
    consensus_odds: number;
    best_odds: number | null;
    pick_probability: number;
    market_implied_prob: number | null;
    model_edge_pts: number | null;
    result: "WIN";
    locked_at: string;
  }>;
};

const UPSET_SHOWCASE_THRESHOLD_ODDS = 120;

export function isMarketOppositePick(
  market: AlgoBoutView["market"],
  pickProbability: number | string | null | undefined,
): boolean {
  const marketPick = Number(market?.devigged_pick);
  const marketOpponent = Number(market?.devigged_opponent);
  const modelPick = Number(pickProbability);
  return Number.isFinite(marketPick)
    && Number.isFinite(marketOpponent)
    && Number.isFinite(modelPick)
    && marketOpponent > marketPick
    && modelPick > 0.5;
}

const EMPTY_UPSET_PROOF = (): AlgoUpsetProof => ({
  showcase_threshold_odds: UPSET_SHOWCASE_THRESHOLD_ODDS,
  total: 0, decided: 0, wins: 0, losses: 0, no_decision: 0,
  hit_rate: null, average_consensus_odds: null, biggest_wins: [],
});

/**
 * Public sales proof for PBE Upset Radar.
 *
 * This reader is intentionally historical-only: a row must be LOCKED and have
 * a current official grade before its fighter identity can leave the data
 * layer. Upcoming/provisional calls remain behind getAlgoCards/getAlgoBout.
 * An Upset Radar call is mechanical, not editorial: the de-vigged market
 * probability makes the OPPONENT the favorite, while PBE selects the opposite
 * fighter as its pick (>50% model probability). Showcase cards are wins at
 * +120 or longer, while the aggregate includes every graded market-opposite
 * call so losses cannot disappear from the record.
 */
export async function getAlgoUpsetProof(): Promise<AlgoUpsetProof> {
  const fx = fixture();
  if (fx) {
    const rows = fx.bouts
      .filter((b) => b.prediction?.locked_at && b.grade)
      .map((b) => {
        const odds = Number(b.market?.pick_consensus_odds);
        if (!Number.isFinite(odds) || !isMarketOppositePick(b.market, b.prediction!.pick_probability)) return null;
        const pick = b.pick_fighter_id === b.fighter_a.id ? b.fighter_a : b.fighter_b;
        const opponent = b.pick_fighter_id === b.fighter_a.id ? b.fighter_b : b.fighter_a;
        return {
          prediction_id: b.prediction!.id,
          event_name: b.event_name, event_date: b.event_date,
          pick_name: pick.name, opponent_name: opponent.name,
          consensus_odds: odds,
          best_odds: b.market?.pick_best_odds == null ? null : Number(b.market.pick_best_odds),
          pick_probability: Number(b.prediction!.pick_probability),
          market_implied_prob: b.prediction!.market_implied_prob_pick == null ? null : Number(b.prediction!.market_implied_prob_pick),
          model_edge_pts: b.prediction!.model_edge_pts == null ? null : Number(b.prediction!.model_edge_pts),
          result: b.grade!.result,
          locked_at: b.prediction!.locked_at!,
        };
      })
      .filter(Boolean) as Array<Record<string, any>>;
    const wins = rows.filter((r) => r.result === "WIN").length;
    const losses = rows.filter((r) => r.result === "LOSS").length;
    const decided = wins + losses;
    return {
      showcase_threshold_odds: UPSET_SHOWCASE_THRESHOLD_ODDS,
      total: rows.length, decided, wins, losses, no_decision: rows.length - decided,
      hit_rate: decided ? wins / decided : null,
      average_consensus_odds: rows.length ? rows.reduce((n, r) => n + r.consensus_odds, 0) / rows.length : null,
      biggest_wins: rows.filter((r) => r.result === "WIN" && r.consensus_odds >= UPSET_SHOWCASE_THRESHOLD_ODDS)
        .sort((a, b) => b.consensus_odds - a.consensus_odds).slice(0, 3),
    } as AlgoUpsetProof;
  }

  /* The Upset Radar record is a SUBSET of the canonical full-history index, never
   * its own read: every officially locked pick of every official model version,
   * graded by the revision in force, counted by the same summarizePerformance()
   * the archive and the tracker use. A failed read is reported as unavailable
   * rather than as an empty record. */
  let index: ArchiveIndex;
  try {
    index = await archiveIndex(null);
  } catch (e) {
    console.error(`[algo-record] upset proof read failed: ${String((e as Error)?.message || e)}`);
    return { ...EMPTY_UPSET_PROOF(), unavailable: true };
  }
  const market = (p: IndexPred): AlgoBoutView["market"] => ({ devigged_pick: p.devigged_pick == null ? undefined : Number(p.devigged_pick), devigged_opponent: p.devigged_opponent == null ? null : Number(p.devigged_opponent) });
  const upset = index.preds.filter((p) => index.gradeBy.has(p.id) && lockPrice(p.consensus_odds) != null && isMarketOppositePick(market(p), p.pick_probability));
  if (!upset.length) return { ...EMPTY_UPSET_PROOF(), official_lifetime: index.lifetime };
  const slice = summarizePerformance(upset, index.gradeBy);
  const odds = (p: IndexPred) => lockPrice(p.consensus_odds)!;
  const showcase = upset
    .filter((p) => index.gradeBy.get(p.id)!.result === "WIN" && odds(p) >= UPSET_SHOWCASE_THRESHOLD_ODDS)
    .sort((a, b) => odds(b) - odds(a) || a.id.localeCompare(b.id))
    .slice(0, 3);
  let biggest_wins: AlgoUpsetProof["biggest_wins"] = [];
  try {
    const picks = await archivePicks(index, showcase.map((p) => p.id));
    biggest_wins = showcase.flatMap((p) => {
      const v = picks.find((x) => x.prediction_id === p.id);
      const ev = index.events.find((e) => e.graded_prediction_ids.includes(p.id)) || null;
      if (!v || v.result !== "WIN") return [];
      return [{
        prediction_id: v.prediction_id, event_name: ev?.event_name || "Event not resolved", event_date: ev?.event_date || "",
        pick_name: v.pick.name, opponent_name: v.opponent.name, consensus_odds: odds(p), best_odds: v.lock_price,
        pick_probability: v.pick_probability, market_implied_prob: v.market_implied_prob, model_edge_pts: v.model_edge_pts,
        result: "WIN" as const, locked_at: v.locked_at,
      }];
    });
  } catch (e) {
    console.error(`[algo-record] upset showcase read failed: ${String((e as Error)?.message || e)}`);
  }
  return {
    showcase_threshold_odds: UPSET_SHOWCASE_THRESHOLD_ODDS,
    total: upset.length, decided: slice.decided, wins: slice.wins, losses: slice.losses, no_decision: slice.no_decision, hit_rate: slice.hit_rate,
    average_consensus_odds: upset.reduce((n, p) => n + odds(p), 0) / upset.length,
    biggest_wins,
    official_lifetime: index.lifetime,
  };
}

export type AlgoFreeSamplePick = {
  slot: "BEST_BET" | "UNDERDOG_VALUE" | "NEXT_BEST";
  lifecycle: "LOCKED" | "PROVISIONAL";
  event_name: string;
  event_date: string;
  matchup: string;
  pick_name: string;
  opponent_name: string;
  model_probability: number;
  consensus_odds: number;
  best_odds: number | null;
  best_book: string | null;
  market_probability: number | null;
  edge_pts: number | null;
  confidence: AlgoBoutView["confidence"];
  observed_at: string | null;
  is_upset_pick: boolean;
  upset_rank: number | null;
  is_top_upset: boolean;
};

export type AlgoFreeSample = {
  contract: "pbe-free-sample-v1";
  sport: "UFC";
  generated_at: string;
  /** Backward-compatible primary pick: always the BEST_BET slot when available. */
  pick: AlgoFreeSamplePick | null;
  /** Public sampler: best bet plus a qualifying +money underdog when one exists.
   * If no underdog qualifies, the second slot is simply the next-best model call. */
  picks: AlgoFreeSamplePick[];
  underdog_available: boolean;
  full_product_url: string;
};

/** Deliberately small public top-of-funnel sampler. Never returns more than
 * two fighter selections and never exposes feature vectors, the rest of the
 * card, historical rows or any account-only payload. Locked calls keep their
 * lock-time market; provisional calls require a market that is still current. */
export async function getAlgoFreeSample(): Promise<AlgoFreeSample> {
  type SampleBout = { id: string; fighter_a: { id: string; name: string }; fighter_b: { id: string; name: string }; event: { id: string; name: string; event_date: string } };
  type SampleEval = { bout_id: string; decision: string; confidence: AlgoBoutView["confidence"]; pick_fighter_id: string | null; pick_probability: number | null; market: AlgoBoutView["market"]; evaluated_at: string };
  type SamplePred = { bout_id: string; locked_at: string | null; pick_fighter_id: string; pick_probability: number | string; market_implied_prob_pick: number | string | null; model_edge_pts: number | string | null; sample_context: { confidence?: AlgoBoutView["confidence"]; market?: AlgoBoutView["market"] } | null };
  type SampleResult = { bout_id: string };

  const generated_at = new Date().toISOString();
  const empty = (): AlgoFreeSample => ({ contract: "pbe-free-sample-v1", sport: "UFC", generated_at, pick: null, picks: [], underdog_available: false, full_product_url: "https://ufc.propbetedge.ai/algo" });
  if (!(await algoLive())) return empty();

  const today = ufcSiteDate(Date.parse(generated_at));
  const until = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const bouts = await rest<SampleBout>(
    `ufc_bouts?select=id,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name),event:ufc_events!inner(id,name,event_date)&event.event_date=gte.${today}&event.event_date=lte.${until}&event.name=like.UFC*&order=bout_order.desc`
  );
  if (!bouts.length) return empty();
  const ids = inList(bouts.map((b) => b.id));
  const [evals, preds, results] = await Promise.all([
    rest<SampleEval>(`ufc_model_card_current?bout_id=in.${ids}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=bout_id,decision,confidence,pick_fighter_id,pick_probability,market,evaluated_at`),
    rest<SamplePred>(`ufc_model_predictions?bout_id=in.${ids}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=bout_id,locked_at,pick_fighter_id,pick_probability,market_implied_prob_pick,model_edge_pts,sample_context`),
    rest<SampleResult>(`ufc_bout_results?bout_id=in.${ids}&select=bout_id`),
  ]);
  const boutBy = new Map(bouts.map((b) => [b.id, b]));
  const evalBy = new Map(evals.map((e) => [e.bout_id, e]));
  const completed = new Set(results.map((r) => r.bout_id));
  const candidates = bouts.flatMap((bout) => {
    // The public sample is a current-call surface, not a receipt ledger. As
    // soon as a verified result lands, retire that bout and advance to the
    // next eligible pick. Completed picks remain permanently visible in the
    // public track record instead of occupying the live sample.
    if (completed.has(bout.id)) return [];
    const p = preds.find((row) => row.bout_id === bout.id) || null;
    const e = evalBy.get(bout.id) || null;
    const locked = Boolean(p?.locked_at);
    const market = locked ? p?.sample_context?.market ?? null : p?.sample_context?.market ?? e?.market ?? null;
    const pickId = p?.pick_fighter_id ?? e?.pick_fighter_id ?? null;
    const probability = Number(p?.pick_probability ?? e?.pick_probability);
    const confidence = p?.sample_context?.confidence ?? e?.confidence ?? null;
    const currentUntil = market?.current_until ? Date.parse(market.current_until) : NaN;
    const current = market?.status === "FRESH" && (locked || (Number.isFinite(currentUntil) && currentUntil > Date.now()));
    const odds = Number(market?.pick_consensus_odds);
    if (!current || !pickId || !Number.isFinite(probability) || !Number.isFinite(odds)) return [];
    if (!locked && e?.decision !== "ELIGIBLE") return [];
    const pick = pickId === bout.fighter_a.id ? bout.fighter_a : pickId === bout.fighter_b.id ? bout.fighter_b : null;
    if (!pick) return [];
    const opponent = pick.id === bout.fighter_a.id ? bout.fighter_b : bout.fighter_a;
    const edge = p?.model_edge_pts ?? market?.pbe_delta_pts ?? null;
    return [{
      lifecycle: locked ? "LOCKED" as const : "PROVISIONAL" as const,
      event_name: bout.event.name,
      event_date: bout.event.event_date,
      matchup: `${bout.fighter_a.name} vs ${bout.fighter_b.name}`,
      pick_name: pick.name,
      opponent_name: opponent.name,
      model_probability: probability,
      consensus_odds: odds,
      best_odds: market?.pick_best_odds == null ? null : Number(market.pick_best_odds),
      best_book: market?.pick_best_book ?? null,
      market_probability: p?.market_implied_prob_pick == null ? (market?.devigged_pick == null ? null : Number(market.devigged_pick)) : Number(p.market_implied_prob_pick),
      edge_pts: edge == null ? null : Number(edge),
      confidence,
      observed_at: market?.observed_at ?? null,
      is_upset_pick: isMarketOppositePick(market, probability),
      upset_rank: null as number | null,
      is_top_upset: false,
    }];
  });

  // Use the same mechanical Upset Radar definition as the UFC product:
  // market favors the opponent, while PBE gives the selected fighter >50%.
  // Ranking is edge-first, then longer odds, matching the current radar.
  const upsetRank = new Map(
    candidates
      .filter((c) => c.is_upset_pick)
      .sort((a, b) => (b.edge_pts ?? -999) - (a.edge_pts ?? -999) || b.consensus_odds - a.consensus_odds)
      .map((c, index) => [`${c.event_name}|${c.pick_name}|${c.opponent_name}`, index + 1])
  );

  const ranked = candidates
    .map((c) => {
      const rank = upsetRank.get(`${c.event_name}|${c.pick_name}|${c.opponent_name}`) ?? null;
      return { ...c, upset_rank: rank, is_top_upset: rank === 1 };
    })
    .sort((a, b) => {
      if (a.lifecycle !== b.lifecycle) return a.lifecycle === "LOCKED" ? -1 : 1;
      return (b.edge_pts ?? -999) - (a.edge_pts ?? -999);
    });

  // Public board slots:
  // 1) BEST BET prefers the strongest non-upset call so the sampler shows a
  //    conventional model play alongside the dog.
  // 2) UNDERDOG VALUE is the strongest distinct +money market-opposite call
  //    with positive model edge. We never manufacture a dog just to fill space.
  //    If no dog qualifies, NEXT BEST keeps the sampler at two distinct calls.
  const keyOf = (c: typeof ranked[number]) => `${c.event_name}|${c.pick_name}|${c.opponent_name}`;
  const underdog = ranked
    .filter((c) => c.is_upset_pick && c.consensus_odds > 0 && (c.edge_pts ?? 0) > 0)
    .sort((a, b) => (b.edge_pts ?? -999) - (a.edge_pts ?? -999) || b.consensus_odds - a.consensus_odds)[0] || null;
  const underdogKey = underdog ? keyOf(underdog) : null;
  const regular = ranked.find((c) => !c.is_upset_pick && keyOf(c) !== underdogKey)
    || ranked.find((c) => keyOf(c) !== underdogKey)
    || ranked[0]
    || null;
  const bestBet = regular ? { ...regular, slot: "BEST_BET" as const } : null;
  const bestKey = regular ? keyOf(regular) : null;
  const second = underdog && keyOf(underdog) !== bestKey
    ? { ...underdog, slot: "UNDERDOG_VALUE" as const }
    : ranked.find((c) => keyOf(c) !== bestKey)
      ? { ...ranked.find((c) => keyOf(c) !== bestKey)!, slot: "NEXT_BEST" as const }
      : null;
  const picks: AlgoFreeSamplePick[] = [bestBet, second].filter((p): p is AlgoFreeSamplePick => Boolean(p));

  return {
    contract: "pbe-free-sample-v1",
    sport: "UFC",
    generated_at,
    pick: bestBet,
    picks,
    underdog_available: Boolean(underdog),
    full_product_url: "https://ufc.propbetedge.ai/algo",
  };
}

/** PBE Algo is issuing official calls: the release is registered live AND the
 *  scheduler has completed an armed cycle in the last 48 hours. Product state,
 *  not a route: marketing surfaces use this, never the existence of /algo.
 *  Uncached (an existence question), fails closed. */
export async function algoCallsActive(): Promise<boolean> {
  if (fixture()) return process.env.PBE_ALGO_FIXTURE_ACTIVE === "1";
  if (!(await algoLive())) return false;
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const runs = await rest<{ id: string }>(`ufc_model_runs?select=id&mode=eq.armed&status=eq.ok&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&finished_at=gte.${since}&limit=1`);
  return runs.length > 0;
}


export type AlgoPerformanceSlice = PerformanceSlice;

export type AlgoPerformanceProof = {
  generated_at: string;
  /** True when the record could not be read. The numbers are then empty
   *  placeholders and the tracker must say so instead of showing 0-0. */
  unavailable?: boolean;
  lifetime: AlgoPerformanceSlice;
  fight_week: (AlgoPerformanceSlice & {
    event_id: string;
    event_name: string;
    event_date: string;
  }) | null;
  last_result: {
    prediction_id: string;
    event_name: string;
    event_date: string;
    matchup: string;
    pick_name: string;
    opponent_name: string;
    result: GradeResult;
    graded_at: string;
    locked_at: string;
    best_odds: number | null;
    net_units: number | null;
  } | null;
};

/* ---- public: the full-history archive ------------------------------------ */

/** Every officially locked pick, every grade revision and the events they
 *  name: read once per request (React cache), uncached across requests so a new
 *  grade is on the next render with no publish step. See lib/algoArchive.ts for
 *  the population, the no-row-cap scan and the ROI methodology. */
const archiveIndex = cache(async (model: string | null): Promise<ArchiveIndex> => {
  const index = await loadIndex(restStrict, { today: ufcSiteDate(), model });
  const i = index.integrity;
  if (i.orphan_grade_predictions || i.unresolved_event_picks || i.duplicate_prediction_ids.length || i.duplicate_grade_ids.length) {
    console.error(`[algo-record] integrity ${JSON.stringify({ orphan_grade_predictions: i.orphan_grade_predictions, unresolved_event_picks: i.unresolved_event_picks, duplicate_prediction_ids: i.duplicate_prediction_ids.length, duplicate_grade_ids: i.duplicate_grade_ids.length })}`);
  }
  if (index.overdue.length) console.error(`[algo-record] grading_overdue ${JSON.stringify(index.overdue)}`);
  return index;
});

export type ArchiveRevision = { revision: number; result: GradeResult; graded_at: string; revision_reason: string | null; source: string | null; method: string | null; graded_by: string | null };
/** One publicly graded pick. Built field by field: no feature vector, no draft
 *  state, nothing from an evaluation row. */
export type ArchivePick = {
  prediction_id: string;
  event_id: string;
  bout_id: string;
  fight_slug: string | null;
  order: number | null;
  fighter_a: { id: string; name: string };
  fighter_b: { id: string; name: string };
  pick: { id: string; name: string };
  opponent: { id: string; name: string };
  locked_at: string;
  pick_probability: number;
  confidence: AlgoBoutView["confidence"];
  confidence_band: string;
  model_version: string;
  feature_version: string;
  lock_price: number | null;
  lock_book: string | null;
  consensus_odds: number | null;
  market_implied_prob: number | null;
  model_edge_pts: number | null;
  market_status: string | null;
  market_source: string | null;
  market_books: number | null;
  market_observed_at: string | null;
  result: GradeResult;
  graded_at: string;
  net_units: number | null;
  revisions: ArchiveRevision[];
};

type ArchivePredRow = {
  id: string; bout_id: string; event_id: string | null; fighter_a_id: string; fighter_b_id: string; model_version: string; feature_version: string;
  locked_at: string; pick_fighter_id: string; pick_probability: number | string; confidence_band: string;
  market_implied_prob_pick: number | string | null; model_edge_pts: number | string | null; market_books: number | null; market_snapshot_at: string | null;
  sample_context: { confidence?: AlgoBoutView["confidence"]; market?: AlgoBoutView["market"] } | null;
};
type ArchiveGradeRow = ArchiveRevision & { prediction_id: string };
const ARCHIVE_PRED_SELECT = "id,bout_id,event_id,fighter_a_id,fighter_b_id,model_version,feature_version,locked_at,pick_fighter_id,pick_probability,confidence_band,market_implied_prob_pick,model_edge_pts,market_books,market_snapshot_at,sample_context";

/** Identity for GRADED prediction ids only. The ids come from the index's
 *  graded list, and a row is dropped again here unless it is locked and its
 *  grade history is non-empty, so an ungraded pick cannot be materialized even
 *  if a caller passes its id. */
async function archivePicks(index: ArchiveIndex, ids: string[]): Promise<ArchivePick[]> {
  const graded = ids.filter((id) => index.gradeBy.has(id));
  if (!graded.length) return [];
  const [preds, grades] = await Promise.all([
    readByIds<ArchivePredRow>(restStrict, "ufc_model_predictions", ARCHIVE_PRED_SELECT, "id", graded, "locked_at=not.is.null"),
    readByIds<ArchiveGradeRow>(restStrict, "ufc_model_prediction_grades", "prediction_id,revision,result,graded_at,revision_reason,source,method,graded_by", "prediction_id", graded, "order=revision.asc"),
  ]);
  const [bouts, fighters] = await Promise.all([
    readByIds<BoutRow>(restStrict, "ufc_bouts", BOUT_SELECT, "id", preds.map((p) => p.bout_id)),
    readByIds<{ id: string; name: string }>(restStrict, "ufc_fighters", "id,name", "id", preds.flatMap((p) => [p.fighter_a_id, p.fighter_b_id])),
  ]);
  const boutBy = new Map(bouts.map((b) => [b.id, b]));
  const nameBy = new Map(fighters.map((f) => [f.id, f.name]));
  return preds.flatMap((p) => {
    const revisions = grades.filter((g) => g.prediction_id === p.id).sort((x, y) => x.revision - y.revision).map(({ prediction_id: _x, ...g }) => g);
    const current = revisions[revisions.length - 1];
    if (!current || !p.locked_at) return [];
    /* The prediction's own fighter ids are the authority for who it was about:
     * a bout row can be corrected later, the locked prediction cannot. */
    const a = { id: p.fighter_a_id, name: nameBy.get(p.fighter_a_id) || "Fighter not resolved" };
    const b = { id: p.fighter_b_id, name: nameBy.get(p.fighter_b_id) || "Fighter not resolved" };
    const pick = p.pick_fighter_id === a.id ? a : b;
    const bout = boutBy.get(p.bout_id) || null;
    const market = p.sample_context?.market ?? null;
    const price = lockPrice(market?.pick_best_odds);
    return [{
      prediction_id: p.id, event_id: p.event_id || UNRESOLVED_EVENT, bout_id: p.bout_id,
      fight_slug: bout ? matchupSlug(bout.fighter_a, bout.fighter_b, bout.event) : null, order: bout?.bout_order ?? null,
      fighter_a: a, fighter_b: b, pick, opponent: pick.id === a.id ? b : a,
      locked_at: p.locked_at, pick_probability: Number(p.pick_probability), confidence: p.sample_context?.confidence ?? null, confidence_band: p.confidence_band,
      model_version: p.model_version, feature_version: p.feature_version,
      lock_price: price, lock_book: market?.pick_best_book ?? null, consensus_odds: lockPrice(market?.pick_consensus_odds),
      market_implied_prob: p.market_implied_prob_pick == null ? null : Number(p.market_implied_prob_pick), model_edge_pts: p.model_edge_pts == null ? null : Number(p.model_edge_pts),
      market_status: market?.status ?? null, market_source: market?.source ?? null, market_books: p.market_books ?? market?.books ?? null, market_observed_at: market?.observed_at ?? p.market_snapshot_at ?? null,
      result: current.result, graded_at: current.graded_at, net_units: oneUnitReturn(current.result, price), revisions,
    }];
  });
}
/** Card order (main event first), prediction id as the tie-breaker: never a grade timestamp. */
const byCardOrder = (a: ArchivePick, b: ArchivePick) => (b.order ?? -1) - (a.order ?? -1) || a.prediction_id.localeCompare(b.prediction_id);

export type AlgoArchiveSlices = { overall: CalibrationSummary; byConfidence: Array<{ key: "HIGH" | "MEDIUM" | "LEAN"; s: CalibrationSummary }>; byEdge: Array<{ label: string; s: CalibrationSummary }>; noMarket: CalibrationSummary };
const EDGE_BANDS: Array<[string, (d: number) => boolean]> = [
  ["PBE Edge +10 pts or more", (d) => d >= 10],
  ["PBE Edge +3 to +10 pts", (d) => d >= 3 && d < 10],
  ["PBE Edge within 3 pts", (d) => Math.abs(d) < 3],
  ["PBE Edge −3 pts or lower", (d) => d <= -3],
];
function archiveSlices(index: ArchiveIndex): AlgoArchiveSlices {
  const edge = (p: IndexPred) => (p.model_edge_pts == null ? null : Number(p.model_edge_pts));
  return {
    overall: calibrationSummary(index.preds, index.gradeBy),
    byConfidence: (["HIGH", "MEDIUM", "LEAN"] as const).map((key) => ({ key, s: calibrationSummary(index.preds.filter((p) => p.confidence === key), index.gradeBy) })),
    byEdge: EDGE_BANDS.map(([label, test]) => ({ label, s: calibrationSummary(index.preds.filter((p) => { const d = edge(p); return d != null && test(d); }), index.gradeBy) })),
    noMarket: calibrationSummary(index.preds.filter((p) => edge(p) == null), index.gradeBy),
  };
}

export type AlgoArchiveEvent = EventSummary & { event_slug: string | null; picks: ArchivePick[] };
export type AlgoArchive =
  | { ok: false; error: string; generated_at: string }
  | {
    ok: true; generated_at: string;
    model: string | null; model_versions: string[];
    page: number; pages: number; total_events: number;
    /** The event the request addressed (?event= / ?pick=), if it exists. */
    focus_event_id: string | null; focus_prediction_id: string | null; not_found: "event" | "pick" | null;
    lifetime: PerformanceSlice; integrity: ArchiveIntegrity; overdue: ArchiveIndex["overdue"];
    slices: AlgoArchiveSlices;
    events: AlgoArchiveEvent[];
  };

/**
 * One server-rendered page of the public archive: ten event summaries, newest
 * first, each with its publicly graded picks. `event` and `pick` are permanent
 * addresses: the page that holds them is resolved here, so a link keeps working
 * as newer cards push an event down the list. Aggregates (lifetime, per event,
 * slices) come from the full index and do not depend on the page.
 */
export async function getAlgoArchive(q: { page?: number; event?: string | null; pick?: string | null; model?: string | null } = {}): Promise<AlgoArchive> {
  const generated_at = new Date().toISOString();
  try {
    const all = await archiveIndex(null);
    const model = q.model && all.model_versions.includes(q.model) ? q.model : null;
    const index = model ? await archiveIndex(model) : all;
    let focusEvent: string | null = null, focusPick: string | null = null, notFound: "event" | "pick" | null = null;
    if (q.pick) {
      focusEvent = eventOfPrediction(index, q.pick);
      if (focusEvent) focusPick = q.pick; else notFound = "pick";
    } else if (q.event) {
      if (index.events.some((e) => e.event_id === q.event)) focusEvent = q.event; else notFound = "event";
    }
    const page = paginate(index.events, focusEvent ? pageOfEvent(index.events, focusEvent) || 1 : q.page || 1);
    const picks = await archivePicks(index, page.items.flatMap((e) => e.graded_prediction_ids));
    const events = page.items.map((e) => ({
      ...e,
      event_slug: e.event_date && e.event_id !== UNRESOLVED_EVENT ? eventSlug({ name: e.event_name, event_date: e.event_date }) : null,
      picks: picks.filter((p) => e.graded_prediction_ids.includes(p.prediction_id)).sort(byCardOrder),
    }));
    return {
      ok: true, generated_at, model, model_versions: all.model_versions,
      page: page.page, pages: page.pages, total_events: page.total_events,
      focus_event_id: focusEvent, focus_prediction_id: focusPick, not_found: notFound,
      lifetime: index.lifetime, integrity: index.integrity, overdue: index.overdue, slices: archiveSlices(index), events,
    };
  } catch (e) {
    console.error(`[algo-record] archive read failed: ${String((e as Error)?.message || e)}`);
    return { ok: false, error: e instanceof ArchiveReadError ? "The record store could not be read." : "The archive could not be assembled.", generated_at };
  }
}

/** The latest graded picks, in the order they were first graded: wins and
 *  losses alike. Null when the record cannot be read. */
export async function getAlgoRecentGradedPicks(n = 5): Promise<Array<ArchivePick & { event_name: string; event_date: string | null }> | null> {
  try {
    const index = await archiveIndex(null);
    const ids = recentGradedIds(index, n);
    const picks = await archivePicks(index, ids);
    return ids.flatMap((id) => {
      const p = picks.find((x) => x.prediction_id === id);
      const ev = index.events.find((e) => e.graded_prediction_ids.includes(id)) || null;
      return p ? [{ ...p, event_name: ev?.event_name || "Event not resolved", event_date: ev?.event_date || null }] : [];
    });
  } catch (e) {
    console.error(`[algo-record] recent picks read failed: ${String((e as Error)?.message || e)}`);
    return null;
  }
}

/** Aggregate-only health of the public record, for /api/ufc/record-health. */
export type AlgoRecordHealthIntegrity = Omit<ArchiveIntegrity, "duplicate_prediction_ids" | "duplicate_grade_ids"> & { duplicate_predictions: number; duplicate_grades: number };
export async function getAlgoRecordHealth(): Promise<{ ok: boolean; state: "PASS" | "FAIL"; generated_at: string; read_error: string | null; integrity: AlgoRecordHealthIntegrity | null; overdue: ArchiveIndex["overdue"]; oldest_pending_hours: number | null; events: number }> {
  const generated_at = new Date().toISOString();
  try {
    const index = await archiveIndex(null);
    const i = index.integrity;
    const clean = !i.orphan_grade_predictions && !i.duplicate_prediction_ids.length && !i.duplicate_grade_ids.length;
    const ok = clean && index.overdue.length === 0;
    const { duplicate_prediction_ids, duplicate_grade_ids, ...counts } = i;
    return {
      ok, state: ok ? "PASS" : "FAIL", generated_at, read_error: null,
      integrity: { ...counts, duplicate_predictions: duplicate_prediction_ids.length, duplicate_grades: duplicate_grade_ids.length },
      overdue: index.overdue, oldest_pending_hours: index.overdue.length ? Math.max(...index.overdue.map((o) => o.pending_age_hours)) : null, events: index.events.length,
    };
  } catch (e) {
    /* The class of failure only: an upstream message can carry a query string. */
    return { ok: false, state: "FAIL", generated_at, read_error: e instanceof ArchiveReadError ? "record_store_unreadable" : "record_assembly_failed", integrity: null, overdue: [], oldest_pending_hours: null, events: 0 };
  }
}

/**
 * Public, aggregate live proof for the PBE Picks product.
 *
 * Upcoming fighter identities never leave this function. The only identity
 * returned is the latest already-GRADED historical call. ROI is a flat 1-unit
 * stake at the best available price frozen in the lock-time market snapshot.
 * A W/L call without a real lock-time best price is excluded from ROI rather
 * than reconstructed from model or implied probability. Computed from the
 * full-history index: there is no row cap behind these numbers.
 */
export async function getAlgoPerformanceProof(): Promise<AlgoPerformanceProof> {
  const generated_at = new Date().toISOString();
  const empty = (): AlgoPerformanceSlice => ({ locked: 0, decided: 0, wins: 0, losses: 0, no_decision: 0, pending: 0, hit_rate: null, priced_decided: 0, net_units: null, roi: null, streak: null });
  let index: ArchiveIndex;
  try {
    index = await archiveIndex(null);
  } catch (e) {
    console.error(`[algo-record] tracker read failed: ${String((e as Error)?.message || e)}`);
    return { generated_at, unavailable: true, lifetime: empty(), fight_week: null, last_result: null };
  }

  const today = ufcSiteDate(Date.parse(generated_at));
  const focus = index.events.filter((e) => e.event_date).sort((a, b) => {
    const aFuture = a.event_date! >= today ? 0 : 1;
    const bFuture = b.event_date! >= today ? 0 : 1;
    if (aFuture !== bFuture) return aFuture - bFuture;
    return aFuture === 0 ? a.event_date!.localeCompare(b.event_date!) : b.event_date!.localeCompare(a.event_date!);
  })[0] || null;
  const fightWeek: AlgoPerformanceProof["fight_week"] = focus
    ? {
      locked: focus.locked, decided: focus.decided, wins: focus.wins, losses: focus.losses, no_decision: focus.no_decision, pending: focus.pending,
      hit_rate: focus.hit_rate, priced_decided: focus.priced_decided, net_units: focus.net_units, roi: focus.roi, streak: focus.streak,
      event_id: focus.event_id, event_name: focus.event_name, event_date: focus.event_date!,
    }
    : null;

  let last_result: AlgoPerformanceProof["last_result"] = null;
  const latest = index.preds.filter((p) => index.gradeBy.has(p.id)).sort((a, b) => index.gradeBy.get(b.id)!.graded_at.localeCompare(index.gradeBy.get(a.id)!.graded_at) || b.id.localeCompare(a.id))[0] || null;
  if (latest) {
    try {
      const [pick] = await archivePicks(index, [latest.id]);
      const ev = pick ? index.events.find((e) => e.graded_prediction_ids.includes(pick.prediction_id)) || null : null;
      if (pick) last_result = {
        prediction_id: pick.prediction_id, event_name: ev?.event_name || "Event not resolved", event_date: ev?.event_date || "",
        matchup: `${pick.fighter_a.name} vs ${pick.fighter_b.name}`, pick_name: pick.pick.name, opponent_name: pick.opponent.name,
        result: pick.result, graded_at: pick.graded_at, locked_at: pick.locked_at, best_odds: pick.lock_price, net_units: pick.net_units,
      };
    } catch (e) {
      console.error(`[algo-record] last result read failed: ${String((e as Error)?.message || e)}`);
    }
  }
  return { generated_at, lifetime: index.lifetime, fight_week: fightWeek, last_result };
}

/* ---- UFC Pro ------------------------------------------------------------ */

type EvalRow = { bout_id: string; event_id: string; decision: "ELIGIBLE" | "NO_MODEL_CALL"; reasons: string[]; confidence: AlgoBoutView["confidence"]; pick_fighter_id: string | null; pick_probability: number | null; features_available: number | null; sample: AlgoBoutView["sample"]; market: AlgoBoutView["market"]; model_version: string; feature_version: string; evaluated_at: string };
type PredRow = NonNullable<AlgoBoutView["prediction"]> & { bout_id: string; event_id: string | null; fighter_a_id: string; fighter_b_id: string; model_version: string; feature_version: string; sample_context: { confidence?: AlgoBoutView["confidence"]; min_prior_bouts?: number; min_stat_bouts?: number; features_available?: number; market?: AlgoBoutView["market"] } | null };
type GradeRow = { prediction_id: string; result: NonNullable<AlgoBoutView["grade"]>["result"]; revision: number; graded_at: string; revision_reason: string | null };
type BoutRow = { id: string; event_id: string; card_position: string | null; bout_order: number | null; fighter_a: { id: string; name: string }; fighter_b: { id: string; name: string }; event: { id: string; name: string; event_date: string } };

const PRED_SELECT = "id,bout_id,event_id,fighter_a_id,fighter_b_id,model_version,feature_version,generated_at,locked_at,prob_a,prob_b,pick_fighter_id,pick_probability,confidence_band,feature_vector,feature_availability,sample_context,market_implied_prob_pick,model_edge_pts";

/* `revisions`: every grade revision for these predictions, already read by the
 * caller through the archive's strict reader. The grade in force is then the
 * highest revision, the same rule as the index, and nothing is read here. */
async function assemble(bouts: BoutRow[], evals: EvalRow[], preds: PredRow[], withHistory = false, revisions: GradeRow[] | null = null): Promise<AlgoBoutView[]> {
  const ids = inList(preds.map((p) => p.id));
  const [grades, history] = revisions
    ? [[...revisions.reduce((m, g) => (!m.has(g.prediction_id) || m.get(g.prediction_id)!.revision < g.revision ? m.set(g.prediction_id, g) : m), new Map<string, GradeRow>()).values()], revisions.slice().sort((a, b) => a.revision - b.revision)]
    : preds.length
    ? await Promise.all([
      rest<GradeRow>(`ufc_model_prediction_current_grade?prediction_id=in.${ids}&select=prediction_id,result,revision,graded_at,revision_reason`),
      withHistory ? rest<GradeRow>(`ufc_model_prediction_grades?prediction_id=in.${ids}&select=prediction_id,result,revision,graded_at,revision_reason&order=revision.asc`) : Promise.resolve([] as GradeRow[]),
    ])
    : [[], []];
  const evalBy = new Map(evals.map((e) => [e.bout_id, e]));
  const predBy = new Map(preds.map((p) => [p.bout_id, p]));
  const gradeBy = new Map(grades.map((g) => [g.prediction_id, g]));
  return bouts.map((b) => {
    const e = evalBy.get(b.id);
    const p = predBy.get(b.id) || null;
    const g = p ? gradeBy.get(p.id) || null : null;
    return {
      bout_id: b.id, event_id: b.event.id, event_name: b.event.name, event_date: b.event.event_date,
      event_slug: eventSlug(b.event), fight_slug: matchupSlug(b.fighter_a, b.fighter_b, b.event),
      card_position: b.card_position, order: b.bout_order, fighter_a: b.fighter_a, fighter_b: b.fighter_b,
      decision: p?.locked_at ? "ELIGIBLE" : e?.decision || (p ? "ELIGIBLE" : "NOT_EVALUATED"), reasons: p?.locked_at ? [] : e?.reasons || [], confidence: p?.sample_context?.confidence ?? e?.confidence ?? null,
      pick_fighter_id: p?.pick_fighter_id ?? e?.pick_fighter_id ?? null, pick_probability: p ? Number(p.pick_probability) : e?.pick_probability ?? null,
      features_available: p?.sample_context?.features_available ?? e?.features_available ?? null, sample: p?.sample_context ? { min_prior_bouts: p.sample_context.min_prior_bouts, min_stat_bouts: p.sample_context.min_stat_bouts } : e?.sample ?? null, market: selectBoutMarket(p, e),
      model_version: p?.model_version || e?.model_version || null, feature_version: p?.feature_version || e?.feature_version || null, evaluated_at: e?.evaluated_at ?? null,
      prediction: p ? { id: p.id, generated_at: p.generated_at, locked_at: p.locked_at, prob_a: Number(p.prob_a), prob_b: Number(p.prob_b), pick_fighter_id: p.pick_fighter_id, pick_probability: Number(p.pick_probability), confidence_band: p.confidence_band, feature_vector: p.feature_vector, feature_availability: p.feature_availability, market_implied_prob_pick: p.market_implied_prob_pick, model_edge_pts: p.model_edge_pts } : null,
      grade: g ? { result: g.result, revision: g.revision, graded_at: g.graded_at, revision_reason: g.revision_reason } : null,
      ...(withHistory && p ? { grade_history: history.filter((h) => h.prediction_id === p.id).map(({ prediction_id: _x, ...h }) => h) } : {}),
    };
  });
}

const BOUT_SELECT = "id,event_id,card_position,bout_order,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name),event:ufc_events!inner(id,name,event_date)";

/** Every UFC card in the next 14 days with its complete PBE Algo state. */
export async function getAlgoCards(access: Pick<UfcAccess, "pro">): Promise<Array<{ event_id: string; event_name: string; event_date: string; event_slug: string; bouts: AlgoBoutView[] }>> {
  requirePro(access);
  const fx = fixture();
  let views: AlgoBoutView[];
  if (fx) {
    views = fx.bouts.filter((b) => !b.grade);
  } else {
    const focusEvent = await getCurrentOrNextUfcEvent();
    const today = focusEvent?.event_date || ufcSiteDate();
    const until = new Date(Date.parse(`${today}T12:00:00Z`) + 14 * 86400e3).toISOString().slice(0, 10);
    const bouts = await rest<BoutRow>(`ufc_bouts?select=${BOUT_SELECT}&event.event_date=gte.${today}&event.event_date=lte.${until}&event.name=like.UFC*&order=bout_order.desc`);
    const ids = bouts.map((b) => b.id);
    const [evals, preds] = ids.length
      ? await Promise.all([
        rest<EvalRow>(`ufc_model_card_current?bout_id=in.${inList(ids)}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=bout_id,event_id,decision,reasons,confidence,pick_fighter_id,pick_probability,features_available,sample,market,model_version,feature_version,evaluated_at`),
        rest<PredRow>(`ufc_model_predictions?bout_id=in.${inList(ids)}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=${PRED_SELECT}`),
      ])
      : [[], []];
    views = await assemble(bouts, evals, preds);
  }
  const byEvent = new Map<string, { event_id: string; event_name: string; event_date: string; event_slug: string; bouts: AlgoBoutView[] }>();
  for (const v of views) {
    if (!byEvent.has(v.event_id)) byEvent.set(v.event_id, { event_id: v.event_id, event_name: v.event_name, event_date: v.event_date, event_slug: v.event_slug, bouts: [] });
    byEvent.get(v.event_id)!.bouts.push(v);
  }
  return [...byEvent.values()].sort((a, b) => a.event_date.localeCompare(b.event_date));
}

/** Counts for the next card, for the /algo overview. Pro only, and counts only:
 *  no fighter, side, probability or reason leaves this function, so the public
 *  method page can show that a card is being worked without ever holding a call. */
export type AlgoCardSummary = { event_name: string; event_date: string; bouts: number; locked: number; provisional: number; no_call: number; pending: number };
export async function getAlgoNextCardSummary(access: Pick<UfcAccess, "pro">): Promise<AlgoCardSummary | null> {
  requirePro(access);
  const card = (await getAlgoCards(access))[0];
  if (!card) return null;
  const locked = card.bouts.filter((b) => b.prediction?.locked_at).length;
  const provisional = card.bouts.filter((b) => !b.prediction?.locked_at && b.decision === "ELIGIBLE").length;
  const no_call = card.bouts.filter((b) => !b.prediction?.locked_at && b.decision === "NO_MODEL_CALL").length;
  return { event_name: card.event_name, event_date: card.event_date, bouts: card.bouts.length, locked, provisional, no_call, pending: card.bouts.length - locked - provisional - no_call };
}

export async function getAlgoBout(access: Pick<UfcAccess, "pro">, boutId: string): Promise<AlgoBoutView | null> {
  requirePro(access);
  const fx = fixture();
  if (fx) return fx.bouts.find((b) => b.bout_id === boutId) || null;
  const [bout] = await rest<BoutRow>(`ufc_bouts?select=${BOUT_SELECT}&id=eq.${boutId}`);
  if (!bout) return null;
  const [evals, preds] = await Promise.all([
    rest<EvalRow>(`ufc_model_card_current?bout_id=eq.${boutId}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=bout_id,event_id,decision,reasons,confidence,pick_fighter_id,pick_probability,features_available,sample,market,model_version,feature_version,evaluated_at`),
    rest<PredRow>(`ufc_model_predictions?bout_id=eq.${boutId}&model_version=eq.${encodeURIComponent(MODEL_VERSION)}&select=${PRED_SELECT}`),
  ]);
  if (!evals.length && !preds.length) return null;
  return (await assemble([bout], evals, preds))[0];
}

/** Every officially LOCKED prediction, newest first, with its current grade.
 *  Drafts never appear. The ids come from the canonical full-history index (every
 *  official model version, no row cap) and the rows are read in URL-safe chunks,
 *  so this list and getAlgoRecordTotals() cover exactly the population the public
 *  archive aggregates. Throws on a failed read rather than returning a short list. */
export async function getAlgoRecord(access: Pick<UfcAccess, "pro">): Promise<AlgoBoutView[]> {
  requirePro(access);
  const fx = fixture();
  if (fx) return fx.bouts.filter((b) => b.prediction?.locked_at).sort((a, b) => b.prediction!.locked_at!.localeCompare(a.prediction!.locked_at!));
  const index = await archiveIndex(null);
  const ids = index.preds.map((p) => p.id);
  const views: AlgoBoutView[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const preds = await readByIds<PredRow>(restStrict, "ufc_model_predictions", PRED_SELECT, "id", ids.slice(i, i + 100), "locked_at=not.is.null");
    const boutIds = preds.map((p) => p.bout_id);
    const [bouts, evals, revisions] = await Promise.all([
      readByIds<BoutRow>(restStrict, "ufc_bouts", BOUT_SELECT, "id", boutIds),
      readByIds<EvalRow>(restStrict, "ufc_model_card_current", "bout_id,event_id,decision,reasons,confidence,pick_fighter_id,pick_probability,features_available,sample,market,model_version,feature_version,evaluated_at", "bout_id", boutIds),
      readByIds<GradeRow>(restStrict, "ufc_model_prediction_grades", "prediction_id,result,revision,graded_at,revision_reason", "prediction_id", preds.map((p) => p.id)),
    ]);
    /* One view per PREDICTION: two official versions may have locked the same bout. */
    for (const p of preds) {
      const bout = bouts.find((b) => b.id === p.bout_id);
      if (bout) views.push(...await assemble([bout], evals.filter((e) => e.bout_id === p.bout_id && e.model_version === p.model_version), [p], true, revisions.filter((g) => g.prediction_id === p.id)));
    }
  }
  return views.sort((a, b) => (b.prediction?.locked_at || "").localeCompare(a.prediction?.locked_at || "") || (b.prediction?.id || "").localeCompare(a.prediction?.id || ""));
}

/** The Pro record's totals: the canonical lifetime slice itself, not a recount. */
export async function getAlgoRecordTotals(access: Pick<UfcAccess, "pro">): Promise<{ lifetime: PerformanceSlice; integrity: ArchiveIntegrity; model_versions: string[] }> {
  requirePro(access);
  const index = await archiveIndex(null);
  return { lifetime: index.lifetime, integrity: index.integrity, model_versions: index.model_versions };
}
