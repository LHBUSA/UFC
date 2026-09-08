import "server-only";

/* PBE Fight Model read layer.
 *
 * Two sources, kept apart on purpose.
 *
 * The RELEASE ARTIFACT (lib/generated/model-v1.json) is committed evidence:
 * coefficients, the walk-forward result, the leakage audit, worked examples.
 * It is a file, so it renders with no database and cannot drift between what
 * the site claims and what the repository can prove.
 *
 * The LIVE RECORD comes from ufc_model_live_record and its companions. Until
 * the first pick is locked and graded, those views return nothing, and nothing
 * is exactly what the page shows: not 0-0, not a dash pretending to be a
 * number, and never the backtest standing in for a record that does not exist.
 *
 * The two are never summed, averaged, or rendered in the same table. A
 * backtest says what the model would have done. A live record says what it
 * did, with the future genuinely unknown at the time. Presenting them as one
 * number would turn an honest research result into a false track record, and
 * that is the single most valuable thing this product has to not do.
 */

import artifact from "@/lib/generated/model-v1.json";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export type ConfidenceBand = "50-55" | "55-60" | "60-65" | "65-70" | "70-80" | "80-100";

export type ModelSide = { id?: string; name: string; prob: number };

export type ModelExample = {
  note?: string;
  bout_id: string;
  event_date: string;
  event_name: string | null;
  weight_class: string | null;
  is_womens: boolean;
  fighter_a: ModelSide;
  fighter_b: ModelSide;
  pick_name: string;
  pick_probability: number;
  confidence_band: string;
  market: { implied_pick: number; books: number | null } | null;
  outcome: "WIN" | "LOSS";
  winner_name: string;
  result_method: string | null;
  sample_context: {
    min_prior_bouts: number;
    min_stat_bouts: number;
    features_available: number;
    features_total: number;
  };
  fold_year: number;
};

/* The JSON import gives structural types inferred from the current file - the
 * `outcome` field comes back as `string` rather than the two values it can
 * actually hold. Overriding `examples` rather than intersecting keeps the
 * narrow type instead of colliding with the inferred one. */
export type ModelArtifact = Omit<typeof artifact, "examples"> & { examples: ModelExample[] };

export const MODEL = artifact as unknown as ModelArtifact;

/** Status of the live publishing programme. Deliberately explicit: "we have
 *  not started" is a different sentence from "we have started and are 0-0",
 *  and the page must be able to say the right one. */
export type LiveStatus = "not_publishing" | "publishing_ungraded" | "publishing";

export type LiveRecord = {
  model_version: string;
  feature_version: string;
  record_class: "LIVE";
  locked_predictions: number;
  pending: number;
  wins: number;
  losses: number;
  no_decision: number;
  decided: number;
  hit_rate: number | null;
  high_conf_wins: number;
  high_conf_losses: number;
  brier: number | null;
  mean_confidence: number | null;
  market_compared: number;
  mean_edge_pts: number | null;
  /* Predictions whose result has been corrected since it was first graded.
     Surfaced rather than hidden: a record that silently restates results is
     worth less than one that says how many it has revised. */
  revised_grades: number;
  first_locked_at: string | null;
  last_locked_at: string | null;
};

export type LiveRecent = {
  model_version: string;
  decided: number;
  wins: number;
  losses: number;
  hit_rate: number | null;
  brier: number | null;
};

export type LiveCalibrationRow = {
  model_version: string;
  confidence_band: string;
  decided: number;
  wins: number;
  observed: number | null;
  predicted: number | null;
};

export type LiveState = {
  status: LiveStatus;
  record: LiveRecord | null;
  recent: LiveRecent | null;
  calibration: LiveCalibrationRow[];
  /** Why the record is empty, in the reader's language, when it is. */
  reason: string;
};

/* One sentence, used for every reason the record is empty. A reader does not
   need to know which of them applies, and the honest summary is the same in
   all of them: nothing has been published, so there is nothing to show. */
export const PRE_LAUNCH_REASON =
  "No pick has been locked yet. The live record opens on the day the first prediction is published before a fight, and not a day earlier.";

export function modelDbConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

/* Reads are wrapped so that a missing table renders the empty state rather
 * than a 500. Migration 011 may not be applied in every environment, and the
 * page must render either way - see getLiveState for why that difference is
 * logged rather than shown. */
async function read<T>(path: string): Promise<{ rows: T[]; missing: boolean }> {
  if (!modelDbConfigured()) return { rows: [], missing: true };
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: { apikey: KEY, Accept: "application/json", Authorization: `Bearer ${KEY}` },
      // The live record changes only when a card is graded. Sixty seconds is
      // short enough that a freshly graded pick appears promptly and long
      // enough that the tracker is not a load generator.
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      // 404 from PostgREST means the view does not exist in this project yet.
      if (res.status !== 404) console.error(`[model] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return { rows: [], missing: res.status === 404 };
    }
    const text = await res.text();
    return { rows: text ? (JSON.parse(text) as T[]) : [], missing: false };
  } catch (e) {
    console.error(`[model] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return { rows: [], missing: true };
  }
}

