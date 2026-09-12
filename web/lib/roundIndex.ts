import "server-only";

/* Discovery data for /round-by-round.
 *
 * The index only ever lists bouts that actually have round observations
 * stored. It does not list "fights we might have data for", because the whole
 * point of the surface is that everything on it can be opened and read. A
 * category with nothing behind it is omitted rather than shown empty.
 *
 * The index itself is one RPC (getRoundIndex). Event and fighter pages ask
 * only for the bouts on screen (getRoundCoverageFor).
 */
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export type RoundIndexBout = {
  boutId: string;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  fighterA: { id: string; name: string };
  fighterB: { id: string; name: string };
  weightClass: string | null;
  isWomens: boolean;
  isTitle: boolean;
  boutOrder: number | null;
  method: string | null;
  finishRound: number | null;
  winnerId: string | null;
  /* How many distinct rounds we hold observations for, and whether both
   * corners are present in every one of them. */
  roundsCovered: number;
  bothCorners: boolean;
  scheduledRounds: number | null;
};

type StatRow = { bout_id: string; fighter_id: string; round: number };

/* Paged reader for the per-card coverage lookup below (at most 60 bouts x 10
 * rows per chunk, inside one page). The index page no longer uses it. */
async function all<T>(path: string, pageSize = 1000, revalidate = 300): Promise<T[]> {
  if (!URL_ || !KEY) return [];
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    try {
      const res = await fetch(`${URL_}/rest/v1/${path}`, {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Accept: "application/json",
          Range: `${from}-${from + pageSize - 1}`,
        },
        next: { revalidate },
      });
      if (!res.ok) return out;
      const rows = (await res.json()) as T[];
      if (!Array.isArray(rows)) return out;
      out.push(...rows);
      if (rows.length < pageSize) break;
    } catch {
      return out;
    }
  }
  return out;
}

/* ---- the single eligibility definition ---------------------------------
 * Every surface that offers a round-by-round link asks this, and only this.
 * A second definition living next to a card component is how a link starts
 * appearing on fights that cannot open, so there is deliberately one rule and
 * one place to change it. */
export type RoundCoverage = { rounds: number; bothCorners: boolean };

export const ELIGIBLE_MIN_ROUNDS = 1;

export function isEligible(c: RoundCoverage | null | undefined): boolean {
  return Boolean(c && c.rounds >= ELIGIBLE_MIN_ROUNDS);
}

/* Coverage for a specific set of bouts. A fight card needs twelve rows, so
 * this asks only for what is on screen rather than for the full archive. */
export async function getRoundCoverageFor(
  boutIds: string[],
  /* Fight night passes a short TTL: during a card the whole point is to notice
   * a bout's rounds landing, and a five-minute cache would hide it for five
   * minutes. Every other caller keeps the default. */
  revalidate = 300,
): Promise<Map<string, RoundCoverage>> {
  const out = new Map<string, RoundCoverage>();
  const ids = [...new Set(boutIds.filter(Boolean))];
  if (!ids.length || !URL_ || !KEY) return out;

  const cover = new Map<string, Map<number, Set<string>>>();
  /* PostgREST puts the filter in the URL, so long id lists are chunked to stay
   * well inside any request-line limit. */
  const CHUNK = 60;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = await all<StatRow>(`ufc_bout_round_stats?select=bout_id,fighter_id,round&bout_id=in.(${slice.join(",")})`, 1000, revalidate);
    for (const r of rows) {
      let byRound = cover.get(r.bout_id);
      if (!byRound) { byRound = new Map(); cover.set(r.bout_id, byRound); }
      let corners = byRound.get(r.round);
      if (!corners) { corners = new Set(); byRound.set(r.round, corners); }
      corners.add(r.fighter_id);
    }
  }
  for (const [boutId, byRound] of cover) {
    out.set(boutId, { rounds: byRound.size, bothCorners: [...byRound.values()].every((c) => c.size >= 2) });
  }
  return out;
}

