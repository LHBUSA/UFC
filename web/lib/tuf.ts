/**
 * The Ultimate Fighter archive.
 *
 * Two sources, deliberately kept apart.
 *
 * Season metadata — editions, coaches, brackets, champions — is committed
 * JSON with its provenance attached, because none of it exists in our fight
 * database and none of it can be derived from one. Professional results stay
 * in the database and are read from there. The season pages join the two; they
 * never copy one into the other, so there is exactly one copy of every
 * professional bout and importing a finale card cannot create a duplicate.
 *
 * The rule that matters most here: a bout filmed inside the TUF house is an
 * unsanctioned exhibition. It does not belong on a professional record and it
 * must not reach a professional aggregate. Every bout in the data carries an
 * explicit `classification` — professional, exhibition or unverified — and
 * nothing infers one from the TUF label. `unverified` is treated exactly like
 * an exhibition for record purposes: an unproven classification is not a
 * licence to count something.
 */
import "server-only";
import type { PortraitSet } from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import inventory from "@/data/tuf/seasons.json";
import identityIndex from "@/data/tuf/identity.index.json";
import { TUF_DETAILS } from "@/data/tuf/details.generated";
import { TUF_EPISODES } from "@/data/tuf/episodes.generated";
import commissionLedger from "@/data/tuf/commission_records.json";
import statusArtifact from "@/data/tuf/status.generated.json";
import { evidenceOf, fingerprint, hubStatus, type HubStatus, type StatusArtifact } from "@/lib/tufStatus";
import { shapeFinale, type FinaleBoutRow, type FinaleIntegration, type RoundRow, type ScorecardRow } from "@/lib/tufFinaleShape";

/* ---- episodes ------------------------------------------------------------- */

export type EpisodeWeighIn = {
  fighter: string; fighter_id?: string; weight_lbs: number | null; weight_text?: string;
  missed_weight: boolean; limit_lbs: number | null; made_weight_on_retry?: boolean;
  episode_number: number; source_url: string;
};
export type EpisodeBout = {
  a: string; b: string; a_fighter_id?: string; b_fighter_id?: string;
  weight_class: string | null; stage: string | null;
  bracket: { weight_class: string; stage: string; a: string; b: string } | null;
  result: { winner: string | null; winner_fighter_id?: string; method: string | null; round: number | null; time: string | null; contradiction?: string } | null;
  weigh_ins: EpisodeWeighIn[];
  fight_pick: { chosen_by: string } | null;
  caption_filming_dates: string[];
};
/** How an air date was (or was not) resolved. See scripts/tuf/lib/airDates.mjs:
 * the network listing date and an independent source must give the same day. */
export type AirDateResolution = {
  basis: "network_listing + independent_source" | null;
  status: "resolved" | "unresolved";
  why?: string;
  network_listing_date: string | null;
  network_display_date: string | null;
  independent_date: string | null;
  network_source?: { family: string; url: string; retrieved: string };
  independent_source?: { family: string; url: string; retrieved: string; cites?: string };
  date_conflict_note?: string;
};
export type Episode = {
  episode_number: number;
  title: string | null;
  title_source: "paramount_plus" | null;
  /** Null unless the two-source rule resolved it (air_date_resolution says how). */
  air_date: string | null;
  air_date_resolution?: AirDateResolution;
  /** The Paramount+ listing's own date. Not by itself a broadcast date. */
  listing_date: string | null;
  recap_url: string | null;
  recap_published: string | null;
  recap_byline_date: string | null;
  bouts?: EpisodeBout[];
  fight_pick_control?: string | null;
  events?: Array<{ type: string; text: string; fighters: string[]; fighter_ids: Array<string | null> }>;
};
export type SeasonEpisodes = {
  slug: string;
  sources: { titles: string | null; recaps: string | null };
  finale_broadcast?: { title: string; listing_date: string | null; air_date?: string | null; air_date_resolution?: AirDateResolution };
  missing_recaps?: Array<{ episode_number: number; why: string }>;
  /** Known defects in a source's own metadata, kept rather than silently corrected. */
  source_defects?: Array<{ family: string; episodes: number[] | "all"; defect: string; detail: string; retrieved: string }>;
  episodes: Episode[];
};

/** The episode layer for a season, or null where none is recorded. */
export function episodesFor(slug: string): SeasonEpisodes | null {
  return (TUF_EPISODES[slug] as SeasonEpisodes | undefined) ?? null;
}

