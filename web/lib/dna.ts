/* Fight DNA readers — API-first (docs/FIGHT_DNA_CONTRACT.md). The web never
 * recomputes a metric; it renders the stored snapshot the API serves, with
 * every sample / confidence / definition field intact. Fail-null: an
 * unreachable API hides the section, an explicit `dna_not_available` renders
 * the coverage empty state. */
import "server-only";
import { SITE } from "@/lib/site";

export type Confidence = "insufficient" | "low" | "medium" | "high";
export type MetricObject = {
  metric_key?: string; value: number | null; unit: string; numerator?: number | null; denominator?: number | null;
  sample_bouts?: number; sample_rounds?: number; sample_seconds?: number; confidence: Confidence; coverage_status?: Confidence;
  definition_version?: number; origin?: string; source_families?: string[]; as_of_date?: string;
  buckets?: Record<string, number>; total?: number;
};
export type RecordObj = { w: number; l: number; d: number; nc: number; appearances?: number };
export type StanceSplit = {
  record?: RecordObj; ko_tko_wins?: number; submission_wins?: number; decision_wins?: number;
  finish_rate?: MetricObject; ko_rate?: MetricObject; sub_rate?: MetricObject; sig_diff_per_min?: MetricObject; kd_per_15?: MetricObject; td_landed_per_15?: MetricObject;
  stat_bouts?: number; stat_rounds?: number; observed_seconds?: number; confidence?: Confidence; appearances?: number;
};
export type RoundEntry = { sig_att_per_min?: MetricObject; sig_landed_per_min?: MetricObject; absorbed_per_min?: MetricObject; rounds?: number; seconds?: number };
export type DnaSnapshot = {
  as_of_date: string; definition_version: number; sample_bouts: number; sample_completed_bouts: number; sample_stat_bouts: number; sample_rounds: number; sample_seconds: number;
  coverage_status: Confidence; metrics: Record<string, MetricObject>; stance_splits: Record<string, StanceSplit>;
  round_profile: { rounds?: Record<string, RoundEntry>; pace_retention_r2_vs_r1?: MetricObject; pace_retention_r3_vs_r1?: MetricObject; championship_round_delta?: MetricObject; defensive_drift_r3_vs_r1?: MetricObject };
  finish_profile: { finish_rate?: MetricObject; ko_finish_rate?: MetricObject; submission_finish_rate?: MetricObject; finish_round_distribution?: MetricObject; finish_time_median_sec?: MetricObject; finished_by?: { ko_tko?: number; submission?: number }; finished_by_round_distribution?: MetricObject };
  context_splits: Record<string, StanceSplit>; position_profile: Record<string, unknown>; provenance?: Record<string, unknown>;
};
export type FighterDna = { fighter: { id: string; name: string; slug_id?: string | null }; snapshot: DnaSnapshot; meta?: { resolved_as_of?: string; requested_as_of?: string | null; note?: string } };
export type Comparison = { key: string; label: string; a: MetricObject | null; b: MetricObject | null; delta: number | null; direction: string | null };
export type Insight = { key: string; label: string; value: number | null; sample_bouts?: number; sample_rounds?: number; confidence: Confidence; direction: "contextual" | "a" | "b"; explanation: string };
export type MatchupDna = {
  fighters: Array<{ id: string; name: string; stance?: string | null }>;
  a: Partial<DnaSnapshot> | null; b: Partial<DnaSnapshot> | null;
  comparisons: Comparison[]; insights: Insight[]; warnings: string[];
  stance_context?: { a_vs_b_stance?: StanceSplit | null; b_vs_a_stance?: StanceSplit | null; a_stance?: string | null; b_stance?: string | null };
  bettors_edge_evidence?: Array<{ key: string; label: string; value: number | null; unit?: string; sample_bouts?: number; sample_rounds?: number; confidence: Confidence; text?: string }>;
};
export type DnaResult<T> = { status: "ok"; data: T } | { status: "unavailable"; reason: string } | { status: "unreachable" };

async function api<T>(path: string, revalidate = 300): Promise<DnaResult<T>> {
  try {
    const res = await fetch(`${SITE.api}${path}`, { next: { revalidate }, headers: { accept: "application/json" } });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { code?: string; message?: string } | string } | null;
    if (res.ok && j?.ok && j.data) return { status: "ok", data: j.data };
    const code = typeof j?.error === "string" ? j.error : j?.error?.code || `HTTP ${res.status}`;
    if (res.status === 404 && /not_found|no such route|unknown/i.test(String(code)) && !/dna|fighter/i.test(String(code))) return { status: "unreachable" };
    return { status: "unavailable", reason: String(code) };
  } catch (e) {
    console.error(`[dna] ${path} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return { status: "unreachable" };
  }
}

export function getFighterDna(id: string, asOf?: string | null) {
  return api<FighterDna>(`/v1/ufc/fighters/${encodeURIComponent(id)}/dna${asOf ? `?as_of=${asOf}` : ""}`);
}
export function getMatchupDna(a: string, b: string, asOf?: string | null) {
  return api<MatchupDna>(`/v1/ufc/matchups/${encodeURIComponent(a)}/${encodeURIComponent(b)}/dna${asOf ? `?as_of=${asOf}` : ""}`);
}

/* ---- formatting shared by the DNA components ---- */
export function fmtMetric(m: MetricObject | null | undefined): string {
  if (!m || m.value == null) return "—";
  const v = m.value;
  switch (m.unit) {
    case "ratio": return `${Math.round(v * 100)}%`;
    case "per_min": return `${v.toFixed(2)}/min`;
    case "per_15": return `${v.toFixed(2)}/15`;
    case "seconds": return `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`;
    case "seconds_per_td": return `${Math.round(v)}s/TD`;
    case "count": return String(v);
    default: return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}
export function fmtRecord(r?: RecordObj | null): string {
  return r ? `${r.w}-${r.l}-${r.d}${r.nc ? ` (${r.nc} NC)` : ""}` : "—";
}
export function sampleLine(m?: { sample_bouts?: number; sample_rounds?: number; sample_seconds?: number } | null): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.sample_bouts != null) parts.push(`${m.sample_bouts} bout${m.sample_bouts === 1 ? "" : "s"}`);
  if (m.sample_rounds) parts.push(`${m.sample_rounds} rd`);
  if (m.sample_seconds) parts.push(`${Math.round(m.sample_seconds / 60)} min`);
  return parts.join(" · ");
}
export const STANCE_LABEL: Record<string, string> = { ORTHODOX: "Orthodox", SOUTHPAW: "Southpaw", SWITCH: "Switch", OPEN_STANCE: "Open stance", SIDEWAYS: "Sideways", UNKNOWN: "Unlisted", open: "Open-stance matchups", same: "Same-stance matchups" };
