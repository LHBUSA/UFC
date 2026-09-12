import "server-only";

/* Market availability for an editorial article, resolved AT RENDER TIME.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * Articles carried a frozen `market_watch.status` written by the generator,
 * months before a reader ever loads the page. scripts/news/write_features.mjs
 * wrote `status: 'unavailable'`, and the renderer turned that into "Market data
 * not yet connected" forever — while the event and fight pages, reading the
 * same database, were showing real verified prices for the same bouts.
 *
 * A generation-time snapshot cannot answer a question about the present. So
 * nothing here reads the article's stored status: availability is resolved now,
 * from the same tables and the same helpers the fight page uses.
 *
 * TWO THINGS THAT ARE NOT THE SAME
 * --------------------------------
 *   markets of interest   editorial judgement — "this is worth watching"
 *   market availability   a fact about our data — "we hold a verified price"
 * The article owns the first and must never be allowed to assert the second.
 * That is exactly the conflation that produced the bug.
 *
 * WHAT WE ACTUALLY INGEST
 * -----------------------
 * scripts/odds/ingest_market.mjs runs with `--markets h2h`. Moneyline is the
 * only market ever written to ufc_market_observations. Every other market an
 * article names is therefore genuinely unheld, and says so individually rather
 * than collapsing the whole module into one wrong sentence.
 */
import {
  getMarketsFor, marketProviderLive, marketStateFor, marketConfigured,
  type BoutMarket, type MarketState,
} from "@/lib/market";
import { getBoutById } from "@/lib/db";

/** The one market key the ingest actually writes. */
export const INGESTED_MARKET_KEY = "h2h";

export type NamedMarket = {
  key: string;
  label: string;
  /** True only for a market we actually ingest AND hold a price for. */
  available: boolean;
  /** Why it is unavailable, in the reader's terms. Null when available. */
  note: string | null;
};

export type EditorialMarket = {
  /** Has the provider ever delivered anything at all? */
  providerLive: boolean;
  /** The moneyline read for this article's bout, when it has one. */
  moneyline: BoutMarket | null;
  /** State of the moneyline, using the site's existing state machine. */
  state: MarketState;
  fighterA: { id: string; name: string } | null;
  fighterB: { id: string; name: string } | null;
  /** Every market the article flagged, each with its own availability. */
  markets: NamedMarket[];
  /** True when we hold at least one real price to show. */
  hasPrices: boolean;
};

const LABEL: Record<string, string> = {
  h2h: "Moneyline",
  moneyline: "Moneyline",
  fight_goes_distance: "Fight goes distance",
  method_of_victory: "Method of victory",
  total_rounds: "Total rounds",
  round_betting: "Round betting",
  prop: "Props",
};
const labelFor = (k: string) => LABEL[k] || k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const isMoneyline = (k: string) => k === "h2h" || k === "moneyline";

/**
 * Resolve what we can actually say about this article's markets, right now.
 *
 * `boutId` is what makes prices possible: the market layer is bout-scoped, so
 * a card-level article with only an event_id gets availability reporting and
 * no price board. We deliberately do not invent an event-level aggregate the
 * rest of the site does not have.
 */
export async function getEditorialMarket(
  { boutId, marketsOfInterest = [] }: { boutId?: string | null; marketsOfInterest?: string[] },
): Promise<EditorialMarket> {
  const requested = [...new Set(marketsOfInterest.filter(Boolean))];
  const configured = marketConfigured();

  const base = (providerLive: boolean, state: MarketState): EditorialMarket => ({
    providerLive,
    moneyline: null,
    state,
    fighterA: null,
    fighterB: null,
    hasPrices: false,
    markets: requested.map((k) => ({
      key: k,
      label: labelFor(k),
      available: false,
      note: !configured || !providerLive
        ? "No verified market snapshot is currently available."
        : isMoneyline(k)
          ? "No verified snapshot currently available."
          : "Not currently ingested by PropBetEdge.",
    })),
  });

  if (!configured) return base(false, "not_configured");

  let providerLive = false;
  try {
    providerLive = await marketProviderLive();
  } catch {
    providerLive = false;
  }
  if (!providerLive) return base(false, "not_configured");
  if (!boutId) return base(true, "unavailable");

  let bout = null;
  try {
    bout = await getBoutById(boutId);
  } catch {
    bout = null;
  }
  if (!bout) return base(true, "unavailable");

  let moneyline: BoutMarket | null = null;
  try {
    const map = await getMarketsFor(
      [bout.id],
      new Map([[bout.id, { a: bout.fighter_a.id, b: bout.fighter_b.id }]]),
      INGESTED_MARKET_KEY,
    );
    moneyline = map.get(bout.id) ?? null;
  } catch {
    moneyline = null;
  }

  const state = marketStateFor(moneyline ?? undefined, {
    eventDate: null,
    hasResult: Boolean(bout.result),
    providerLive: true,
  });
  const hasPrices = state === "available" || state === "partial";

  /* The requested list, plus moneyline itself when the article did not name it
   * — a reader looking at a market module should be told about the one market
   * we actually hold, whether or not the generator thought to list it. */
  const keys = requested.some(isMoneyline) ? requested : ["h2h", ...requested];

  return {
    providerLive: true,
    moneyline,
    state,
    fighterA: { id: bout.fighter_a.id, name: bout.fighter_a.name },
    fighterB: { id: bout.fighter_b.id, name: bout.fighter_b.name },
    hasPrices,
    markets: keys.map((k) => ({
      key: k,
      label: labelFor(k),
      available: isMoneyline(k) ? hasPrices : false,
      note: isMoneyline(k)
        ? (hasPrices ? null : "No verified snapshot currently available.")
        /* Honest and specific: this is not a gap in tonight's data, it is a
         * market we have never ingested. */
        : "Not currently ingested by PropBetEdge.",
    })),
  };
}