/** Every in-house weigh-in the recaps record for a fighter, by canonical id. */
export function tufWeighInsForFighter(fighterId: string): Array<EpisodeWeighIn & { slug: string; opponent: string }> {
  const out: Array<EpisodeWeighIn & { slug: string; opponent: string }> = [];
  for (const [slug, file] of Object.entries(TUF_EPISODES) as Array<[string, SeasonEpisodes]>) {
    for (const e of file.episodes) for (const b of e.bouts ?? []) for (const w of b.weigh_ins) {
      if (w.fighter_id === fighterId) out.push({ ...w, slug, opponent: w.fighter === b.a ? b.b : b.a });
    }
  }
  return out;
}

/* Detail files are imported rather than read from disk so they are bundled
 * with the deployment. A season with no detail file yet renders from its
 * inventory row alone, which is the honest state for much of the archive.
 * The import map is generated from the directory by
 * scripts/tuf/build_details_index.mjs, so adding a season cannot silently
 * leave it unbundled and looking like missing data. */
const DETAILS: Record<string, unknown> = TUF_DETAILS;

export type Classification = "professional" | "exhibition" | "unverified";

export type Edition = { key: string; name: string; short: string; blurb: string };

export type SeasonWinner = { weight_class: string; fighter: string; fighter_id?: string };

/** Where a repaired or added fact came from. Wikipedia drafted the season
 * files; an official source that states a field overrides it and says so. */
export type FieldSource = {
  repair: string; fields: string[]; url: string; family: string;
  published_on_site?: string; published_note?: string; retrieved: string; quote: string; corroboration?: string[];
  /** The broadcaster's listing item, for listing-sourced fields. */
  content_id?: string;
  /** Recorded on sources that attest a pairing but never a result, so no
   * reader can mistake one for result evidence. */
  states_winner?: false;
  /** Archive name -> the name this source printed, where they differ. */
  printed_names?: Record<string, string>;
};

/** One piece of evidence for a season fact, with its quality stated. */
export type EvidenceSource = {
  family: string;
  evidence_level: "canonical" | "official" | "network_listing" | "secondary_affirmative" | "secondary" | "secondary_draft" | "corroboration_only" | string;
  url?: string; retrieved?: string; published?: string; author?: string;
  quote?: string; note?: string; content_id?: string; listing_item?: number; what?: string; kind?: string;
  /** Set on an athletic commission record, which must name the document and the
   * bout record it cites; a government URL alone is never a source. */
  source_type?: "commission_result_record" | string; jurisdiction?: string; commission?: string;
  document_id?: string; record_id?: string; winner?: string; archive_url?: string; sha256?: string;
};

/* ---- athletic commission records ------------------------------------------ */

export type CommissionDocument = {
  id: string; source_family: "athletic_commission"; source_type: "commission_result_record";
  commission: string; jurisdiction: string; document: string; seasons: string[];
  url: string; archive_url?: string; sha256?: string; pages?: number; retrieved: string;
  location?: string; promoter?: string;
  classification_language?: { quote: string; where: string };
  classification_history?: string;
  /** How the document is tied to a season when it prints no season name. */
  season_identity?: { printed: boolean; basis: string };
  /** Where a printed identity fact (a date of birth) differs from the canonical
   * fighter. Recorded, never written: the canonical value is not changed. */
  identity_disagreements?: Array<{ fighter: string; fighter_id: string; field: "dob"; printed: string; canonical: string; record_ids: string[]; action: "recorded_only" }>;
};
export type CommissionRecord = {
  /** `date` is the interpreted ISO date. `date_printed` keeps the document's own
   * rendering where it could not be read as a date as printed (a missing
   * separator, say), so the machine value never passes for the source text. */
  id: string; document_id: string; date: string; date_printed?: string; stage_label: string | null;
  corners: Array<{ printed: string; hometown?: string; dob?: string; weight_lbs?: number }>;
  bout: { weight_class: string; stage: string; a: string; b: string };
  winner: string; result_text: string; method: string; round: number | null; time: string | null; scheduled_rounds?: number;
  scorecards: { order: [string, string]; cards: Array<{ judge: string; score: string }> } | null;
  referee?: string; remarks: Array<{ fighter: string; quote: string }>;
};
const COMMISSION = commissionLedger as unknown as { documents: CommissionDocument[]; records: CommissionRecord[] };
export function commissionRecord(id: string | undefined | null): { record: CommissionRecord; document: CommissionDocument } | null {
  const record = id ? COMMISSION.records.find((r) => r.id === id) : undefined;
  const document = record ? COMMISSION.documents.find((d) => d.id === record.document_id) : undefined;
  return record && document ? { record, document } : null;
}

/** A correction an authoritative source made to a drafted value.
 * `commission_correction`: the primary record states a different value.
 * `method_normalization`: the primary record states the method less
 * specifically; the canonical method becomes its wording and the draft's
 * compatible extra detail moves to the bout's `method_detail` — the draft is
 * not shown to be wrong. */
