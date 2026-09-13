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
export type Episode = {
  episode_number: number;
  title: string | null;
  title_source: "paramount_plus" | null;
  /** Always null: no source states a broadcast date. */
  air_date: null;
  /** The Paramount+ listing's own date. Not a broadcast date. */
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
  finale_broadcast?: { title: string; listing_date: string | null };
  missing_recaps?: Array<{ episode_number: number; why: string }>;
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
  /** One entry per weight class. A list, not a single card, because a
   * season's divisions have been decided on different nights. */
  final_bouts?: Array<{
    weight_class: string; a: string; b: string; winner?: string;
    method?: string | null; round?: number | null;
    event: string; date: string; verified_against?: string;
  }>;
  /** A link we withdrew or could not establish, with what blocks it. Kept so
   * the gap is actionable rather than invisible. */
  unresolved_finale?: { withdrawn_match?: string; why_wrong?: string; candidate_card?: string; blocker: string };
  /** OUR coverage of the tournament. Three mutually exclusive buckets, so
   * every season is in exactly one and they sum to the season count. A finale
   * card we happen to hold is NOT coverage and is tracked separately. */
  coverage: Coverage;
  /** A fact about the season, not about us. */
  season_state: "completed" | "ongoing";
  detail?: string;
};

/* format_complete is not a weaker bracket_full. It is for a season with no
 * bracket to load — season 21 was a scored series between two gyms — where
 * filing it as "partial" would count the absence of a structure it never had
 * as data we are missing. */
export type Coverage = "bracket_full" | "bracket_partial" | "metadata_only" | "format_complete";

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
  sources?: FieldSource[];
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

/* ---- coverage ----------------------------------------------------------- */

export type CoverageReport = {
  seasons: number;
  /* Mutually exclusive; these three sum to `seasons`. */
  bracket_full: number;
  bracket_partial: number;
  metadata_only: number;
  /* Separate axes. Neither is coverage. */
  completed: number;
  ongoing: number;
  finales_named: number;
  byEdition: Array<{ edition: Edition; total: number; bracket_full: number; bracket_partial: number; metadata_only: number }>;
};

export function coverage(): CoverageReport {
  const all = seasons();
  const n = (rows: SeasonRow[], c: Coverage) => rows.filter((r) => r.coverage === c).length;
  return {
    seasons: all.length,
    bracket_full: n(all, "bracket_full"),
    bracket_partial: n(all, "bracket_partial"),
    metadata_only: n(all, "metadata_only"),
    completed: all.filter((r) => r.season_state === "completed").length,
    ongoing: all.filter((r) => r.season_state === "ongoing").length,
    finales_named: all.filter((r) => r.finale_event).length,
    byEdition: INV.editions.map((edition) => {
      const rows = all.filter((r) => r.edition === edition.key);
      return {
        edition,
        total: rows.length,
        bracket_full: n(rows, "bracket_full"),
        bracket_partial: n(rows, "bracket_partial"),
        metadata_only: n(rows, "metadata_only"),
      };
    }),
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
