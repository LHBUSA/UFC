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
  | "unavailable"
  | "not_configured";

export const MARKET_STATE_COPY: Record<MarketState, { label: string; body: string }> = {
  available: { label: "Market available", body: "Prices from the books currently posting this bout." },
  partial: { label: "Market partial", body: "Only one corner is currently priced by the books we read." },
  not_posted: { label: "Market not yet posted", body: "No book we read has posted a price for this bout yet." },
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
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
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
  firstObserved: { price: number; at: string } | null;
  previous: { price: number; at: string } | null;
  latest: { price: number; at: string } | null;
};

export type BoutMarket = {
  boutId: string;
  state: MarketState;
  marketKey: string;
  a: SidePrices | null;
  b: SidePrices | null;
  lastUpdated: string | null;
  bookCount: number;
};

function sideFrom(obs: Observation[], fighterId: string): SidePrices | null {
  const mine = obs.filter((o) => o.outcome_fighter_id === fighterId);
  if (!mine.length) return null;

  /* Latest observation per book is the current market. */
  const byBook = new Map<string, Observation>();
  for (const o of mine) {
    const cur = byBook.get(o.bookmaker_key);
    if (!cur || new Date(o.observed_at) > new Date(cur.observed_at)) byBook.set(o.bookmaker_key, o);
  }
  const current = [...byBook.values()];
  const probs = current.map((o) => impliedProbability(o.price));
  const med = median(probs);

  const byFavourability = [...current].sort((x, y) => impliedProbability(x.price) - impliedProbability(y.price));

  /* Chronology for movement. Sorted oldest first across all books, because
   * "first observed" is a property of this system's watching, not of a book. */
  const chrono = [...mine].sort((x, y) => new Date(x.observed_at).getTime() - new Date(y.observed_at).getTime());
  const first = chrono[0] || null;
  const last = chrono[chrono.length - 1] || null;
  /* The previous distinct price, so an unchanged re-read does not read as a move. */
  const prior = [...chrono].reverse().find((o) => last && o.price !== last.price) || null;

  return {
    fighterId,
    consensus: med === null ? null : probabilityToAmerican(med),
    best: byFavourability[0]?.price ?? null,
    worst: byFavourability[byFavourability.length - 1]?.price ?? null,
    bookCount: current.length,
    books: current
      .sort((x, y) => impliedProbability(x.price) - impliedProbability(y.price))
      .map((o) => ({ key: o.bookmaker_key, name: o.bookmaker_name, price: o.price })),
    firstObserved: first ? { price: first.price, at: first.observed_at } : null,
    previous: prior ? { price: prior.price, at: prior.observed_at } : null,
    latest: last ? { price: last.price, at: last.observed_at } : null,
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
 */
export function movement(side: SidePrices | null, basis: "first" | "previous" = "first"): Movement {
  if (!side?.latest) return null;
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
    out.set(id, {
      boutId: id,
      /* Both corners priced is a usable market. One corner is partial and is
       * labelled as such rather than shown as if it were complete. */
      state: a && b ? "available" : "partial",
      marketKey,
      a, b, lastUpdated,
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
  opts: { eventDate: string | null; hasResult: boolean; providerLive?: boolean },
): MarketState {
  if (!marketConfigured()) return "not_configured";
  /* Nothing has ever been ingested, so this is not a bout without a price, it
   * is a product without a market feed. Say the latter. */
  if (opts.providerLive === false) return "not_configured";
  if (market) return market.state;
  if (opts.hasResult) return "unavailable";
  if (opts.eventDate && new Date(`${opts.eventDate}T00:00:00Z`).getTime() < Date.now()) return "unavailable";
  return "not_posted";
}

/* The consensus method, in one sentence, for display next to the number. */
export const CONSENSUS_NOTE =
  "Consensus is the median implied probability across the books we read, converted back to an American price. The vig is left in, so this is a price you could take rather than a de-vigged estimate.";

export const FIRST_OBSERVED_NOTE =
  "First observed is the earliest price this system recorded for the bout. It is not the opening line: we start watching partway through a market's life, so the true opener is unknown.";
