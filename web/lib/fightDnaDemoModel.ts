/* Homepage Fight DNA public demo — pure selection + view model.
 *
 * Owner decision 2026-10-05: the homepage Fight DNA module is ONE public sample
 * of the product, not access to it. It renders a single stored snapshot for a
 * deterministically chosen fighter; full profiles stay UFC Pro.
 *
 * Nothing here computes a metric. Every value is a field of the stored snapshot
 * the ufc-api served (docs/FIGHT_DNA_V1.md); the only arithmetic is presentation
 * (shares of a stored record, a sum of stored finish buckets). A field that is
 * null or missing is omitted, never shown as zero or as a placeholder. */
import type { DnaSnapshot, MetricObject, RecordObj } from "./dna";

export type DemoCandidate = { id: string; context: string };
export type DemoPortrait = { src: string; firstParty: boolean; sourceHeight: number | null };

/* A portrait must be a stored, rights-cleared first-party asset whose original
 * is tall enough for a full-height panel. Low-resolution sources (webcam stills,
 * small crops) are upscaled by the card derivative and look broken at hero size. */
export const MIN_PORTRAIT_SOURCE_HEIGHT = 800;
/* The demo is a sample of a well-covered profile, not of a thin one. */
export const MIN_COMPLETED_BOUTS = 8;
export const MIN_STAT_ROUNDS = 20;
export const MIN_ROUND_PROFILE = 3;
/* Upper bound on DNA reads per homepage render. */
export const MAX_DNA_READS = 3;

const CORE_METRICS = ["sig_landed_per_min", "sig_accuracy", "sig_defense", "sig_diff_per_min", "td_attempts_per_15", "td_accuracy"] as const;

const has = (m?: MetricObject | null): m is MetricObject => Boolean(m && typeof m.value === "number" && Number.isFinite(m.value));

export function portraitQualifies(p: DemoPortrait | null | undefined): boolean {
  return Boolean(p && p.src && p.firstParty && (p.sourceHeight ?? 0) >= MIN_PORTRAIT_SOURCE_HEIGHT);
}

export function snapshotQualifies(s: DnaSnapshot | null | undefined): boolean {
  if (!s || s.coverage_status !== "high") return false;
  if ((s.sample_completed_bouts ?? 0) < MIN_COMPLETED_BOUTS || (s.sample_rounds ?? 0) < MIN_STAT_ROUNDS) return false;
  if (!CORE_METRICS.every((k) => has(s.metrics?.[k]))) return false;
  if (roundSeries(s).length < MIN_ROUND_PROFILE) return false;
  return has(s.finish_profile?.finish_rate);
}

/* Candidates in the caller's order (main event, then champions in rankings
 * order), de-duplicated, keeping only those with a qualifying portrait. The
 * order is the whole selection rule: same data in, same fighter out. */
export function orderCandidates(cands: DemoCandidate[], portraits: Map<string, DemoPortrait>): DemoCandidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (!c.id || seen.has(c.id)) return false;
    seen.add(c.id);
    return portraitQualifies(portraits.get(c.id));
  });
}

export type Tile = { key: string; label: string; metric: MetricObject; signed?: boolean };
export type RoundPoint = { round: string; landed: number; absorbed: number | null; rounds: number | null; confidence: string };
export type ShareBar = { key: string; label: string; value: number };
export type StanceRow = { stance: string; record: RecordObj; tdLanded: MetricObject | null; statBouts: number; confidence: string };

export type DemoView = {
  asOf: string; version: number; coverage: string;
  completedBouts: number; statRounds: number; observedSeconds: number;
  striking: Tile[]; target: ShareBar[];
  grappling: Tile[]; stanceTd: StanceRow[];
  rounds: RoundPoint[]; roundDeltas: Tile[];
  finish: { rate: MetricObject; wins: number; ko: number | null; sub: number | null; decision: number | null; medianSeconds: MetricObject | null; byRound: Array<[string, number]> } | null;
  stances: StanceRow[];
};

function tiles(src: Record<string, MetricObject | undefined> | undefined, spec: Array<[string, string, boolean?]>): Tile[] {
  return spec.flatMap(([key, label, signed]) => (has(src?.[key]) ? [{ key, label, metric: src![key]!, signed }] : []));
}

