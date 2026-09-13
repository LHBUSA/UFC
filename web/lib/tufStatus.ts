/**
 * What the archive can say about a season, on two separate axes.
 *
 * STRUCTURE — is the competition the season actually ran represented? Measured
 * against the season's own format: a declared `competition_format` (TUF 1 and 2
 * ran an elimination phase, not quarter-finals), the points format of a team
 * season (TUF 21), or, for a season that declares neither, the bracket shape
 * its own data holds. Structure asks only whether the stages, the bouts they
 * require and the finals are there. It is never lowered by evidence quality:
 * a secondary-only result, an unresolved identity, an open source conflict or
 * an unresolved exhibition classification is a research gap, not a missing
 * bout.
 *
 * EVIDENCE — does the season clear the completeness bar? That verdict is
 * computed by scripts/tuf/completeness_matrix.mjs (it needs read-only database
 * selects the site cannot make at render time) and exported to
 * web/data/tuf/status.generated.json with a fingerprint of the season data it
 * measured. A season whose data has changed since is never shown as verified.
 *
 * There is no stored coverage label any more: the old `coverage` field
 * (bracket_full / bracket_partial / ...) was import-time state that went stale
 * as seasons were repaired, and it described every season in bracket terms.
 *
 * Pure: no server imports, so the hub, the matrix script and the tests share it.
 */
import type { CompetitionFormat, SeasonRow, TimelineEvent } from "./tuf";
import { advancementProblems, expectedBouts, LEGACY_EXPECTED_BOUTS } from "./tufFormat.ts";

type BoutLike = { a: string; b: string; winner: string | null };
type StageLike = { stage: string; bouts: BoutLike[] };
export type StatusSeasonDetail = {
  competition_format?: CompetitionFormat;
  bracket?: Array<{ weight_class: string; stages: StageLike[] }>;
  timeline_events?: TimelineEvent[];
  team_competition?: { standings?: unknown[]; concluding_bout?: { winner?: string | null } | null } | null;
};
export type StatusSeasonRow = Pick<SeasonRow, "slug" | "season_state" | "weight_classes"> & Partial<Pick<SeasonRow, "completion_unverified">>;

/* ---- structure ------------------------------------------------------------ */

export type StructureBasis = "declared_format" | "team_points_format" | "bracket" | "none";
export type Structure = {
  /** complete | partial, whatever the season state; the hub shows ongoing first. */
  structure: "complete" | "partial";
  basis: StructureBasis;
  /** What is missing from the competition itself. Empty when complete. */
  missing: string[];
};

/** Stages a season that declares no format must hold for every weight class. */
const BRACKET_REQUIRED = ["quarter_final", "semi_final", "final"] as const;

export function structureOf(row: StatusSeasonRow, detail: StatusSeasonDetail | null | undefined): Structure {
  const missing: string[] = [];
  const bracket = detail?.bracket ?? [];
  const bouts = bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts));
  for (const b of bouts) if (!b.a || !b.b) missing.push("a bout with a corner missing");

  /* A team season scored on points: the series, its standings and the bout
   * that concluded it. Bracket stages do not apply. */
  if (detail?.team_competition) {
    const tc = detail.team_competition;
    if (!bouts.length) missing.push("no series bouts");
    if (!tc.standings?.length) missing.push("no team standings");
    if (!tc.concluding_bout) missing.push("no concluding bout");
    return { structure: missing.length ? "partial" : "complete", basis: "team_points_format", missing };
  }

  if (!bracket.length) return { structure: "partial", basis: "none", missing: ["no competition bouts loaded"] };

  const divisions = row.weight_classes?.length ?? 0;
  if (divisions && bracket.length < divisions) missing.push(`${divisions - bracket.length} weight class(es) with no competition loaded`);

  const format = detail?.competition_format;
  const declared = Boolean(format?.phases?.length);
  for (const wc of bracket) {
    const present = new Map(wc.stages.map((s) => [s.stage, s]));
    const required = declared ? format!.phases.map((p) => p.stage) : [...BRACKET_REQUIRED];
    for (const stage of required) {
      const st = present.get(stage);
      if (!st || !st.bouts.length) { missing.push(`${wc.weight_class}: no ${stage.replace(/_/g, " ")}`); continue; }
    }
    for (const st of wc.stages) {
      /* Counts are checked where a number is actually known: a declared phase
       * with a fixed count, or the bracket shape. An undeclared stage (extra
       * house bouts an episode recap records) fixes no number. */
      const exp = expectedBouts(format, st.stage, st.bouts.length);
      const knows = exp.basis === "declared" || (exp.basis === "legacy" && st.stage in LEGACY_EXPECTED_BOUTS);
      if (knows && st.bouts.length < exp.expected) missing.push(`${wc.weight_class}: ${st.stage.replace(/_/g, " ")} ${st.bouts.length} of ${exp.expected} bouts`);
    }
  }
  /* In an elimination format a fighter reaching a later stage needs a path the
   * format allows; one with none means a bout is missing, not a source. */
  if (declared) for (const p of advancementProblems(detail!)) missing.push(`${p.weight_class}: ${p.fighter} has no path to the ${p.stage.replace(/_/g, " ")}`);

  return { structure: missing.length ? "partial" : "complete", basis: declared ? "declared_format" : "bracket", missing };
}