/* ---- the /round-by-round read model -------------------------------------
 * One RPC, ufc_round_index (supabase/migrations/20260910160000), returns the
 * whole page: totals and five shelves of twelve. It replaced a 67-request walk
 * of five tables (41k round rows alone) whose failed pages came back as a
 * shorter array, so a partial archive rendered as a complete smaller one.
 *
 * There is no partial state any more. The document either arrives whole and
 * passes the shape check below, or the page says the index is unavailable.
 * It never falls back to "no round data loaded", because that would be a
 * claim about the archive made on the strength of a failed read. */
export type RoundIndexTotals = {
  eligible: number;
  bothCorners: number;
  /* Observed length: how many distinct rounds hold data. NOT scheduled length. */
  byObservedRounds: Record<number, number>;
  firstEventDate: string | null;
  lastEventDate: string | null;
  scheduledFiveRound: number;
  fiveRoundsRecorded: number;
};

export type ShelfKey = "recent" | "scheduled_five_round" | "title" | "tournament" | "historic";
const SHELF_KEYS: ShelfKey[] = ["recent", "scheduled_five_round", "title", "tournament", "historic"];
const CONTRACT = "ufc_round_index/v1";

export type RoundIndex =
  | {
      status: "ok";
      generatedAt: string;
      freshness: { lastRoundCaptureAt: string | null; roundRows: number };
      totals: RoundIndexTotals;
      shelves: Record<ShelfKey, RoundIndexBout[]>;
    }
  | { status: "unavailable"; reason: string };