export async function getLiveState(modelVersion = MODEL.model.model_version): Promise<LiveState> {
  const q = `model_version=eq.${encodeURIComponent(modelVersion)}`;
  const [rec, recent, cal] = await Promise.all([
    read<LiveRecord>(`ufc_model_live_record?${q}&select=*`),
    read<LiveRecent>(`ufc_model_live_recent?${q}&select=*`),
    read<LiveCalibrationRow>(`ufc_model_live_calibration?${q}&select=*&order=confidence_band.asc`),
  ]);

  if (rec.missing) {
    /* The tracker tables are not present in this environment. That is an
       operational fact about a deployment, not something a reader of a fight
       site should be shown: to them it is indistinguishable from "the model
       has not started publishing", which is also true and is the sentence
       that actually means something. The detail goes to the server log. */
    console.warn("[model] live record views unavailable; rendering the pre-launch empty state");
    return {
      status: "not_publishing",
      record: null,
      recent: null,
      calibration: [],
      reason: PRE_LAUNCH_REASON,
    };
  }

  const record = rec.rows[0] ?? null;
  if (!record || record.locked_predictions === 0) {
    return {
      status: "not_publishing",
      record,
      recent: null,
      calibration: [],
      reason: PRE_LAUNCH_REASON,
    };
  }
  if (record.decided === 0) {
    return {
      status: "publishing_ungraded",
      record,
      recent: null,
      calibration: [],
      reason: `${record.locked_predictions} pick${record.locked_predictions === 1 ? "" : "s"} locked and awaiting a result. No hit rate is shown until a fight has actually been graded.`,
    };
  }
  return {
    status: "publishing",
    record,
    recent: recent.rows[0] ?? null,
    calibration: cal.rows,
    reason: "",
  };
}

/* ---- formatting ------------------------------------------------------- */

export const pct = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(dp)}%`;

export const pts = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)} pts`;

export const num3 = (v: number | null | undefined, dp = 4) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

export function bandOf(p: number): ConfidenceBand {
  const c = Math.max(p, 1 - p);
  return c < 0.55 ? "50-55" : c < 0.6 ? "55-60" : c < 0.65 ? "60-65" : c < 0.7 ? "65-70" : c < 0.8 ? "70-80" : "80-100";
}

/** Out-of-sample hit rate the model actually recorded in the band a given
 *  probability falls into. This is the honest answer to "how much should I
 *  trust this number", and it comes from the walk-forward, never from the
 *  live record, which has no rows. */
export function bandEvidence(p: number) {
  const band = bandOf(p);
  const row = MODEL.evidence.by_confidence_band.find((b) => b.band === band);
  return row ? { band, n: row.n, hit_rate: row.hit_rate, mean_confidence: row.mean_confidence } : { band, n: 0, hit_rate: null, mean_confidence: null };
}

/* The card's arithmetic, extracted from the component so it can be tested and
   so there is exactly one place where model and market are subtracted. Both
   figures on screen and the number between them cannot disagree if only one
   function computes it. */
export function pickSide<T extends { prob: number }>(a: T, b: T): { pick: T; aFavoured: boolean } {
  const aFavoured = a.prob >= b.prob;
  return { pick: aFavoured ? a : b, aFavoured };
}

/** De-vigged market probability on the side the MODEL picked, given the market
 *  probability for corner A. Null in, null out: never estimated. */
export function marketProbForPick(marketImpliedA: number | null | undefined, aFavoured: boolean): number | null {
  if (marketImpliedA == null || !Number.isFinite(marketImpliedA)) return null;
  return aFavoured ? marketImpliedA : 1 - marketImpliedA;
}

/** Model minus market on the picked side, in percentage points. */
export function modelEdgePts(pickProb: number, marketPickProb: number | null): number | null {
  if (marketPickProb == null || !Number.isFinite(marketPickProb)) return null;
  return (pickProb - marketPickProb) * 100;
}

export const WEIGHT_SHORT: Record<string, string> = {
  STRAWWEIGHT: "Strawweight", FLYWEIGHT: "Flyweight", BANTAMWEIGHT: "Bantamweight",
  FEATHERWEIGHT: "Featherweight", LIGHTWEIGHT: "Lightweight", WELTERWEIGHT: "Welterweight",
  MIDDLEWEIGHT: "Middleweight", LIGHT_HEAVYWEIGHT: "Light Heavyweight", HEAVYWEIGHT: "Heavyweight",
  SUPER_HEAVYWEIGHT: "Super Heavyweight", CATCHWEIGHT: "Catchweight", OPEN: "Open",
};

export const divisionLabel = (wc: string | null, womens?: boolean) =>
  !wc ? "Division unrecorded" : `${womens ? "Women's " : ""}${WEIGHT_SHORT[wc] ?? wc}`;
