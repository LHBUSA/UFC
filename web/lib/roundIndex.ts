import "server-only";

/* Discovery data for /round-by-round.
 *
 * The index only ever lists bouts that actually have round observations
 * stored. It does not list "fights we might have data for", because the whole
 * point of the surface is that everything on it can be opened and read. A
 * category with nothing behind it is omitted rather than shown empty.
 *
 * READ ARCHITECTURE. The page used to download five whole tables (about 67
 * PostgREST pages at the 1,000-row cap) and join them in memory, and its pager
 * returned whatever prefix it had when a page failed — a partial archive
 * rendered as the whole one. The database now does that work:
 *
 *   rpc/ufc_round_index_page   one call, one jsonb value: totals, provenance
 *                              and five shelves of <= 12. A single value has
 *                              no row cap to truncate, and the call either
 *                              returns all of it or fails.
 *   ufc_round_index            one row per eligible bout; round-link coverage
 *                              for a page's own bouts, <= 60 ids per request.
 *
 * Every response is validated. Anything short of the full contract is a
 * RoundIndexUnavailable error, never a smaller archive.
 */
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export class RoundIndexUnavailable extends Error {
  constructor(detail: string) { super(`round index unavailable: ${detail}`); this.name = "RoundIndexUnavailable"; }
}

