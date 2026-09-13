/**
 * Episode-by-episode season history, assembled from facts the archive already
 * holds — never written as prose, never copied.
 *
 * An episode card REFERENCES canonical season facts:
 *   - the bracket bouts whose `episode` is this episode (the bracket stays the
 *     single result record; an official recap bout for the same pairing adds
 *     its weigh-ins and pick, not a second result)
 *   - the season's sourced timeline events placed in this episode
 *   - recap-only bouts and recap tournament events, where a recap exists
 * An episode with none of these says so plainly. A missing UFC.com recap is not
 * a missing episode history, and is never the headline.
 *
 * Pure: no server imports.
 */
import type { CompetitionFormat, Episode, EpisodeBout, EvidenceSource, SeasonEpisodes, Stage, TimelineEvent, TufBout } from "./tuf";

type Bracket = Array<{ weight_class: string; stages: Array<Pick<Stage, "stage" | "label" | "bouts">> }>;
type SeasonLike = { bracket?: Bracket; timeline_events?: TimelineEvent[]; competition_format?: CompetitionFormat };

export type AiredBout = { bout: TufBout; stage: Stage["stage"]; stage_label: string; weight_class: string; recap: EpisodeBout | null };

export type EpisodeView = {
  episode: Episode;
  bouts: AiredBout[];
  recapOnlyBouts: EpisodeBout[];
  events: TimelineEvent[];
  recapEvents: NonNullable<Episode["events"]>;
  hasFacts: boolean;
};

/* Recap tournament events worth a line; the rest of house life is not data. */
export const SHOWN_RECAP_EVENTS = new Set(["replacement", "withdrawal", "injury", "wildcard", "missed_weight", "medical_postponement", "catchweight", "coin_toss", "coach_challenge"]);

const same = (x: string, y: string) => x.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase() === y.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function buildEpisodeViews(season: SeasonLike, eps: Pick<SeasonEpisodes, "episodes"> | null): { episodes: EpisodeView[]; unplacedEvents: TimelineEvent[] } {
  const events = season.timeline_events ?? [];
  const bouts: Array<Omit<AiredBout, "recap">> = [];
  for (const wc of season.bracket ?? []) for (const st of wc.stages) for (const b of st.bouts) {
    bouts.push({ bout: b as TufBout, stage: st.stage, stage_label: st.label, weight_class: wc.weight_class });
  }
  const episodes = (eps?.episodes ?? []).map((episode): EpisodeView => {
    const n = episode.episode_number;
    const recaps = episode.bouts ?? [];
    const used = new Set<EpisodeBout>();
    const aired: AiredBout[] = bouts.filter((x) => x.bout.episode === n).map((x) => {
      const recap = recaps.find((r) => r.bracket && r.bracket.weight_class === x.weight_class && r.bracket.stage === x.stage
        && ((same(r.bracket.a, x.bout.a) && same(r.bracket.b, x.bout.b)) || (same(r.bracket.a, x.bout.b) && same(r.bracket.b, x.bout.a)))) ?? null;
      if (recap) used.add(recap);
      return { ...x, recap };
    });
    const recapOnlyBouts = recaps.filter((r) => !used.has(r));
    const placed = events.filter((e) => e.episode === n);
    const recapEvents = (episode.events ?? []).filter((e) => SHOWN_RECAP_EVENTS.has(e.type));
    return { episode, bouts: aired, recapOnlyBouts, events: placed, recapEvents, hasFacts: aired.length + recapOnlyBouts.length + placed.length + recapEvents.length > 0 };
  });
  return { episodes, unplacedEvents: events.filter((e) => e.episode == null) };
}

export type RosterMark = { label: string; episode: number | null; kind: string; unresolved?: boolean };