export type FieldCorrection = {
  field: string; old: unknown; new: unknown; reason: string; batch?: string;
  /** The commission record a commission correction cites. */
  source?: { document_id?: string; record_id?: string };
  /** `official_source_correction`: a first-party UFC source states the value
   * (the repair key and the sources that state it are carried alongside). */
  kind?: "commission_correction" | "method_normalization" | "official_source_correction";
  repair?: string;
  sources?: EvidenceSource[];
  approved?: { by: string; on: string };
  /** For a method normalization: the compatible detail kept in method_detail. */
  detail?: string;
};

/** A detail a secondary source adds to a method a primary record states less
 * specifically ("doctor stoppage" under a commission's "TKO"). It carries its
 * own source and is never part of the verified result. */
export type MethodDetail = { value: string; relation: "compatible_detail"; source: EvidenceSource };

/** Why a bout has the classification it has. `affirmative` is the authority;
 * `corroborating` supports it and can never stand in for it. */
export type ClassificationBasis = {
  affirmative: EvidenceSource[];
  corroborating: EvidenceSource[];
  authority?: "affirmative";
  reopen_if?: string;
};

/** A season's declared competition format. Stages and their expected bout
 * counts come from here, not from an assumed modern bracket. */
export type FormatPhase = {
  stage: Stage["stage"] | "league";
  label: string;
  /** Bouts expected per weight class; null where the format fixes no number. */
  expected_bouts: number | null;
  advances?: number;
  rule?: string;
  contested?: string;
};
export type CompetitionFormat = {
  kind: string;
  label: string;
  applies_to?: string;
  /** Steps before any bout: exits, draft. Never bouts. */
  steps?: Array<{ key: string; label: string; episode?: number; rule: string }>;
  phases: FormatPhase[];
  sources?: EvidenceSource[];
};

export type TimelineEventType =
  | "team_selection" | "elimination_without_fight" | "weight_issue" | "trade" | "injury" | "matchup_ordered"
  | "withdrawal" | "replacement_return" | "staff_change" | "alternate_named" | "semi_final_matchups_announced" | string;

/** A sourced competition event. Bouts are never repeated here: an episode reads
 * its bouts from the bracket, which stays the single result record. */
export type TimelineEvent = {
  id: string;
  episode: number | null;
  /** Set with `conflict` when sources place the event in different episodes. */
  episode_candidates?: number[];
  conflict?: string;
  type: TimelineEventType;
  fighters: string[];
  team?: string; from_team?: string; to_team?: string; replaces?: string;
  detail: string;
  sources: EvidenceSource[];
};

export type OverviewFact = { value?: string | number; date?: string; start?: string; end?: string; event?: string; basis?: string; sources?: EvidenceSource[] };
export type SeasonOverview = {
  format?: OverviewFact; premiere?: OverviewFact; finale?: OverviewFact; filming?: OverviewFact;
  /** When the house bouts were fought: never the broadcast window. */
  fight_window?: OverviewFact;
  cast_size?: OverviewFact; network?: OverviewFact; hosts?: OverviewFact;
};

/** Cast who left before the draft. Their exits are timeline events, not bouts. */
export type PreDraftEntry = {
  name: string; fighter_id?: string; weight_class: string | null; weight_class_note?: string;
  exit: "injury" | "left_show" | "forfeit" | string; episode: number; timeline_event: string; identity_note?: string;
};

/** A bout on an announced card that has not been fought. Linked by the exact
 * finalist-versus-finalist bout id; the result, when it exists, is read from
 * that row and never written here in advance. */
export type ScheduledBout = { event: string; date: string; event_id: string; ufc_bout_id: string; verified_against: string };

/** A printed name the archive replaced, and why. `spelling_variant` keeps the
 * old spelling as a misprint of the same name; `source_correction` replaces a
 * draft name no first-party source attests, which is not an alias. */
export type NameCorrection = {
  draft_name: string; name: string; fighter_id: string;
  kind: "spelling_variant" | "source_correction";
  official_alias?: false; basis: string; batch: string;
  sources: Array<{ family: string; url: string; retrieved: string; content_id?: string }>;
  applied: { bout_corners: number; bout_winners: number; roster: number };
};

