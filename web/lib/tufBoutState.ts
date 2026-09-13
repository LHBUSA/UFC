/**
 * Two separate questions about every TUF bout, answered separately.
 *
 *   RESULT          who won, and how well that is attested
 *     verified      a source other than the season draft states the winner: an
 *                   official repair covering the winner, an official recap that
 *                   agrees without contradicting itself, or the professional
 *                   result row the bout was verified against
 *     reported      a winner is recorded, but only the season draft states it
 *     scheduled     a bout on an announced card that has not been fought
 *     unknown       no winner recorded
 *
 *   CLASSIFICATION  whether it was a professional bout
 *     professional | exhibition | unresolved
 *
 * They must not collapse into one label. "Professional" says nothing about
 * whether a result is attested, and a reported winner says nothing about
 * whether the bout was sanctioned. Corroboration — a consistent bracket, a
 * broadcaster naming the pairing, a finalist appearing later — never makes a
 * result verified, because none of it states the result.
 *
 * Pure and dependency-free so it can be tested without the server bundle.
 */
import type { FieldSource } from "./tuf";

export type ResultState = "verified" | "reported" | "scheduled" | "unknown";
export type ClassState = "professional" | "exhibition" | "unresolved";

type BoutLike = {
  a: string; b: string; winner: string | null;
  classification: "professional" | "exhibition" | "unverified";
  classification_source?: string | null;
  result_state?: "scheduled";
  sources?: Array<Pick<FieldSource, "family" | "fields">>;
};
type EpisodesLike = {
  episodes: Array<{ bouts?: Array<{ bracket: { a: string; b: string } | null; result: { winner: string | null; contradiction?: string } | null }> }>;
} | null | undefined;

const fold = (s: string | null | undefined) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const pairKey = (a: string, b: string) => [fold(a), fold(b)].sort().join("|");

/** Winners the official recaps state for bracket pairings, excluding any recap
 * that contradicts itself. Keyed by the pairing, accent- and order-blind. */
export function recapWinners(eps: EpisodesLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of eps?.episodes ?? []) for (const b of e.bouts ?? []) {
    if (!b.bracket || !b.result?.winner || b.result.contradiction) continue;
    out.set(pairKey(b.bracket.a, b.bracket.b), b.result.winner);
  }
  return out;
}

export function resultState(b: BoutLike, recaps: Map<string, string> = new Map()): ResultState {
  if (!b.winner) return b.result_state === "scheduled" ? "scheduled" : "unknown";
  /* A winner printed as neither corner is a data defect; it is not verified
   * whatever else is attached to the bout. */
  if (fold(b.winner) !== fold(b.a) && fold(b.winner) !== fold(b.b)) return "reported";
  const official = (b.sources ?? []).some((s) => s.family !== "wikipedia" && s.fields.includes("winner"));
  const recap = recaps.get(pairKey(b.a, b.b));
  const recapAgrees = Boolean(recap) && fold(recap) === fold(b.winner);
  const resultRow = b.classification === "professional" && /ufc_bout_results/.test(b.classification_source ?? "");
  return official || recapAgrees || resultRow ? "verified" : "reported";
}

export function classState(b: Pick<BoutLike, "classification" | "classification_source">): ClassState {
  if (b.classification === "professional" || b.classification === "exhibition") {
    /* A label with nothing behind it is not a classification. */
    return b.classification_source ? b.classification : "unresolved";
  }
  return "unresolved";
}

export type SeasonBoutSummary = {
  professional: number;
  professional_scheduled: number;
  house: number;
  house_reported: number;
  house_verified: number;
  house_unknown: number;
  house_exhibition: number;
  house_unresolved: number;
};

/** Counts for a season's headline. A "house" bout is anything not classified
 * professional — including those whose classification is unresolved. */
export function summarizeBouts(bouts: BoutLike[], recaps: Map<string, string> = new Map()): SeasonBoutSummary {
  const s: SeasonBoutSummary = { professional: 0, professional_scheduled: 0, house: 0, house_reported: 0, house_verified: 0, house_unknown: 0, house_exhibition: 0, house_unresolved: 0 };
  for (const b of bouts) {
    const r = resultState(b, recaps);
    const c = classState(b);
    if (c === "professional") {
      s.professional += 1;
      if (r === "scheduled") s.professional_scheduled += 1;
      continue;
    }
    s.house += 1;
    if (r === "verified" || r === "reported") s.house_reported += 1;
    if (r === "verified") s.house_verified += 1;
    if (r === "unknown" || r === "scheduled") s.house_unknown += 1;
    if (c === "exhibition") s.house_exhibition += 1;
    else s.house_unresolved += 1;
  }
  return s;
}

/** The headline, as separate phrases. Zero counts are left out. */
export function summaryPhrases(s: SeasonBoutSummary): string[] {
  const out: string[] = [];
  const played = s.professional - s.professional_scheduled;
  if (played) out.push(`Professional: ${played}`);
  if (s.professional_scheduled) out.push(`Professional scheduled: ${s.professional_scheduled}`);
  if (s.house_reported) out.push(`House results reported: ${s.house_reported}${s.house_verified ? ` (${s.house_verified} verified)` : ""}`);
  if (s.house_unknown) out.push(`House results not recorded: ${s.house_unknown}`);
  if (s.house_exhibition) out.push(`House exhibitions: ${s.house_exhibition}`);
  if (s.house_unresolved) out.push(`House classifications unresolved: ${s.house_unresolved}`);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-26" -> "Sep 26, 2026", with no time zone to shift the day. */
export function displayDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso ?? "");
}