/* ---- evidence ------------------------------------------------------------- */

export type EvidenceEntry = { matrix_status: string; blockers: string[]; fingerprint: string };
export type StatusArtifact = { as_of: string; matrix: string; seasons: Record<string, EvidenceEntry> };
export type Evidence = {
  evidence: "verified" | "gaps";
  /** Why a season is not verified, in the matrix's own terms (detail views only). */
  reasons: string[];
};

/** FNV-1a over the season's own data. Identical in the matrix export and here. */
export function fingerprint(row: unknown, detail: unknown, episodes: unknown): string {
  const s = JSON.stringify([row ?? null, detail ?? null, episodes ?? null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function evidenceOf(row: StatusSeasonRow, entry: EvidenceEntry | undefined, currentFingerprint: string): Evidence {
  if (!entry) return { evidence: "gaps", reasons: ["not measured by the completeness matrix"] };
  if (entry.fingerprint !== currentFingerprint) return { evidence: "gaps", reasons: ["season data changed since the completeness matrix ran"] };
  if (row.completion_unverified) return { evidence: "gaps", reasons: ["completion unverified", ...entry.blockers] };
  return entry.matrix_status === "COMPLETE" ? { evidence: "verified", reasons: [] } : { evidence: "gaps", reasons: entry.blockers };
}

/* ---- what the hub shows --------------------------------------------------- */

/* A card answers one question: is this season represented? Complete means the
 * competition the season ran is fully there in its own format. Verified is an
 * extra, positive layer — the strict evidence verdict above says every result
 * and classification is also backed by primary records — never a precondition
 * for Complete. The research backlog behind a non-verified season (open
 * conflicts, secondary-only sources) belongs on the season page's evidence
 * sections, not on the card; the verdict itself is unchanged and still carried
 * here for anything that needs it. */
export type HubState = "ongoing" | "complete" | "partial";
export type HubStatus = {
  state: HubState;
  /** The strict evidence verdict is VERIFIED (and the season is complete). */
  verified: boolean;
  structure: Structure;
  evidence: Evidence | null;
  /** The one pill every card carries. */
  primary: { label: string; tone: "live" | "ok" | "thin" };
  /** Only ever the positive Verified badge. */
  secondary: { label: string; tone: "ok" } | null;
};

export function hubStatus(row: StatusSeasonRow, detail: StatusSeasonDetail | null | undefined, evidence: Evidence | null): HubStatus {
  const structure = structureOf(row, detail);
  if (row.season_state === "ongoing") {
    return { state: "ongoing", verified: false, structure, evidence: null, primary: { label: "Season ongoing", tone: "live" }, secondary: null };
  }
  const ev = evidence ?? { evidence: "gaps" as const, reasons: ["not measured"] };
  if (structure.structure === "complete") {
    const verified = ev.evidence === "verified";
    return { state: "complete", verified, structure, evidence: ev, primary: { label: "Complete", tone: "ok" }, secondary: verified ? { label: "Verified", tone: "ok" } : null };
  }
  return { state: "partial", verified: false, structure, evidence: ev, primary: { label: "Partial", tone: "thin" }, secondary: null };
}