export type SeasonRow = {
  slug: string;
  edition: string;
  number: number;
  name: string;
  year: number;
  coaches: string[];
  /** Canonical ids for `coaches`, position for position; null where unresolved. */
  coach_fighter_ids?: Array<string | null>;
  coaches_note?: string;
  weight_classes: string[];
  winners: SeasonWinner[];
  finalists?: Array<{ weight_class: string; fighters: string[]; fighter_ids?: Array<string | null> }>;
  winner_note?: string;
  format_note?: string;
  completion_unverified?: boolean;
  ongoing?: boolean;
  finale_event: string | null;
  finale_date: string | null;
  finale_link_basis?: string;
  /** Row-level corrections from official sources, each with its repair key and old value. */
  corrections?: FieldCorrection[];
  /** One entry per weight class. A list, not a single card, because a
   * season's divisions have been decided on different nights. */
  final_bouts?: Array<{
    weight_class: string; a: string; b: string; winner?: string;
    method?: string | null; round?: number | null;
    event: string; date: string; verified_against?: string;
    /** Present only for an announced final not yet fought. */
    status?: "scheduled"; ufc_bout_id?: string;
  }>;
  /** A link we withdrew or could not establish, with what blocks it. Kept so
   * the gap is actionable rather than invisible. */
  unresolved_finale?: { withdrawn_match?: string; why_wrong?: string; candidate_card?: string; blocker: string };
  /** A fact about the season, not about us. What the archive holds for it is
   * derived, never stored: see seasonStatus() and web/lib/tufStatus.ts. */
  season_state: "completed" | "ongoing";
  detail?: string;
};

export type TufBout = {
  a: string;
  b: string;
  winner: string | null;
  method: string | null;
  round: number | null;
  time: string | null;
  /** Broadcast episode. Deliberately separate from the fight date: a TUF bout
   * is filmed months before it airs, and conflating the two would misdate
   * every result in the archive. */
  episode: number | null;
  fight_date?: string | null;
  classification: Classification;
  /** What established the classification. Required for anything other than
   * 'unverified': a classification with no source behind it is a guess, and a
   * guess must not be allowed to look like a finding. */
  classification_source?: string | null;
  replacement?: string;
  on_finale_card?: boolean;
  tournament_deciding?: boolean;
  /** What a result was worth, for the one season scored by points rather than
   * decided by a bracket. Absent everywhere else, because everywhere else the
   * prize for winning was the next round. */
  points?: number | null;
  /** Canonical fighter ids for each corner, stamped by
   * scripts/tuf/resolve_identity.mjs. Absent means the name did not resolve
   * to a fighter under the identity rules, not that it was not checked. */
  a_fighter_id?: string;
  b_fighter_id?: string;
  wildcard?: boolean;
  result_note?: string;
  /** Secondary detail beside a primary record's less specific method; see MethodDetail. */
  method_detail?: MethodDetail;
  sources?: FieldSource[];
  /** Set, with `scheduled`, only while the bout is announced and unfought. */
  result_state?: "scheduled";
  scheduled?: ScheduledBout;
  /** Why `episode` is null, where that was checked against the listing. */
  episode_blocker?: string;
  /** What places the bout in its episode, and what states its result. */
  episode_sources?: EvidenceSource[];
  result_sources?: EvidenceSource[];
  /** Sources that stated the result before a primary record replaced them.
   * History only: never read to verify a result. */
  superseded_result_sources?: EvidenceSource[];
  classification_basis?: ClassificationBasis;
  /** The professional bout this row is, for a final on a sanctioned card. */
  ufc_bout_id?: string;
  fight_date_source?: { document_id?: string; record_id?: string };
  commission_record_id?: string;
  corrections?: FieldCorrection[];
};

export type Stage = {
  stage: "elimination" | "round_of_16" | "quarter_final" | "semi_final" | "final";
  label: string;
  status?: "unverified";
  note?: string;
  bouts: TufBout[];
  /** Bouts a source lists that we cannot reconcile — kept visible so the gap
   * is legible, and never counted as results. */
  disputed?: Array<TufBout & { dispute: string }>;
};

