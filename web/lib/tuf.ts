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
import { getImagesForFighters, type PortraitSet } from "@/lib/db";
import inventory from "@/data/tuf/seasons.json";
import { TUF_DETAILS } from "@/data/tuf/details.generated";

/* Detail files are imported rather than read from disk so they are bundled
 * with the deployment. A season with no detail file yet renders from its
 * inventory row alone, which is the honest state for much of the archive.
 * The import map is generated from the directory by
 * scripts/tuf/build_details_index.mjs, so adding a season cannot silently
 * leave it unbundled and looking like missing data. */
const DETAILS: Record<string, unknown> = TUF_DETAILS;

export type Classification = "professional" | "exhibition" | "unverified";

export type Edition = { key: string; name: string; short: string; blurb: string };

export type SeasonWinner = { weight_class: string; fighter: string };

export type SeasonRow = {
  slug: string;
  edition: string;
  number: number;
  name: string;
  year: number;
  coaches: string[];
  coaches_note?: string;
  weight_classes: string[];
  winners: SeasonWinner[];
  finalists?: Array<{ weight_class: string; fighters: string[] }>;
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
  coaches_full?: Array<{ team: string; name: string; role: string; region?: string }>;
  teams?: Array<{ name: string; region?: string; roster: Array<{ name: string; country?: string; note?: string }> }>;
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
export function nonProfessionalAppearances(fighterName: string) {
  const hits: Array<{ season: SeasonRow; bout: TufBout & { stage: Stage["stage"]; weight_class: string } }> = [];
  for (const row of INV.seasons) {
    const d = seasonBySlug(row.slug);
    if (!d?.bracket) continue;
    for (const b of allBouts(d)) {
      if (countsTowardsRecord(b)) continue;
      if (b.a === fighterName || b.b === fighterName) hits.push({ season: row, bout: b });
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

/**
 * Portraits for people named in the archive.
 *
 * Deliberately a re-read of the canonical fighter images rather than anything
 * TUF-specific: the same row, the same derivatives, the same rights trail that
 * a fighter profile uses. The archive owns no imagery of its own, so a
 * portrait can never drift between a season page and the profile it links to,
 * and there is exactly one place where a licence is recorded.
 */
export async function portraitsFor(linked: Map<string, LinkedFighter>) {
  const ids = [...linked.values()].map((f) => f.id);
  if (!ids.length) return new Map<string, PortraitSet>();
  const byId = await getImagesForFighters(ids);
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
 * Resolve contestant and coach names to canonical fighter rows.
 *
 * Matching only — nothing is inserted, so a TUF contestant who never fought in
 * the UFC simply does not resolve and is shown as an unlinked name rather than
 * becoming a second, thinner profile beside a real one.
 */
export async function linkFighters(names: string[]): Promise<Map<string, LinkedFighter>> {
  const out = new Map<string, LinkedFighter>();
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return out;
  const list = unique.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
  const rows = await rest<LinkedFighter[]>(
    `ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id&name=in.(${encodeURIComponent(list)})&limit=200`,
    [],
  );
  for (const r of rows) out.set(r.name, r);
  return out;
}

/**
 * Every season a person appears in, as coach, contestant or tournament winner.
 *
 * Name matching only, against committed season data. A person who is not in
 * the archive gets nothing rather than an empty section, so profiles that have
 * no TUF history are untouched.
 */
export function tufSeasonsFor(name: string): Array<{
  season: SeasonRow;
  role: "coach" | "contestant" | "champion";
  team?: string;
  weight_class?: string;
}> {
  const out: Array<{ season: SeasonRow; role: "coach" | "contestant" | "champion"; team?: string; weight_class?: string }> = [];
  for (const row of INV.seasons) {
    const d = seasonBySlug(row.slug);
    const won = row.winners.find((w) => w.fighter === name);
    if (won) out.push({ season: row, role: "champion", weight_class: won.weight_class });
    if (row.coaches.includes(name) || d?.coaches_full?.some((c) => c.name === name)) {
      out.push({ season: row, role: "coach", team: d?.coaches_full?.find((c) => c.name === name)?.team });
    }
    const team = d?.teams?.find((t) => t.roster.some((r) => r.name === name));
    if (team && !won) out.push({ season: row, role: "contestant", team: team.name });
  }
  return out;
}
