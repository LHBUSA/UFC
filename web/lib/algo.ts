import "server-only";
import fs from "node:fs";
import type { UfcAccess } from "@/lib/accessDecision";
import { eventSlug, matchupSlug } from "@/lib/slug";
import { selectBoutMarket, type AlgoBoutView, type AlgoPublicRecord } from "@/lib/algoView";
import artifact from "@/lib/generated/model-v1.json";

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
  threshold_odds: number;
  showcase_threshold_odds: number;
  total: number;
  decided: number;
  wins: number;
  losses: number;
  no_decision: number;
  hit_rate: number | null;
  average_consensus_odds: number | null;
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

type UpsetPredRow = {
  id: string;
  bout_id: string;
  locked_at: string;
  pick_fighter_id: string;
  pick_probability: number | string;
  market_implied_prob_pick: number | string | null;
  model_edge_pts: number | string | null;
  sample_context: { market?: AlgoBoutView["market"] } | null;
};
type UpsetGradeRow = {
  prediction_id: string;
  result: NonNullable<AlgoBoutView["grade"]>["result"];
};
type UpsetBoutRow = {
  id: string;
  fighter_a: { id: string; name: string };
  fighter_b: { id: string; name: string };
  event: { name: string; event_date: string };
};

const UPSET_THRESHOLD_ODDS = 100;
const UPSET_SHOWCASE_THRESHOLD_ODDS = 120;
const EMPTY_UPSET_PROOF = (): AlgoUpsetProof => ({
  threshold_odds: UPSET_THRESHOLD_ODDS,
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
 * An underdog is mechanical, not editorial: lock-time consensus > +100.
 * Showcase cards are wins at +120 or longer, while the aggregate includes
 * every graded underdog call so losses cannot disappear from the record.
 */
export async function getAlgoUpsetProof(): Promise<AlgoUpsetProof> {
  const fx = fixture();
  if (fx) {
    const rows = fx.bouts
      .filter((b) => b.prediction?.locked_at && b.grade)
      .map((b) => {
        const odds = Number(b.market?.pick_consensus_odds);
        if (!Number.isFinite(odds) || odds <= UPSET_THRESHOLD_ODDS) return null;
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
      threshold_odds: UPSET_THRESHOLD_ODDS, showcase_threshold_odds: UPSET_SHOWCASE_THRESHOLD_ODDS,
      total: rows.length, decided, wins, losses, no_decision: rows.length - decided,
      hit_rate: decided ? wins / decided : null,
      average_consensus_odds: rows.length ? rows.reduce((n, r) => n + r.consensus_odds, 0) / rows.length : null,
      biggest_wins: rows.filter((r) => r.result === "WIN" && r.consensus_odds >= UPSET_SHOWCASE_THRESHOLD_ODDS)
        .sort((a, b) => b.consensus_odds - a.consensus_odds).slice(0, 3),
    } as AlgoUpsetProof;
  }

  const preds = await rest<UpsetPredRow>(
    `ufc_model_predictions?model_version=eq.${encodeURIComponent(MODEL_VERSION)}&locked_at=not.is.null&select=id,bout_id,locked_at,pick_fighter_id,pick_probability,market_implied_prob_pick,model_edge_pts,sample_context&order=locked_at.desc&limit=1000`
  );
  if (!preds.length) return EMPTY_UPSET_PROOF();

  const predictionIds = inList(preds.map((p) => p.id));
  const boutIds = inList(preds.map((p) => p.bout_id));
  const [grades, bouts] = await Promise.all([
    rest<UpsetGradeRow>(`ufc_model_prediction_current_grade?prediction_id=in.${predictionIds}&select=prediction_id,result`),
    rest<UpsetBoutRow>(`ufc_bouts?id=in.${boutIds}&select=id,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name),event:ufc_events!inner(name,event_date)`),
  ]);
  const gradeBy = new Map(grades.map((g) => [g.prediction_id, g]));
  const boutBy = new Map(bouts.map((b) => [b.id, b]));

  const rows = preds.flatMap((p) => {
    const grade = gradeBy.get(p.id);
    const bout = boutBy.get(p.bout_id);
    const odds = Number(p.sample_context?.market?.pick_consensus_odds);
    if (!grade || !bout || !Number.isFinite(odds) || odds <= UPSET_THRESHOLD_ODDS) return [];
    const pick = p.pick_fighter_id === bout.fighter_a.id ? bout.fighter_a : p.pick_fighter_id === bout.fighter_b.id ? bout.fighter_b : null;
    if (!pick) return [];
    const opponent = pick.id === bout.fighter_a.id ? bout.fighter_b : bout.fighter_a;
    return [{
      prediction_id: p.id,
      event_name: bout.event.name,
      event_date: bout.event.event_date,
      pick_name: pick.name,
      opponent_name: opponent.name,
      consensus_odds: odds,
      best_odds: p.sample_context?.market?.pick_best_odds == null ? null : Number(p.sample_context.market.pick_best_odds),
      pick_probability: Number(p.pick_probability),
      market_implied_prob: p.market_implied_prob_pick == null ? null : Number(p.market_implied_prob_pick),
      model_edge_pts: p.model_edge_pts == null ? null : Number(p.model_edge_pts),
      result: grade.result,
      locked_at: p.locked_at,
    }];
  });

  const wins = rows.filter((r) => r.result === "WIN").length;
  const losses = rows.filter((r) => r.result === "LOSS").length;
  const decided = wins + losses;
  return {
    threshold_odds: UPSET_THRESHOLD_ODDS,
    showcase_threshold_odds: UPSET_SHOWCASE_THRESHOLD_ODDS,
    total: rows.length,
    decided,
    wins,
    losses,
    no_decision: rows.length - decided,
    hit_rate: decided ? wins / decided : null,
    average_consensus_odds: rows.length ? rows.reduce((n, r) => n + r.consensus_odds, 0) / rows.length : null,
    biggest_wins: rows
      .filter((r): r is typeof r & { result: "WIN" } => r.result === "WIN" && r.consensus_odds >= UPSET_SHOWCASE_THRESHOLD_ODDS)
      .sort((a, b) => b.consensus_odds - a.consensus_odds)
      .slice(0, 3),
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

/* ---- UFC Pro ------------------------------------------------------------ */

type EvalRow = { bout_id: string; event_id: string; decision: "ELIGIBLE" | "NO_MODEL_CALL"; reasons: string[]; confidence: AlgoBoutView["confidence"]; pick_fighter_id: string | null; pick_probability: number | null; features_available: number | null; sample: AlgoBoutView["sample"]; market: AlgoBoutView["market"]; model_version: string; feature_version: string; evaluated_at: string };
type PredRow = NonNullable<AlgoBoutView["prediction"]> & { bout_id: string; event_id: string | null; fighter_a_id: string; fighter_b_id: string; model_version: string; feature_version: string; sample_context: { confidence?: AlgoBoutView["confidence"]; min_prior_bouts?: number; min_stat_bouts?: number; features_available?: number; market?: AlgoBoutView["market"] } | null };
type GradeRow = { prediction_id: string; result: NonNullable<AlgoBoutView["grade"]>["result"]; revision: number; graded_at: string; revision_reason: string | null };
type BoutRow = { id: string; event_id: string; card_position: string | null; bout_order: number | null; fighter_a: { id: string; name: string }; fighter_b: { id: string; name: string }; event: { id: string; name: string; event_date: string } };

const PRED_SELECT = "id,bout_id,event_id,fighter_a_id,fighter_b_id,model_version,feature_version,generated_at,locked_at,prob_a,prob_b,pick_fighter_id,pick_probability,confidence_band,feature_vector,feature_availability,sample_context,market_implied_prob_pick,model_edge_pts";

async function assemble(bouts: BoutRow[], evals: EvalRow[], preds: PredRow[], withHistory = false): Promise<AlgoBoutView[]> {
  const ids = inList(preds.map((p) => p.id));
  const [grades, history] = preds.length
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
    const today = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
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

/** Every officially LOCKED prediction, newest first, with its current grade. Drafts never appear. */
export async function getAlgoRecord(access: Pick<UfcAccess, "pro">): Promise<AlgoBoutView[]> {
  requirePro(access);
  const fx = fixture();
  if (fx) return fx.bouts.filter((b) => b.prediction?.locked_at).sort((a, b) => b.prediction!.locked_at!.localeCompare(a.prediction!.locked_at!));
  const preds = await rest<PredRow>(`ufc_model_predictions?locked_at=not.is.null&select=${PRED_SELECT}&order=locked_at.desc&limit=1000`);
  if (!preds.length) return [];
  const bouts = await rest<BoutRow>(`ufc_bouts?select=${BOUT_SELECT}&id=in.${inList(preds.map((p) => p.bout_id))}`);
  const evals = await rest<EvalRow>(`ufc_model_card_current?bout_id=in.${inList(preds.map((p) => p.bout_id))}&select=bout_id,event_id,decision,reasons,confidence,pick_fighter_id,pick_probability,features_available,sample,market,model_version,feature_version,evaluated_at`);
  const views = await assemble(bouts, evals, preds, true);
  return views.sort((a, b) => (b.prediction?.locked_at || "").localeCompare(a.prediction?.locked_at || ""));
}