export type SeasonDetail = SeasonRow & {
  _provenance?: { primary: string; retrieved: string; note?: string };
  _conflicts?: Array<{ field: string; detail: string; retrieved?: string }>;
  classification_policy?: { in_house: string; finale: string; rationale: string };
  coaches_full?: StaffEntry[];
  teams?: Array<{
    name: string; region?: string; pick_basis?: string; sources?: FieldSource[];
    roster: RosterEntry[];
  }>;
  draft?: { first_selection?: string; first_fight_pick?: string; basis?: string; fight_pick_rule?: string; source?: string };
  _resolved_conflicts?: Array<{ field: string; detail: string; resolved_by: string; resolved_with: string; resolution: string }>;
  name_corrections?: NameCorrection[];
  competition_format?: CompetitionFormat;
  pre_draft_cast?: PreDraftEntry[];
  timeline_events?: TimelineEvent[];
  overview?: SeasonOverview;
  bracket?: Array<{ weight_class: string; stages: Stage[] }>;
  /** Seasons decided by points between two gyms rather than by a bracket.
   * Season 21 is the only one so far. Its standings are read from the source
   * rather than counted off the bouts, because the gym with fewer wins won. */
  team_competition?: {
    format: string;
    note?: string;
    standings?: Array<{ team: string; points: number | null; wins: number | null }>;
    concluding_bout?: {
      a: string; b: string; winner: string | null;
      method?: string | null; round?: number | null; weight_class?: string | null;
      event?: string | null; date?: string | null;
      verified_against?: string | null; note?: string;
    };
  };
  finale?: { event_name: string; event_date: string; venue?: string; link_policy?: string };
  champions?: Array<{
    weight_class: string;
    fighter: string;
    won_tournament: boolean;
    received_contract: boolean;
    /** Some winners received a championship rather than a contract. Kept
     * separate because "won the tournament" has meant different prizes in
     * different seasons. */
    received_title?: string;
    contract_note?: string;
    /** What the winning bout was checked against — a real result row, not a
     * season summary. Absent means sourced but unchecked, and the archive
     * says which. */
    verified_against?: string;
    winning_bout?: { a: string; b: string; event: string; date: string };
  }>;
};

export type StaffRole = "head" | "assistant" | "guest" | "other";
export type StaffEntry = {
  team: string | null; name: string; role: StaffRole; fighter_id?: string;
  nickname?: string; discipline?: string; region?: string; note?: string; printed_as?: string;
  role_basis: string; team_basis?: string;
  /** A role taken on partway through the season. */
  from_episode?: number;
  role_sources?: EvidenceSource[];
};
export type RosterEntry = {
  name: string; fighter_id?: string; country?: string; note?: string; weight_class?: string;
  pick?: number; status?: "withdrawn" | "replacement"; replacement_for?: string; episode?: number;
  printed_as?: string; sources?: FieldSource[];
};

const INV = inventory as unknown as {
  editions: Edition[];
  seasons: SeasonRow[];
  _conflicts?: Array<{ scope: string; field: string; detail: string; retrieved?: string }>;
  /** Inventory conflicts settled by a named source, kept as history. */
  _resolved_conflicts?: Array<{ scope: string; field: string; detail: string; resolved_by: string; resolved_with: string; resolution: string }>;
  _provenance?: { primary: string; retrieved: string; note?: string };
};

export function editions(): Edition[] {
  return INV.editions;
}

export function seasons(): SeasonRow[] {
  return [...INV.seasons].sort((a, b) => (a.year - b.year) || (a.number - b.number));
}

export function inventoryConflicts() {
  return INV._conflicts ?? [];
}

export function inventoryProvenance() {
  return INV._provenance ?? null;
}

export function seasonBySlug(slug: string): SeasonDetail | null {
  const row = INV.seasons.find((s) => s.slug === slug);
  if (!row) return null;
  const detail = DETAILS[slug] as Record<string, unknown> | undefined;
  if (!detail) return row as SeasonDetail;
  /* The inventory row wins on the fields it owns, so a season cannot claim a
   * winner in its detail file that the inventory does not carry. */
  const { coaches: detailCoaches, ...rest } = detail as { coaches?: unknown };
  return { ...(rest as object), ...row, coaches_full: detailCoaches as SeasonDetail["coaches_full"] } as SeasonDetail;
}

/* ---- season status ------------------------------------------------------ */

/* Structure (from the season's own format) and evidence (from the completeness
 * matrix) are derived per season; see web/lib/tufStatus.ts. Nothing here reads
 * a stored label. The fingerprint check means an evidence verdict computed
 * against older season data can never present a season as verified. */
const STATUS = statusArtifact as unknown as StatusArtifact;
let statusCache: Map<string, HubStatus> | null = null;

export function seasonStatuses(): Map<string, HubStatus> {
  if (statusCache) return statusCache;
  const out = new Map<string, HubStatus>();
  for (const row of INV.seasons) {
    const detail = DETAILS[row.slug] as Parameters<typeof hubStatus>[1];
    const evidence = evidenceOf(row, STATUS.seasons[row.slug], fingerprint(row, DETAILS[row.slug], TUF_EPISODES[row.slug]));
    out.set(row.slug, hubStatus(row, detail, evidence));
  }
  statusCache = out;
  return out;
}

export type StatusReport = {
  seasons: number;
  /* complete + partial + ongoing = seasons */
  complete: number;
  partial: number;
  ongoing: number;
  /* A subset of complete: also verified by primary records. */
  verified: number;
  /* Separate axis: a finale card we hold says nothing about the season's structure. */
  finales_named: number;
  evidence_as_of: string;
};

