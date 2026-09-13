/**
 * A season's competition format, read from the season rather than assumed.
 *
 * Early TUF seasons were not tidy brackets. Season 1 ran an elimination phase —
 * challenges decided who picked the next matchup, the loser went home, so one
 * fighter could fight twice while another reached the last four without a house
 * fight — then semi-finals, then live finals. Measured against "four
 * quarter-finals" it looks broken; measured against its own format it is
 * complete. So expected stages and counts come from `competition_format` when a
 * season declares one, and only fall back to the modern bracket shape when it
 * does not.
 *
 * Pure: no server imports, so the completeness matrix and the tests share it.
 */
import type { CompetitionFormat, TimelineEvent } from "./tuf";

/** The modern tournament shape, used only for seasons that declare no format. */
export const LEGACY_EXPECTED_BOUTS: Readonly<Record<string, number>> = { final: 1, semi_final: 2, quarter_final: 4, round_of_16: 8 };

export type StageExpectation = {
  expected: number;
  basis: "declared" | "declared_open" | "legacy" | "unknown";
  /** A stage present in the data that the declared format does not list. */
  undeclared?: boolean;
};

export function expectedBouts(format: CompetitionFormat | null | undefined, stage: string, present: number): StageExpectation {
  if (format?.phases?.length) {
    const phase = format.phases.find((p) => p.stage === stage);
    if (!phase) return { expected: present, basis: "unknown", undeclared: true };
    if (phase.expected_bouts == null) return { expected: present, basis: "declared_open" };
    return { expected: phase.expected_bouts, basis: "declared" };
  }
  const legacy = LEGACY_EXPECTED_BOUTS[stage];
  return legacy == null ? { expected: present, basis: "unknown" } : { expected: legacy, basis: "legacy" };
}

export function stageLabel(format: CompetitionFormat | null | undefined, stage: string, fallback: string): string {
  return format?.phases?.find((p) => p.stage === stage)?.label ?? fallback;
}

type BoutLike = { a: string; b: string; winner: string | null };
type SeasonLike = {
  competition_format?: CompetitionFormat;
  bracket?: Array<{ weight_class: string; stages: Array<{ stage: string; bouts: BoutLike[] }> }>;
  timeline_events?: TimelineEvent[];
};

/**
 * Does every fighter in a later stage have a path there that the season's own
 * format allows? For an elimination format: a fighter who lost a house fight or
 * was sent home without one may appear later only if a sourced return brought
 * them back. Winning an elimination bout, or never fighting in the phase, are
 * both valid paths. Returns the fighters with no valid path; empty is coherent.
 * No bout is ever invented to explain a gap.
 */
export function advancementProblems(season: SeasonLike): Array<{ weight_class: string; stage: string; fighter: string; why: string }> {
  const problems: Array<{ weight_class: string; stage: string; fighter: string; why: string }> = [];
  const format = season.competition_format;
  if (!format?.phases?.some((p) => p.stage === "elimination")) return problems;
  const returned = new Set((season.timeline_events ?? []).filter((e) => e.type === "replacement_return").flatMap((e) => e.fighters));
  const sentHome = new Set((season.timeline_events ?? []).filter((e) => e.type === "elimination_without_fight" || e.type === "withdrawal").flatMap((e) => e.fighters));
  for (const wc of season.bracket ?? []) {
    const elimination = wc.stages.find((s) => s.stage === "elimination");
    const lost = new Set((elimination?.bouts ?? []).filter((b) => b.winner).map((b) => (b.winner === b.a ? b.b : b.a)));
    for (const st of wc.stages.filter((s) => s.stage !== "elimination")) {
      for (const b of st.bouts) {
        for (const f of [b.a, b.b]) {
          if ((lost.has(f) || sentHome.has(f)) && !returned.has(f)) {
            problems.push({ weight_class: wc.weight_class, stage: st.stage, fighter: f, why: lost.has(f) ? "lost an elimination bout and no sourced return" : "left the competition and no sourced return" });
          }
        }
      }
    }
  }
  return problems;
}