export function roundIndexConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export type RoundIndexBout = {
  boutId: string;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  fighterA: { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
  fighterB: { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
  weightClass: string | null;
  isWomens: boolean;
  isTitle: boolean;
  boutOrder: number | null;
  method: string | null;
  finishRound: number | null;
  winnerId: string | null;
  /* How many distinct rounds we hold observations for (rounds actually fought,
   * as far as the source recorded them), and whether both corners are present
   * in every one of them. Not the scheduled distance: that is scheduledRounds. */
  roundsCovered: number;
  bothCorners: boolean;
  scheduledRounds: number | null;
  isTournament: boolean;
};

/* ---- the single eligibility definition ---------------------------------
 * Every surface that offers a round-by-round link asks this, and only this.
 * A second definition living next to a card component is how a link starts
 * appearing on fights that cannot open, so there is deliberately one rule and
 * one place to change it. The database view applies the same rule. */
export type RoundCoverage = { rounds: number; bothCorners: boolean };

export const ELIGIBLE_MIN_ROUNDS = 1;

export function isEligible(c: RoundCoverage | null | undefined): boolean {
  return Boolean(c && c.rounds >= ELIGIBLE_MIN_ROUNDS);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Coverage for a specific set of bouts (an event card, a fighter's history).
 * Reads the view for only the ids on screen: <= 60 per request, one row per
 * bout, so a response can never be silently cut by the row cap. A request that
 * fails leaves those bouts with NO coverage entry — callers render no link,
 * which is the safe direction — and never a guessed one. */
export async function getRoundCoverageFor(boutIds: string[]): Promise<Map<string, RoundCoverage>> {
  const out = new Map<string, RoundCoverage>();
  const ids = [...new Set(boutIds.filter((x) => UUID.test(String(x || ""))))];
  if (!ids.length || !roundIndexConfigured()) return out;
  const CHUNK = 60;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${URL_}/rest/v1/ufc_round_index?select=bout_id,rounds_observed,both_corners&bout_id=in.(${slice.join(",")})`, {
        headers: headers(), next: { revalidate: 300 },
      });
      if (!res.ok) { console.error(`[roundIndex] coverage -> HTTP ${res.status}`); continue; }
      const rows = (await res.json()) as Array<{ bout_id: string; rounds_observed: number; both_corners: boolean }>;
      if (!Array.isArray(rows) || rows.length > slice.length) { console.error("[roundIndex] coverage response malformed"); continue; }
      for (const r of rows) out.set(r.bout_id, { rounds: r.rounds_observed, bothCorners: Boolean(r.both_corners) });
    } catch (e) {
      console.error(`[roundIndex] coverage failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    }
  }
  return out;
}

export type RoundIndexTotals = {
  eligible: number;
  bothCorners: number;
  /* keyed by rounds OBSERVED */
  byRoundsObserved: Record<number, number>;
  /* keyed by SCHEDULED distance; "unknown" when the record does not say */
  byScheduledRounds: Record<string, number>;
  scheduledFiveRound: number;
};

export type RoundIndexProvenance = {
  generatedAt: string;
  roundRows: number;
  lastCapturedAt: string | null;
  source: string;
  requests: number;
};

export type Section = { key: string; title: string; blurb: string; bouts: RoundIndexBout[] };

export type RoundIndex = {
  totals: RoundIndexTotals;
  provenance: RoundIndexProvenance;
  sections: Section[];
  /* every bout on any shelf, de-duplicated, for structured data */
  bouts: RoundIndexBout[];
};

/* Shelf definitions. Membership is decided by canonical data in the database
 * function, never by editorial taste; this table only names and explains. */
const SHELVES: Array<{ key: string; title: string; blurb: string }> = [
  { key: "recent", title: "Recent analysis", blurb: "The most recent completed bouts with verified round observations." },
  { key: "five-round", title: "Five-round fights", blurb: "Bouts scheduled for five rounds, championship and main-event distance, however long they actually lasted." },
  { key: "title", title: "Championship fights", blurb: "Bouts the canonical record marks as title fights." },
  { key: "tournament", title: "Tournament nights", blurb: "Same-night brackets, where a fighter has more than one bout on the card. Each bout keeps its own analysis." },
  { key: "historic", title: "Historic fights", blurb: "The oldest bouts the archive can reconstruct, recovered from archived captures." },
];
const SHELF_MAX = 12;

type RawBout = {
  bout_id: string; event_id: string; event_name: string; event_date: string | null;
  fighter_a_id: string; fighter_a_name: string; fighter_a_espn_athlete_id: string | null; fighter_a_ufcstats_id: string | null;
  fighter_b_id: string; fighter_b_name: string; fighter_b_espn_athlete_id: string | null; fighter_b_ufcstats_id: string | null;
  weight_class: string | null; is_womens: boolean; is_title: boolean; bout_order: number | null; scheduled_rounds: number | null;
  method: string | null; finish_round: number | null; winner_id: string | null;
  rounds_observed: number; both_corners: boolean; is_tournament: boolean;
};
type RawPage = {
  contract: string; generated_at: string;
  totals: { eligible: number; both_corners: number; by_rounds_observed: Record<string, number>; by_scheduled_rounds: Record<string, number>; scheduled_five_round: number };
  provenance: { round_rows: number; last_captured_at: string | null; source: string };
  shelves: Record<string, RawBout[]>;
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function toBout(r: RawBout): RoundIndexBout {
  return {
    boutId: r.bout_id, eventId: r.event_id, eventName: r.event_name, eventDate: r.event_date,
    fighterA: { id: r.fighter_a_id, name: r.fighter_a_name, espn_athlete_id: r.fighter_a_espn_athlete_id, ufcstats_id: r.fighter_a_ufcstats_id },
    fighterB: { id: r.fighter_b_id, name: r.fighter_b_name, espn_athlete_id: r.fighter_b_espn_athlete_id, ufcstats_id: r.fighter_b_ufcstats_id },
    weightClass: r.weight_class, isWomens: Boolean(r.is_womens), isTitle: Boolean(r.is_title), boutOrder: r.bout_order,
    method: r.method, finishRound: r.finish_round, winnerId: r.winner_id,
    roundsCovered: r.rounds_observed, bothCorners: Boolean(r.both_corners), scheduledRounds: r.scheduled_rounds,
    isTournament: Boolean(r.is_tournament),
  };
}

/* Strict contract check. The page is allowed to be unavailable; it is not
 * allowed to be quietly incomplete. Exported for tests. */
export function parseRoundIndexPage(raw: unknown): RoundIndex {
  const p = raw as RawPage;
  if (!p || typeof p !== "object") throw new RoundIndexUnavailable("empty payload");
  if (p.contract !== "ufc_round_index_page.v1") throw new RoundIndexUnavailable(`unexpected contract ${JSON.stringify(p.contract)}`);
  const t = p.totals;
  if (!t || !isInt(t.eligible) || !isInt(t.both_corners) || !isInt(t.scheduled_five_round) || typeof t.by_rounds_observed !== "object" || typeof t.by_scheduled_rounds !== "object") {
    throw new RoundIndexUnavailable("totals missing or malformed");
  }
  const observedSum = Object.values(t.by_rounds_observed).reduce((a, b) => a + (isInt(b) ? b : NaN), 0);
  const scheduledSum = Object.values(t.by_scheduled_rounds).reduce((a, b) => a + (isInt(b) ? b : NaN), 0);
  if (observedSum !== t.eligible || scheduledSum !== t.eligible) throw new RoundIndexUnavailable(`distribution sums ${observedSum}/${scheduledSum} != eligible ${t.eligible}`);
  if (t.both_corners > t.eligible) throw new RoundIndexUnavailable("both_corners exceeds eligible");
  if (!p.provenance || !isInt(p.provenance.round_rows)) throw new RoundIndexUnavailable("provenance missing");
  if (!p.shelves || typeof p.shelves !== "object") throw new RoundIndexUnavailable("shelves missing");

  const sections: Section[] = [];
  const all = new Map<string, RoundIndexBout>();
  for (const def of SHELVES) {
    const rows = p.shelves[def.key] ?? [];
    if (!Array.isArray(rows) || rows.length > SHELF_MAX) throw new RoundIndexUnavailable(`shelf ${def.key} malformed`);
    const bouts = rows.map((r) => {
      if (!r || !UUID.test(r.bout_id) || !r.event_name || !r.fighter_a_name || !r.fighter_b_name || !isInt(r.rounds_observed) || r.rounds_observed < ELIGIBLE_MIN_ROUNDS) {
        throw new RoundIndexUnavailable(`shelf ${def.key} carries an incomplete bout`);
      }
      if (def.key === "five-round" && r.scheduled_rounds !== 5) throw new RoundIndexUnavailable("five-round shelf holds a bout not scheduled for five");
      return toBout(r);
    });
    /* A shelf can only be empty if nothing qualifies; an empty "recent" shelf
     * with a non-empty archive is a broken response, not a quiet week. */
    if (def.key === "recent" && t.eligible > 0 && bouts.length !== Math.min(SHELF_MAX, t.eligible)) throw new RoundIndexUnavailable("recent shelf short");
    if (def.key === "five-round" && bouts.length !== Math.min(SHELF_MAX, t.scheduled_five_round)) throw new RoundIndexUnavailable("five-round shelf short");
    for (const b of bouts) all.set(b.boutId, b);
    if (bouts.length) sections.push({ ...def, bouts });
  }

  const byRoundsObserved: Record<number, number> = {};
  for (const [k, v] of Object.entries(t.by_rounds_observed)) byRoundsObserved[Number(k)] = v;
  return {
    totals: { eligible: t.eligible, bothCorners: t.both_corners, byRoundsObserved, byScheduledRounds: { ...t.by_scheduled_rounds }, scheduledFiveRound: t.scheduled_five_round },
    provenance: { generatedAt: p.generated_at, roundRows: p.provenance.round_rows, lastCapturedAt: p.provenance.last_captured_at, source: p.provenance.source, requests: 1 },
    sections,
    bouts: [...all.values()],
  };
}

/* One request. Throws RoundIndexUnavailable on any failure, so the caller can
 * never render a partial archive. */
export async function getRoundIndex(): Promise<RoundIndex> {
  if (!roundIndexConfigured()) throw new RoundIndexUnavailable("database not configured");
  let res: Response;
  try {
    res = await fetch(`${URL_}/rest/v1/rpc/ufc_round_index_page`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: "{}",
      next: { revalidate: 300 },
    });
  } catch (e) {
    throw new RoundIndexUnavailable(`transport: ${String((e as Error)?.message || e).slice(0, 120)}`);
  }
  if (!res.ok) throw new RoundIndexUnavailable(`HTTP ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new RoundIndexUnavailable("response is not JSON"); }
  return parseRoundIndexPage(body);
}