export function statusReport(): StatusReport {
  const st = [...seasonStatuses().values()];
  const n = (k: HubStatus["state"]) => st.filter((x) => x.state === k).length;
  return {
    seasons: st.length,
    complete: n("complete"),
    partial: n("partial"),
    ongoing: n("ongoing"),
    verified: st.filter((x) => x.state === "complete" && x.verified).length,
    finales_named: INV.seasons.filter((r) => r.finale_event).length,
    evidence_as_of: STATUS.as_of,
  };
}

/* ---- record safety ------------------------------------------------------ */

/**
 * Whether a bout may be counted towards a professional record.
 *
 * Only an explicitly professional classification qualifies. `unverified` is
 * excluded on purpose: not knowing whether something was sanctioned is not a
 * reason to count it, and a record that quietly absorbs unproven bouts is
 * worse than one that is short.
 */
export function countsTowardsRecord(b: Pick<TufBout, "classification" | "classification_source">): boolean {
  /* Professional AND sourced. A bout labelled professional with nothing
   * behind the label is exactly the thing that should not silently enter a
   * record, so the source is part of the test rather than documentation of
   * it. */
  return b.classification === "professional" && Boolean(b.classification_source);
}

/** Every bout of a season, flattened, in bracket order. */
export function allBouts(season: SeasonDetail): Array<TufBout & { stage: Stage["stage"]; weight_class: string }> {
  const out: Array<TufBout & { stage: Stage["stage"]; weight_class: string }> = [];
  for (const wc of season.bracket ?? []) {
    for (const st of wc.stages) {
      /* Disputed entries are deliberately excluded: they are shown on the
       * page so the gap is visible, and counted nowhere. */
      for (const b of st.bouts) out.push({ ...b, stage: st.stage, weight_class: wc.weight_class });
    }
  }
  return out;
}

/** Exhibition and unverified bouts a fighter appeared in, for their history.
 * Shown separately from the professional record, never merged into it. */
export function nonProfessionalAppearances(fighterId: string) {
  const hits: Array<{ season: SeasonRow; bout: TufBout & { stage: Stage["stage"]; weight_class: string }; side: "a" | "b" }> = [];
  if (!fighterId) return hits;
  for (const row of INV.seasons) {
    const d = seasonBySlug(row.slug);
    if (!d?.bracket) continue;
    for (const b of allBouts(d)) {
      if (countsTowardsRecord(b)) continue;
      if (b.a_fighter_id === fighterId) hits.push({ season: row, bout: b, side: "a" });
      else if (b.b_fighter_id === fighterId) hits.push({ season: row, bout: b, side: "b" });
    }
  }
  return hits;
}

/* ---- linking to canonical records --------------------------------------- */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function rest<T>(path: string, fallback: T): Promise<T> {
  if (!URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate: 300 } });
    if (!res.ok) {
      console.error(`[tuf] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return fallback;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : fallback;
  } catch (e) {
    console.error(`[tuf] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return fallback;
  }
}

export type LinkedEvent = { id: string; name: string; event_date: string | null };

/**
 * The finale card we already hold, if we hold it.
 *
 * Looked up, never created. If the event is absent this returns null and the
 * page says the card is not loaded — which is the truth for the twenty
 * pre-2015 finales whose bouts the historical backfill has not reached yet.
 */
export async function linkedFinale(name: string | null, date: string | null): Promise<LinkedEvent | null> {
  if (!name) return null;
  const q = `ufc_events?select=id,name,event_date&name=eq.${encodeURIComponent(name)}${date ? `&event_date=eq.${date}` : ""}&limit=1`;
  const rows = await rest<LinkedEvent[]>(q, []);
  return rows[0] ?? null;
}

export type ScheduledBoutNow = { status: string; has_result: boolean };

/**
 * What our records say NOW about bouts the archive lists as scheduled.
 *
 * The archive's "scheduled" is a fact with an expiry date, so the page never
 * trusts it alone: once the result row exists, or the bout is cancelled, the
 * page says so instead of showing a fight that already happened as upcoming.
 * A bout missing from the answer (no database, or a failed read) is reported
 * as unknown by the caller, not as still scheduled.
 */
export async function scheduledBoutsNow(boutIds: string[]): Promise<Map<string, ScheduledBoutNow>> {
  const ids = [...new Set(boutIds.filter((id) => /^[0-9a-f-]{36}$/.test(id)))];
  const out = new Map<string, ScheduledBoutNow>();
  if (!ids.length) return out;
  const rows = await rest<Array<{ id: string; status: string; result: unknown }>>(
    `ufc_bouts_effective?select=id,status:effective_status,result:ufc_bout_results(winner_id)&id=in.(${ids.join(",")})`,
    [],
  );
  for (const r of rows) {
    const result = Array.isArray(r.result) ? r.result[0] : r.result;
    out.set(r.id, { status: r.status, has_result: Boolean(result) });
  }
  return out;
}