export function roundSeries(s: DnaSnapshot): RoundPoint[] {
  const rounds = s.round_profile?.rounds || {};
  return ["1", "2", "3", "4", "5"].flatMap((r) => {
    const e = rounds[r];
    if (!e || !has(e.sig_landed_per_min)) return [];
    return [{ round: r, landed: e.sig_landed_per_min.value as number, absorbed: has(e.absorbed_per_min) ? e.absorbed_per_min.value as number : null, rounds: typeof e.rounds === "number" ? e.rounds : (e.sig_landed_per_min.sample_rounds ?? null), confidence: e.sig_landed_per_min.confidence }];
  });
}

const STANCES = ["ORTHODOX", "SOUTHPAW", "SWITCH"];

function stanceRows(s: DnaSnapshot): StanceRow[] {
  return STANCES.flatMap((k) => {
    const sp = s.stance_splits?.[k];
    const apps = Number(sp?.record?.appearances ?? sp?.appearances ?? 0);
    if (!sp?.record || apps <= 0) return [];
    return [{ stance: k, record: sp.record, tdLanded: has(sp.td_landed_per_15) ? sp.td_landed_per_15 : null, statBouts: Number(sp.stat_bouts ?? 0), confidence: String(sp.confidence ?? "insufficient") }];
  });
}

function buckets(m?: MetricObject | null): Array<[string, number]> {
  if (!m) return [];
  const raw = (m as unknown as { value?: unknown }).value;
  const nested = raw && typeof raw === "object" ? (raw as { buckets?: Record<string, number> }).buckets : undefined;
  const b = m.buckets || nested || {};
  return Object.entries(b).filter(([, v]) => Number.isFinite(v)).sort(([a], [z]) => Number(a) - Number(z));
}

export function buildDemoView(s: DnaSnapshot): DemoView {
  const m = s.metrics || {};
  const rp = s.round_profile || {};
  const fp = s.finish_profile || {};

  const target = ([["head_attack_share", "Head"], ["body_attack_share", "Body"], ["leg_attack_share", "Legs"]] as const)
    .flatMap(([key, label]) => (has(m[key]) ? [{ key, label, value: m[key].value as number }] : []));

  let finish: DemoView["finish"] = null;
  const fr = fp.finish_rate;
  if (has(fr) && typeof fr.denominator === "number" && fr.denominator > 0 && typeof fr.numerator === "number") {
    const wins = fr.denominator;
    const ko = has(fp.ko_finish_rate) && typeof fp.ko_finish_rate.numerator === "number" ? fp.ko_finish_rate.numerator : null;
    const sub = has(fp.submission_finish_rate) && typeof fp.submission_finish_rate.numerator === "number" ? fp.submission_finish_rate.numerator : null;
    finish = { rate: fr, wins, ko, sub, decision: wins - fr.numerator, medianSeconds: has(fp.finish_time_median_sec) ? fp.finish_time_median_sec : null, byRound: buckets(fp.finish_round_distribution) };
  }

  const stances = stanceRows(s);
  return {
    asOf: s.as_of_date, version: s.definition_version, coverage: s.coverage_status,
    completedBouts: s.sample_completed_bouts, statRounds: s.sample_rounds, observedSeconds: s.sample_seconds,
    striking: tiles(m, [["sig_landed_per_min", "Sig. strikes landed / min"], ["sig_accuracy", "Sig. strike accuracy"], ["sig_defense", "Sig. strike defense"], ["sig_diff_per_min", "Strike differential / min", true]]),
    target: target.length === 3 ? target : [],
    grappling: tiles(m, [["td_attempts_per_15", "TD attempts / 15 min"], ["td_accuracy", "TD accuracy"], ["control_share", "Control time share"], ["sub_attempts_per_15", "Sub attempts / 15 min"]]),
    stanceTd: stances.filter((r) => r.tdLanded && r.statBouts > 0),
    rounds: roundSeries(s),
    roundDeltas: tiles(rp as Record<string, MetricObject | undefined>, [["pace_retention_r3_vs_r1", "R3 pace vs R1"], ["defensive_drift_r3_vs_r1", "R3 vs R1 strikes absorbed", true], ["championship_round_delta", "Rds 4–5 vs 1–3 pace", true]]),
    finish,
    stances,
  };
}
