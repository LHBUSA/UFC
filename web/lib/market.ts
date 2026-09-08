import "server-only";

/* Market data read layer.
 *
 * This is a descriptive layer and nothing more. There is no production
 * prediction model, so nothing here computes an edge, a value, a win
 * probability or an expected return, and no wording in the UI it feeds may
 * imply one. What books are charging is a fact; what that is worth is not
 * something this product is currently in a position to say.
 *
 * Two definitions carry weight and are stated once, here.
 *
 * CONSENSUS is the median implied probability across books, converted back to
 * an American price. Median rather than mean because one book posting a stale
 * or extreme number should not drag the figure, and implied probability
 * rather than raw American odds because American odds are discontinuous
 * across the +100/-100 boundary and averaging them is arithmetically
 * meaningless. The vig is left in: this is the price you could actually get,
 * not a de-vigged fair estimate, and calling a de-vigged number "the market
 * price" would be a different claim than the one we can support.
 *
 * FIRST OBSERVED is the earliest price this system recorded. It is not the
 * opening line. We began watching partway through the market's life, so the
 * true opener is unknown, and the naming has to survive into the UI and any
 * future API rather than quietly becoming "open".
 */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export type MarketState =
  | "available"
  | "partial"
  | "not_posted"
  | "unresolved"
  | "unavailable"
  | "not_configured";

export const MARKET_STATE_COPY: Record<MarketState, { label: string; body: string }> = {
  available: { label: "Market available", body: "Prices from the books currently posting this bout." },
  partial: { label: "Market partial", body: "Only one corner is currently priced by the books we read." },
  not_posted: { label: "Market not yet posted", body: "No book we read has posted a price for this bout yet." },
  unresolved: {
    label: "Market not matched",
    body: "Books are pricing this bout, but the provider names it in a way we could not match to our records with certainty, so no price is shown. A price is never attached on a guess.",
  },
  unavailable: { label: "Market data unavailable", body: "No market observation could be sourced for this bout." },
  not_configured: { label: "Market data not configured", body: "The market provider is not connected in this environment. No prices are estimated in its absence." },
};

export function marketConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

/**
 * Has the market provider ever actually delivered?
 *
 * "No price for this bout" and "no provider connected" look identical from a
 * single empty query, and they are different facts a reader deserves to be
 * told apart. If the ingest has never written an observation, the honest
 * label is not-configured rather than not-yet-posted, which would imply we
 * are watching a market we are not watching at all.
 *
 * Cached for an hour: this changes once, when the provider is turned on.
 */
export async function marketProviderLive(): Promise<boolean> {
  if (!marketConfigured()) return false;
  try {
    const r = await fetch(`${URL_}/rest/v1/ufc_market_observations?select=id&limit=1`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json", Prefer: "count=exact" },
      next: { revalidate: 3600 },
    });
    if (!r.ok) return false;                    // table absent: provider never ran
    const total = Number((r.headers.get("content-range") || "/0").split("/")[1]);
    return Number.isFinite(total) && total > 0;
  } catch {
    return false;
  }
}

/* Bouts the provider is pricing but we could not attach a price to.
 *
 * This exists to stop one true sentence being used where a different true
 * sentence is meant. "No book has posted a price" and "books have posted a
 * price we could not match" are different facts with different fixes - the
 * first is waiting, the second is an alias someone has to add - and showing
 * the first for the second quietly hides our own failure behind the books'.
 *
 * The name comparison here decides WHICH SENTENCE TO SHOW and nothing else.
 * It never selects, attaches or displays a price, so it is allowed to be
 * approximate in a way ingest-time resolution is not. A false positive costs
 * a slightly wrong caption on a bout that has no odds either way.
 */
const normalise = (v: string | null | undefined) =>
  String(v || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function unresolvedBouts(
  bouts: Array<{ id: string; a: string; b: string }>,
  eventDate: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!marketConfigured() || !bouts.length || !eventDate) return out;

  const from = new Date(`${eventDate}T00:00:00Z`);
  const lo = new Date(from.getTime() - 2 * 86400000).toISOString();
  const hi = new Date(from.getTime() + 2 * 86400000).toISOString();
  const listedRows = await rows<{ home_team: string | null; away_team: string | null }>(
    `ufc_market_unmatched?select=home_team,away_team&resolved=is.false&commence_time=gte.${lo}&commence_time=lte.${hi}`,
  );
  if (!listedRows.length) return out;

  const listed = listedRows.map((r) => [normalise(r.home_team), normalise(r.away_team)] as const);
  for (const b of bouts) {
    const a = normalise(b.a);
    const c = normalise(b.b);
    /* Both corners must appear in the same unmatched event, for the same
     * reason bout matching requires both: one surname in common is a
     * coincidence, two names in one bout is the bout. */
    const hit = listed.some(([h, w]) => {
      const pair = `${h} ${w}`;
      const has = (n: string) => Boolean(n) && (pair.includes(n) || n.split(" ").every((t) => t.length > 2 && pair.includes(t)));
      return has(a) && has(c);
    });
    if (hit) out.add(b.id);
  }
  return out;
}