/**
 * The finale card as our records hold it, joined to the season: its finals
 * (with judges' cards and round coverage), the other bouts between castmates,
 * how many contestants debuted there, and the coaches' fight if one followed.
 * Read-only joins; nothing is copied into the season data. Null when the card
 * is not in our records.
 */
export async function finaleIntegration(season: SeasonDetail, event: LinkedEvent | null, contestantIds: string[], coachIds: string[]): Promise<FinaleIntegration | null> {
  if (!event?.event_date) return null;
  const eventDate = event.event_date;
  const F = "id,name,espn_athlete_id,ufcstats_id";
  const bouts = await rest<FinaleBoutRow[]>(
    `ufc_bouts?select=id,bout_order,weight_class_raw,is_title,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${F}),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${F}),result:ufc_bout_results(winner_id,method_raw,round,time_sec)&event_id=eq.${event.id}&order=bout_order.asc`,
    [],
  );
  if (!bouts.length) return null;
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const rows = bouts.map((b) => ({ ...b, result: one(b.result) }));
  const ids = rows.map((b) => b.id).join(",");
  const cast = [...new Set(contestantIds)];
  const [scorecards, rounds, careers, coachBouts] = await Promise.all([
    rest<ScorecardRow[]>(`ufc_bout_scorecards?select=bout_id,card_index,judge_name,fighter_a_id,fighter_a_score,fighter_b_score&bout_id=in.(${ids})`, []),
    rest<RoundRow[]>(`ufc_bout_round_stats?select=bout_id,round&bout_id=in.(${ids})`, []),
    cast.length
      ? rest<Array<{ fighter_a_id: string; fighter_b_id: string; event: { event_date: string | null } | Array<{ event_date: string | null }> | null }>>(
        `ufc_bouts?select=fighter_a_id,fighter_b_id,event:ufc_events(event_date)&or=(fighter_a_id.in.(${cast.join(",")}),fighter_b_id.in.(${cast.join(",")}))&limit=1000`, [])
      : Promise.resolve([]),
    coachIds.length === 2
      ? rest<Array<FinaleBoutRow & { event: { name: string; event_date: string } | Array<{ name: string; event_date: string }> }>>(
        `ufc_bouts?select=id,bout_order,weight_class_raw,is_title,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${F}),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${F}),result:ufc_bout_results(winner_id,method_raw,round,time_sec),event:ufc_events(name,event_date)&or=(and(fighter_a_id.eq.${coachIds[0]},fighter_b_id.eq.${coachIds[1]}),and(fighter_a_id.eq.${coachIds[1]},fighter_b_id.eq.${coachIds[0]}))`, [])
      : Promise.resolve([]),
  ]);
  const firstBoutDate = new Map<string, string>();
  for (const b of careers) {
    const d = one(b.event)?.event_date;
    if (!d) continue;
    for (const id of [b.fighter_a_id, b.fighter_b_id]) {
      if (!cast.includes(id)) continue;
      const prev = firstBoutDate.get(id);
      if (!prev || d < prev) firstBoutDate.set(id, d);
    }
  }
  /* The coaches' fight: a bout between the two head coaches within six months
   * after the finale. Seasons whose coaches never fought show none. */
  const limit = new Date(Date.parse(eventDate) + 183 * 86400e3).toISOString().slice(0, 10);
  const coach = coachBouts
    .map((b) => ({ row: { ...b, result: one(b.result) }, event: one(b.event)! }))
    .filter((x) => x.event?.event_date && x.event.event_date >= eventDate && x.event.event_date <= limit)
    .sort((x, y) => x.event.event_date.localeCompare(y.event.event_date))[0] ?? null;
  const finals = allBouts(season).filter((b) => b.stage === "final" && b.on_finale_card).map((b) => ({
    weight_class: b.weight_class,
    ufc_bout_id: b.ufc_bout_id ?? b.scheduled?.ufc_bout_id,
    ids: b.a_fighter_id && b.b_fighter_id ? ([b.a_fighter_id, b.b_fighter_id] as [string, string]) : undefined,
  }));
  return shapeFinale({
    event: { id: event.id, name: event.name, event_date: eventDate },
    bouts: rows, scorecards, rounds, finals, contestantIds: new Set(cast), firstBoutDate, coachFight: coach,
  });
}

export type LinkedFighter = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };

const IDENTITY = identityIndex as Record<string, Record<string, string>>;

/** The canonical fighter a printed name in one season resolved to, if any. */
export function fighterIdFor(slug: string, printed: string): string | null {
  return IDENTITY[slug]?.[printed] ?? null;
}