type RpcCard = {
  bout_id: string; event_id: string; event_name: string; event_date: string | null; bout_order: number | null;
  weight_class: string | null; is_womens: boolean; is_title: boolean; scheduled_rounds: number | null;
  method: string | null; finish_round: number | null; winner_id: string | null;
  rounds_covered: number; both_corners: boolean;
  fighter_a: { id: string; name: string }; fighter_b: { id: string; name: string };
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

function toBout(c: RpcCard): RoundIndexBout {
  return {
    boutId: c.bout_id,
    eventId: c.event_id,
    eventName: c.event_name,
    eventDate: c.event_date,
    fighterA: { id: c.fighter_a.id, name: c.fighter_a.name },
    fighterB: { id: c.fighter_b.id, name: c.fighter_b.name },
    weightClass: c.weight_class,
    isWomens: Boolean(c.is_womens),
    isTitle: Boolean(c.is_title),
    boutOrder: c.bout_order,
    method: c.method,
    finishRound: c.finish_round,
    winnerId: c.winner_id,
    roundsCovered: c.rounds_covered,
    bothCorners: Boolean(c.both_corners),
    scheduledRounds: c.scheduled_rounds,
  };
}

function isCard(c: unknown): c is RpcCard {
  const x = c as RpcCard;
  return Boolean(x && typeof x.bout_id === "string" && typeof x.event_name === "string"
    && x.fighter_a && typeof x.fighter_a.name === "string" && x.fighter_b && typeof x.fighter_b.name === "string"
    && Number.isFinite(x.rounds_covered));
}

/* The whole acceptance rule for a read-model document, exported for tests. */
export function parseRoundIndex(doc: unknown): RoundIndex {
  const d = doc as {
    contract?: string; generated_at?: string;
    freshness?: { last_round_capture_at?: string | null; round_rows?: number };
    totals?: Record<string, unknown>; shelves?: Record<string, unknown>;
  } | null;
  if (!d || d.contract !== CONTRACT) return { status: "unavailable", reason: `unexpected contract ${JSON.stringify(d?.contract ?? null)}` };
  const t = d.totals || {};
  const eligible = num(t.eligible), bothCorners = num(t.both_corners);
  const scheduledFiveRound = num(t.scheduled_five_round), fiveRoundsRecorded = num(t.five_rounds_recorded);
  if ([eligible, bothCorners, scheduledFiveRound, fiveRoundsRecorded].some(Number.isNaN)) return { status: "unavailable", reason: "totals incomplete" };
  const byObservedRounds: Record<number, number> = {};
  for (const [k, v] of Object.entries((t.by_observed_rounds as Record<string, unknown>) || {})) {
    if (Number.isNaN(num(v))) return { status: "unavailable", reason: "round distribution incomplete" };
    byObservedRounds[Number(k)] = num(v);
  }
  /* The distribution must account for every eligible bout, or something was dropped. */
  const distributed = Object.values(byObservedRounds).reduce((a, b) => a + b, 0);
  if (distributed !== eligible) return { status: "unavailable", reason: `distribution ${distributed} != eligible ${eligible}` };
  const shelves = {} as Record<ShelfKey, RoundIndexBout[]>;
  for (const k of SHELF_KEYS) {
    const raw = d.shelves?.[k];
    if (!Array.isArray(raw) || !raw.every(isCard)) return { status: "unavailable", reason: `shelf ${k} malformed` };
    shelves[k] = (raw as RpcCard[]).map(toBout);
  }
  return {
    status: "ok",
    generatedAt: String(d.generated_at || ""),
    freshness: { lastRoundCaptureAt: d.freshness?.last_round_capture_at ?? null, roundRows: num(d.freshness?.round_rows) },
    totals: {
      eligible, bothCorners, byObservedRounds, scheduledFiveRound, fiveRoundsRecorded,
      firstEventDate: (t.first_event_date as string) ?? null, lastEventDate: (t.last_event_date as string) ?? null,
    },
    shelves,
  };
}

export async function getRoundIndex(): Promise<RoundIndex> {
  if (!URL_ || !KEY) return { status: "unavailable", reason: "database not configured" };
  try {
    const res = await fetch(`${URL_}/rest/v1/rpc/ufc_round_index`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ shelf_size: 12 }),
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.error(`[roundIndex] rpc ufc_round_index -> HTTP ${res.status}`);
      return { status: "unavailable", reason: `HTTP ${res.status}` };
    }
    return parseRoundIndex(await res.json());
  } catch (e) {
    console.error(`[roundIndex] rpc ufc_round_index failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return { status: "unavailable", reason: "request failed" };
  }
}

/* ---- discovery sections -------------------------------------------------
 * Every section is defined by canonical data, never by editorial taste, so a
 * category cannot quietly become a list of fights someone liked. A section
 * with no members is dropped by the page rather than rendered empty. */

export type Section = { key: string; title: string; blurb: string; bouts: RoundIndexBout[] };

const SHELF_COPY: Record<ShelfKey, { title: string; blurb: string }> = {
  recent: { title: "Recent analysis", blurb: "The most recent completed bouts with verified round observations." },
  /* Scheduled length, not observed length. A five-round main event that ends
   * in the second round is still a five-round fight and belongs here. */
  scheduled_five_round: { title: "Five-round fights", blurb: "Bouts scheduled for five rounds, title fights and main events, whether they went the distance or ended early." },
  title: { title: "Championship fights", blurb: "Bouts the canonical record marks as title fights." },
  tournament: { title: "Tournament nights", blurb: "Same-night brackets, where a fighter has more than one bout on the card. Each bout keeps its own analysis." },
  historic: { title: "Historic fights", blurb: "The oldest bouts the archive can reconstruct, recovered from archived captures." },
};

/* Every shelf is defined by canonical data in the read model, never by
 * editorial taste. A shelf with no members is dropped rather than shown empty. */
export function buildSections(index: RoundIndex): Section[] {
  if (index.status !== "ok") return [];
  return SHELF_KEYS
    .map((key) => ({ key: key === "scheduled_five_round" ? "five-round" : key, ...SHELF_COPY[key], bouts: index.shelves[key] }))
    .filter((sec) => sec.bouts.length > 0);
}