export type Observation = {
  bout_id: string;
  bookmaker_key: string;
  bookmaker_name: string | null;
  market_key: string;
  outcome_name: string;
  outcome_fighter_id: string | null;
  price: number;
  point: number | null;
  source_last_update: string | null;
  observed_at: string;
};

/* ---- price maths --------------------------------------------------------
 * American odds to implied probability, including the vig. */
export function impliedProbability(american: number): number {
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

export function probabilityToAmerican(p: number): number {
  if (!(p > 0 && p < 1)) return 0;
  /* Strictly greater, so an exactly even market converts to +100 rather than
   * -100. Both mean the same wager, but +100 is how books write it, and this
   * is also what makes the conversion round-trip with impliedProbability. */
  return p > 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

export const formatAmerican = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? (v > 0 ? `+${v}` : String(v)) : "—";

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type SidePrices = {
  fighterId: string;
  /* Median implied probability across books, expressed back as a price. */
  consensus: number | null;
  /* Best available is the price most favourable to the bettor, which is the
   * highest American number on either side of zero once compared as a payout,
   * so it is chosen by lowest implied probability rather than by raw value. */
  best: number | null;
  worst: number | null;
  bookCount: number;
  books: Array<{ key: string; name: string | null; price: number }>;
  /* Distinct ingest runs behind this side. Movement needs at least two. */
  runCount: number;
  firstObserved: { price: number; at: string } | null;
  previous: { price: number; at: string } | null;
  latest: { price: number; at: string } | null;
};

/**
 * How old an observation may be before the page stops presenting it as the
 * current market.
 *
 * The ingest is deliberately low-cadence: the provider bills per call against
 * a monthly allowance, and this product polls nothing. At three runs a day
 * the widest legitimate gap between observations is eight hours, so twelve
 * gives a missed run room to be late without being wrong. Past that, a run
 * has actually been skipped, and a price we have not rechecked since
 * yesterday is not "the current market" no matter how real it was when we
 * recorded it.
 *
 * The prices are still shown. They were genuinely observed and hiding them
 * would be its own dishonesty; what changes is that the page says how old
 * they are instead of implying they are live.
 */
export const STALE_AFTER_MINUTES = 12 * 60;

export type BoutMarket = {
  boutId: string;
  state: MarketState;
  marketKey: string;
  a: SidePrices | null;
  b: SidePrices | null;
  /* When THIS SYSTEM last recorded a price. Not when a book last moved one. */
  lastUpdated: string | null;
  /* The newest last_update the books themselves reported, which is a
   * different fact and is labelled differently in the UI. A book that has not
   * repriced in a day is normal; an ingest that has not run in a day is not. */
  sourceLastUpdate: string | null;
  /* Older than STALE_AFTER_MINUTES: real prices, presented as history. */
  stale: boolean;
  ageMinutes: number | null;
  bookCount: number;
};

/** Whole minutes since an ISO timestamp, or null if it is unusable. */
export function ageInMinutes(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

/** Whether an observation is too old to be presented as the current market. */
export function isStale(observedAt: string | null | undefined, now = Date.now()): boolean {
  const age = ageInMinutes(observedAt, now);
  return age !== null && age > STALE_AFTER_MINUTES;
}

/** "14 minutes ago", "3 hours ago", "2 days ago" - no library, no drift. */
export function describeAge(minutes: number | null): string {
  if (minutes === null) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const h = Math.round(minutes / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/* One ingest writes every book's price in a single transaction, so all of its
 * rows share an observed_at. Bucketing by the minute therefore groups a run
 * with itself and never with another: an ingest completes in seconds and runs
 * are hours apart. */
const RUN_BUCKET_MS = 60_000;
const runKey = (iso: string) => Math.floor(new Date(iso).getTime() / RUN_BUCKET_MS);

/** Consensus across books within one run: median implied probability. */
function consensusOf(rows: Observation[]): number | null {
  const byBook = new Map<string, Observation>();
  for (const o of rows) {
    const cur = byBook.get(o.bookmaker_key);
    if (!cur || o.observed_at > cur.observed_at) byBook.set(o.bookmaker_key, o);
  }
  const med = median([...byBook.values()].map((o) => impliedProbability(o.price)));
  return med === null ? null : probabilityToAmerican(med);
}

/* Exported as a test seam. The run-bucketing rules it encodes - which books
 * count as current, and what may be compared against what - are the ones most
 * likely to go quietly wrong, and they are unreachable through getMarketsFor
 * without a live database. */
export function sideFrom(obs: Observation[], fighterId: string): SidePrices | null {
  const mine = obs.filter((o) => o.outcome_fighter_id === fighterId);
  if (!mine.length) return null;

  /* Runs, oldest first. Movement is a comparison BETWEEN runs and never
   * within one: the prices inside a single run differ because books disagree
   * with each other, not because a line moved, and reading that spread as
   * chronology invents a move out of a snapshot. This is the whole reason
   * first/latest are computed per run rather than per row. */
  const runs = new Map<number, Observation[]>();
  for (const o of mine) {
    const k = runKey(o.observed_at);
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k)!.push(o);
  }
  const ordered = [...runs.entries()].sort((a, b) => a[0] - b[0]).map(([, rows]) => rows);

  /* The current market is the most recent run only. A book absent from it is
   * not pricing this bout now, and carrying its older number forward would
   * quietly pad the book count with prices nobody is offering. */
  const currentRun = ordered[ordered.length - 1] || [];
  const byBook = new Map<string, Observation>();
  for (const o of currentRun) {
    const cur = byBook.get(o.bookmaker_key);
    if (!cur || o.observed_at > cur.observed_at) byBook.set(o.bookmaker_key, o);
  }
  const current = [...byBook.values()];
  const byFavourability = [...current].sort((x, y) => impliedProbability(x.price) - impliedProbability(y.price));

  const at = (rows: Observation[]) => rows.reduce((acc, o) => (o.observed_at > acc ? o.observed_at : acc), rows[0].observed_at);
  const stamp = (rows: Observation[] | undefined) => {
    if (!rows?.length) return null;
    const price = consensusOf(rows);
    return price === null ? null : { price, at: at(rows) };
  };

  const firstObserved = stamp(ordered[0]);
  const latest = stamp(currentRun);
  /* The most recent earlier run whose consensus actually differs, so a
   * repeated read at an unchanged price does not present as a move. */
  let previous: { price: number; at: string } | null = null;
  for (let i = ordered.length - 2; i >= 0; i--) {
    const s = stamp(ordered[i]);
    if (s && latest && s.price !== latest.price) { previous = s; break; }
  }

  return {
    fighterId,
    consensus: latest?.price ?? null,
    /* Best available is the price most favourable to the bettor, which is the
     * highest American number on either side of zero once compared as a payout,
     * so it is chosen by lowest implied probability rather than by raw value. */
    best: byFavourability[0]?.price ?? null,
    worst: byFavourability[byFavourability.length - 1]?.price ?? null,
    bookCount: current.length,
    books: byFavourability.map((o) => ({ key: o.bookmaker_key, name: o.bookmaker_name, price: o.price })),
    /* How many times we have looked. One look is a snapshot, not a history,
     * and nothing may be said about movement from it. */
    runCount: ordered.length,
    firstObserved,
    previous,
    latest,
  };
}

export type Movement = { direction: "toward" | "away" | "unchanged"; delta: number; from: number; to: number } | null;

/**
 * Movement of a side's price between two observations.
 *
 * "Toward" means the price shortened, i.e. the implied probability rose. It
 * is deliberately phrased as movement toward or away from a fighter and never
 * as sharp money, steam or public action, because those are claims about who
 * is betting and we have no source that supports them.
 *
 * Both endpoints are CONSENSUS figures from different runs, so this compares
 * like with like. Comparing individual rows would compare one book to another
 * and call the disagreement a move.
 */
export function movement(side: SidePrices | null, basis: "first" | "previous" = "first"): Movement {
  if (!side?.latest) return null;
  /* A single run is a snapshot. The spread inside it is books disagreeing
   * with each other, not a line moving, and there is no earlier reading to
   * compare against - so there is nothing truthful to say and we say nothing.
   * This is the first-ingest case, and it must stay silent rather than
   * reporting "unchanged", which would claim we had watched and seen no move. */
  if (side.runCount < 2) return null;
  const start = basis === "first" ? side.firstObserved : side.previous;
  if (!start) return null;
  const delta = side.latest.price - start.price;
  if (delta === 0) return { direction: "unchanged", delta: 0, from: start.price, to: side.latest.price };
  const shortened = impliedProbability(side.latest.price) > impliedProbability(start.price);
  return { direction: shortened ? "toward" : "away", delta, from: start.price, to: side.latest.price };
}

/* ---- reads --------------------------------------------------------------- */

async function rows<T>(q: string): Promise<T[]> {
  if (!marketConfigured()) return [];
  try {
    const r = await fetch(`${URL_}/rest/v1/${q}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? (j as T[]) : [];
  } catch {
    return [];
  }
}

const SELECT = "bout_id,bookmaker_key,bookmaker_name,market_key,outcome_name,outcome_fighter_id,price,point,source_last_update,observed_at";

/**
 * Markets for a set of bouts. Returns a map so a caller renders only what
 * exists; a bout with no observations is simply absent rather than present
 * with empty prices, which is what keeps "not yet posted" honest.
 */
export async function getMarketsFor(
  boutIds: string[],
  fighters: Map<string, { a: string; b: string }>,
  marketKey = "h2h",
): Promise<Map<string, BoutMarket>> {
  const out = new Map<string, BoutMarket>();
  const ids = [...new Set(boutIds.filter(Boolean))];
  if (!ids.length) return out;
  if (!marketConfigured()) return out;

  const obs: Observation[] = [];
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    obs.push(...(await rows<Observation>(
      `ufc_market_observations?select=${SELECT}&market_key=eq.${encodeURIComponent(marketKey)}&bout_id=in.(${slice.join(",")})&order=observed_at.asc&limit=20000`,
    )));
  }

  const byBout = new Map<string, Observation[]>();
  for (const o of obs) {
    if (!byBout.has(o.bout_id)) byBout.set(o.bout_id, []);
    byBout.get(o.bout_id)!.push(o);
  }

  for (const id of ids) {
    const list = byBout.get(id);
    const corners = fighters.get(id);
    if (!list?.length || !corners) continue;
    const a = sideFrom(list, corners.a);
    const b = sideFrom(list, corners.b);
    if (!a && !b) continue;
    const books = new Set(list.map((o) => o.bookmaker_key));
    const lastUpdated = list.reduce<string | null>((acc, o) => (!acc || o.observed_at > acc ? o.observed_at : acc), null);
    const sourceLastUpdate = list.reduce<string | null>(
      (acc, o) => (o.source_last_update && (!acc || o.source_last_update > acc) ? o.source_last_update : acc),
      null,
    );
    const ageMinutes = ageInMinutes(lastUpdated);
    const stale = isStale(lastUpdated);
    out.set(id, {
      boutId: id,
      /* Both corners priced is a usable market. One corner is partial and is
       * labelled as such rather than shown as if it were complete. */
      state: a && b ? "available" : "partial",
      marketKey,
      a, b, lastUpdated, sourceLastUpdate,
      /* Staleness describes the observation, not the bout: the prices below
       * are still the real last-known ones and are shown either way. */
      stale,
      ageMinutes,
      bookCount: books.size,
    });
  }
  return out;
}

/**
 * The state to render for a bout, given whatever the lookup returned.
 * Separated from the data so a page never has to invent its own vocabulary.
 */
export function marketStateFor(
  market: BoutMarket | undefined,
  opts: { eventDate: string | null; hasResult: boolean; providerLive?: boolean; unresolved?: boolean },
): MarketState {
  if (!marketConfigured()) return "not_configured";
  /* Nothing has ever been ingested, so this is not a bout without a price, it
   * is a product without a market feed. Say the latter. */
  if (opts.providerLive === false) return "not_configured";
  if (market) return market.state;
  if (opts.hasResult) return "unavailable";
  if (opts.eventDate && new Date(`${opts.eventDate}T00:00:00Z`).getTime() < Date.now()) return "unavailable";
  /* Checked before not-posted, because a bout the books ARE pricing must
   * never be described as one nobody has priced. Our failure to match is
   * ours to admit, not something to attribute to the books. */
  if (opts.unresolved) return "unresolved";
  return "not_posted";
}

/* The consensus method, in one sentence, for display next to the number. */
export const CONSENSUS_NOTE =
  "Consensus is the median implied probability across the books we read, converted back to an American price. The vig is left in, so this is a price you could take rather than a de-vigged estimate.";

export const FIRST_OBSERVED_NOTE =
  "First observed is the earliest price this system recorded for the bout. It is not the opening line: we start watching partway through a market's life, so the true opener is unknown.";