/** Short, factual marks for a roster card, each pointing into the timeline. */
export function rosterMarks(season: SeasonLike): Map<string, RosterMark[]> {
  const out = new Map<string, RosterMark[]>();
  const add = (name: string, m: RosterMark) => out.set(name, [...(out.get(name) ?? []), m]);
  for (const e of season.timeline_events ?? []) {
    const ep = e.episode;
    const unresolved = ep == null && Boolean(e.episode_candidates?.length);
    for (const f of e.fighters) {
      if (e.type === "trade" && e.to_team) add(f, { label: `To ${e.to_team}`, episode: ep, kind: "trade", unresolved });
      else if (e.type === "elimination_without_fight") add(f, { label: "Sent home", episode: ep, kind: "elimination" });
      else if (e.type === "withdrawal") add(f, { label: "Withdrew", episode: ep, kind: "withdrawal" });
      else if (e.type === "replacement_return") add(f, { label: "Returned", episode: ep, kind: "return" });
      else if (e.type === "staff_change") add(f, { label: "Assistant coach", episode: ep, kind: "staff" });
    }
  }
  /* Where the declared format sends the loser home, a lost house fight is an
   * elimination. That is read from the bracket, not restated in the data. */
  const eliminationFormat = season.competition_format?.phases?.some((p) => p.stage === "elimination");
  if (eliminationFormat) {
    for (const wc of season.bracket ?? []) for (const st of wc.stages) {
      if (st.stage !== "elimination" && st.stage !== "semi_final") continue;
      for (const b of st.bouts) {
        if (!b.winner) continue;
        add(b.winner === b.a ? b.b : b.a, { label: st.stage === "semi_final" ? "Lost semi-final" : "Lost elimination fight", episode: b.episode ?? null, kind: "bout_loss" });
      }
    }
  }
  for (const [k, v] of out) out.set(k, v.sort((x, y) => (x.episode ?? 99) - (y.episode ?? 99)));
  return out;
}

export type TimelineCounts = {
  trades: number; withdrawals: number; replacements: number; alternates: number; injuries: number;
  eliminations_without_fight: number; eliminations_by_bout: number; eliminations: number;
  weight_events: number; staff_changes: number; unresolved_placements: number;
};

export function timelineCounts(season: SeasonLike): TimelineCounts {
  const ev = season.timeline_events ?? [];
  const n = (t: string) => ev.filter((e) => e.type === t).length;
  const eliminationFormat = season.competition_format?.phases?.some((p) => p.stage === "elimination");
  let byBout = 0;
  if (eliminationFormat) for (const wc of season.bracket ?? []) for (const st of wc.stages) {
    if (st.stage === "elimination" || st.stage === "semi_final") byBout += st.bouts.filter((b) => b.winner).length;
  }
  return {
    trades: n("trade"), withdrawals: n("withdrawal"), replacements: n("replacement_return"), alternates: n("alternate_named"),
    injuries: n("injury"), eliminations_without_fight: n("elimination_without_fight"), eliminations_by_bout: byBout,
    eliminations: n("elimination_without_fight") + byBout, weight_events: n("weight_issue"), staff_changes: n("staff_change"),
    unresolved_placements: ev.filter((e) => e.episode == null).length,
  };
}

const FAMILY_LABEL: Record<string, string> = {
  our_records: "Our fight records",
  "ufc.com": "UFC.com",
  ufc_com_recap: "UFC.com recap",
  paramount_plus_episode_metadata: "Paramount+ listing",
  espn_retrospective: "ESPN retrospective",
  espn_core_api: "ESPN",
  wikipedia: "Wikipedia",
};
const LEVEL_LABEL: Record<string, string> = {
  canonical: "canonical",
  official: "official",
  network_listing: "network",
  secondary_affirmative: "secondary, affirmative",
  secondary: "secondary",
  secondary_draft: "draft",
  corroboration_only: "corroboration only",
};

/** "Wikipedia (draft)", "ESPN retrospective (secondary, affirmative)". */
export function sourceLabel(s: Pick<EvidenceSource, "family" | "evidence_level" | "published">): string {
  const family = FAMILY_LABEL[s.family] ?? s.family;
  const year = s.family === "espn_retrospective" && s.published ? ` ${s.published.slice(0, 4)}` : "";
  const level = LEVEL_LABEL[s.evidence_level] ?? s.evidence_level;
  return `${family}${year}${level ? ` (${level})` : ""}`;
}

/** Distinct source labels, in order, for a compact evidence line. */
export function sourceLabels(sources: ReadonlyArray<Pick<EvidenceSource, "family" | "evidence_level" | "published">> | undefined): string[] {
  return [...new Set((sources ?? []).map(sourceLabel))];
}
