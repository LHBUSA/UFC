import "server-only";
import fs from "node:fs";
import type { UfcAccess } from "@/lib/accessDecision";
import { eventSlug, matchupSlug } from "@/lib/slug";
import type { AlgoBoutView, AlgoPublicRecord } from "@/lib/algoView";
import artifact from "@/lib/generated/model-v1.json";

/* PBE Algo data access. Server only.
 *
 * PUBLIC functions return aggregate proof and nothing actionable.
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

/* ---- UFC Pro ------------------------------------------------------------ */

type EvalRow = { bout_id: string; event_id: string; decision: "ELIGIBLE" | "NO_MODEL_CALL"; reasons: string[]; confidence: AlgoBoutView["confidence"]; pick_fighter_id: string | null; pick_probability: number | null; features_available: number | null; sample: AlgoBoutView["sample"]; market: AlgoBoutView["market"]; model_version: string; feature_version: string; evaluated_at: string };
type PredRow = NonNullable<AlgoBoutView["prediction"]> & { bout_id: string; event_id: string | null; fighter_a_id: string; fighter_b_id: string; model_version: string; feature_version: string; sample_context: { confidence?: AlgoBoutView["confidence"]; min_prior_bouts?: number; min_stat_bouts?: number; features_available?: number } | null };
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
      features_available: p?.sample_context?.features_available ?? e?.features_available ?? null, sample: p?.sample_context ? { min_prior_bouts: p.sample_context.min_prior_bouts, min_stat_bouts: p.sample_context.min_stat_bouts } : e?.sample ?? null, market: p?.locked_at ? null : e?.market ?? null,
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