/**
 * Portraits for people named in the archive.
 *
 * Deliberately a re-read of the canonical fighter images rather than anything
 * TUF-specific: the same row, the same derivatives, the same rights trail that
 * a fighter profile uses. The archive owns no imagery of its own, so a
 * portrait can never drift between a season page and the profile it links to,
 * and there is exactly one place where a licence is recorded. The verified
 * resolver is the one used, because a season page is a high-visibility
 * surface: a display fallback is accepted only once its athlete identity
 * checks out.
 */
export async function portraitsFor(linked: Map<string, LinkedFighter>) {
  const ids = [...new Set([...linked.values()].map((f) => f.id))];
  if (!ids.length) return new Map<string, PortraitSet>();
  const byId = await getVerifiedDisplayImagesForFighters(ids);
  /* Keyed by the name the archive uses, so a page does not have to carry the
   * id around just to draw a face. */
  const byName = new Map<string, PortraitSet>();
  for (const [name, f] of linked) {
    const img = byId.get(f.id);
    if (img) byName.set(name, img);
  }
  return byName;
}

/**
 * Resolve the names one season prints to canonical fighter rows.
 *
 * By id, never by name. The ids were decided once, with their evidence, by
 * scripts/tuf/resolve_identity.mjs (web/data/tuf/identity.json), so an accent
 * no longer decides whether a champion links, and a name that did not resolve
 * stays a plain name rather than borrowing a namesake's profile. Nothing is
 * inserted.
 */
export async function linkSeasonNames(slug: string, names: string[]): Promise<Map<string, LinkedFighter>> {
  return linkNames(names.map((n) => [slug, n] as const));
}

/**
 * The same, for names drawn from several seasons at once. Keyed both by the
 * printed name and by `slug|name`; a caller mixing seasons should use the
 * latter, because two seasons can print one name for two people.
 */
export async function linkNames(pairs: ReadonlyArray<readonly [string, string]>): Promise<Map<string, LinkedFighter>> {
  const idByKey = new Map<string, string>();
  for (const [slug, name] of pairs) {
    const id = fighterIdFor(slug, name);
    if (id) idByKey.set(`${slug}|${name}`, id);
  }
  const ids = [...new Set(idByKey.values())];
  const out = new Map<string, LinkedFighter>();
  if (!ids.length) return out;
  const rows: LinkedFighter[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    rows.push(...(await rest<LinkedFighter[]>(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id&id=in.(${ids.slice(i, i + 150).join(",")})`, [])));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [key, id] of idByKey) {
    const f = byId.get(id);
    if (!f) continue;
    out.set(key, f);
    out.set(key.slice(key.indexOf("|") + 1), f);
  }
  return out;
}

export type TufRole = "coach" | "assistant_coach" | "guest_coach" | "contestant" | "champion";

/**
 * Every season a fighter appears in, and in what capacity.
 *
 * By canonical fighter id, against committed season data. An assistant coach
 * is recorded as one: Frank Mir on TUF 17 was Jon Jones's jiu-jitsu coach, and
 * a profile that called that "Coach" overstated the archive. Staff who were not
 * coaching are not listed on a fighter profile at all. A fighter with no TUF
 * history gets nothing, so other profiles are untouched.
 */
export function tufSeasonsForFighter(fighterId: string): Array<{
  season: SeasonRow;
  role: TufRole;
  team?: string;
  weight_class?: string;
  discipline?: string;
}> {
  const out: Array<{ season: SeasonRow; role: TufRole; team?: string; weight_class?: string; discipline?: string }> = [];
  if (!fighterId) return out;
  for (const row of INV.seasons) {
    const d = seasonBySlug(row.slug);
    const won = row.winners.find((w) => w.fighter_id === fighterId);
    if (won) out.push({ season: row, role: "champion", weight_class: won.weight_class });
    const staff = d?.coaches_full?.find((c) => c.fighter_id === fighterId);
    const head = (row.coach_fighter_ids ?? []).includes(fighterId) || staff?.role === "head";
    if (head) out.push({ season: row, role: "coach", team: staff?.team ?? undefined });
    else if (staff?.role === "assistant") out.push({ season: row, role: "assistant_coach", team: staff.team ?? undefined, discipline: staff.discipline });
    else if (staff?.role === "guest") out.push({ season: row, role: "guest_coach" });
    if (won) continue;
    const team = d?.teams?.find((t) => t.roster.some((r) => r.fighter_id === fighterId));
    const fought = d?.bracket ? allBouts(d).some((b) => b.a_fighter_id === fighterId || b.b_fighter_id === fighterId) : false;
    if (team || fought) out.push({ season: row, role: "contestant", team: team?.name });
  }
  return out;
}
