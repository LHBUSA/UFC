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
import inventory from "@/data/tuf/seasons.json";
import tuf22 from "@/data/tuf/seasons/tuf-22.json";

/* Detail files are imported rather than read from disk so they are bundled
 * with the deployment. A season with no detail file yet renders from its
 * inventory row alone, which is the honest state for most of the archive. */
const DETAILS: Record<string, unknown> = { "tuf-22": tuf22 };

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
  /** OUR coverage, not the season's: complete | partial | missing. */
  status: "complete" | "partial" | "missing";
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
  classification_basis?: string;
  replacement?: string;
  on_finale_card?: boolean;
  tournament_deciding?: boolean;
};

export type Stage = {
  stage: "elimination" | "quarter_final" | "semi_final" | "final";
  label: string;
  status?: "unverified";
  note?: string;
  bouts: TufBout[];
};

export type SeasonDetail = SeasonRow & {
  _provenance?: { primary: string; retrieved: string; note?: string };
  _conflicts?: Array<{ field: string; detail: string; retrieved?: string }>;
  classification_policy?: { in_house: string; finale: string; rationale: string };
  coaches_full?: Array<{ team: string; name: string; role: string; region?: string }>;
  teams?: Array<{ name: string; region?: string; roster: Array<{ name: string; country?: string; note?: string }> }>;
  bracket?: Array<{ weight_class: string; stages: Stage[] }>;
  finale?: { event_name: string; event_date: string; venue?: string; link_policy?: string };
  champions?: Array<{
    weight_class: string;
    fighter: string;
    won_tournament: boolean;
    received_contract: boolean;
    contract_note?: string;
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

export type Coverage = {
  seasons: number;
  complete: number;
  partial: number;
  missing: number;
  ongoing: number;
  byEdition: Array<{ edition: Edition; total: number; complete: number; partial: number; missing: number }>;
};

export function coverage(): Coverage {
  const all = seasons();
  const count = (rows: SeasonRow[], s: SeasonRow["status"]) => rows.filter((r) => r.status === s).length;
  return {
    seasons: all.length,
    complete: count(all, "complete"),
    partial: count(all, "partial"),
    missing: count(all, "missing"),
    ongoing: all.filter((r) => r.ongoing).length,
    byEdition: INV.editions.map((edition) => {
      const rows = all.filter((r) => r.edition === edition.key);
      return {
        edition,
        total: rows.length,
        complete: count(rows, "complete"),
        partial: count(rows, "partial"),
        missing: count(rows, "missing"),
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
export function countsTowardsRecord(b: Pick<TufBout, "classification">): boolean {
  return b.classification === "professional";
}

/** Every bout of a season, flattened, in bracket order. */
export function allBouts(season: SeasonDetail): Array<TufBout & { stage: Stage["stage"]; weight_class: string }> {
  const out: Array<TufBout & { stage: Stage["stage"]; weight_class: string }> = [];
  for (const wc of season.bracket ?? []) {
    for (const st of wc.stages) {
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
