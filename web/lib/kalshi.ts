/* Kalshi Market Intelligence for UFC (contract market-intel/1).
 *
 * Public prediction-market data, read from our shared propsports-markets
 * Worker — never from Kalshi itself. It is a separate layer from the
 * sportsbook Market section (lib/market.ts), which stays Pro-only and
 * untouched: Kalshi prices are shown to every reader.
 *
 * The canonical event id is ufc_bouts.id (uuid). Outcome roles `a` / `b` are
 * our fighter_a / fighter_b. The UFC proposition is
 * `fighter_wins_bout_nc_draw_half`: a draw or no contest resolves 50/50, so
 * the card always carries UFC_KALSHI_NOTE beside it.
 *
 * No `server-only` / `@/` imports: node's test runner loads this file directly. */
import { kalshiCard, kalshiLine, marketCloseLine, marketHistoryCard } from "../vendor/kalshi/kalshi-market-ui.js";
import type { KalshiEntry } from "../vendor/kalshi/kalshi-market-ui.js";

export type { KalshiEntry };

export const KALSHI_MARKETS_BASE = "https://propsports-markets.sales-fd3.workers.dev";
export const KALSHI_SPORT = "ufc";
export const UFC_KALSHI_NOTE = "A draw or no contest pays 50¢ per contract.";
/* First paint waits at most this long for the markets API; a slow or failed
 * read renders the page without the card and the client fills it in. */
export const KALSHI_SERVER_WAIT_MS = 1200;
export const KALSHI_REVALIDATE_S = 15;

type FetchLike = (url: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/* An entry is usable while it has a live block, or once it has a recorded
 * market (closed / settled history or a board close summary). A completed
 * bout keeps its market: pricing never disappears when the fight ends. */
const usableEntry = (e: unknown): e is KalshiEntry => {
  const x = e as KalshiEntry | null;
  return Boolean(x && x.event && x.event.canonical_event_id && (x.kalshi || x.market_history || x.market?.close));
};

/** Market lifecycle from the API (DISCOVERED | UPCOMING | ACTIVE | CLOSED | SETTLED), or null. */
export function marketLifecycle(entry: KalshiEntry | null | undefined): string | null {
  return entry?.market?.lifecycle ?? entry?.market_history?.lifecycle ?? null;
}
const closedOrSettled = (entry: KalshiEntry | null | undefined) => {
  const lc = marketLifecycle(entry);
  return lc === "CLOSED" || lc === "SETTLED";
};

async function readJson(url: string, fetchImpl: FetchLike, waitMs: number): Promise<any | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      next: { revalidate: KALSHI_REVALIDATE_S },
      signal: AbortSignal.timeout(waitMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** One bout's entry with observed movement, or null (disabled, unmatched, slow, failed). */
export async function getKalshiEvent(boutId: string, { fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<KalshiEntry | null> {
  if (!boutId) return null;
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/market-intelligence/event/${KALSHI_SPORT}/${encodeURIComponent(boutId)}`, fetchImpl, waitMs);
  return body?.enabled && usableEntry(body.event) ? body.event : null;
}

/** The whole UFC board keyed by bout uuid; empty on any failure. */
export async function getKalshiBoard({ fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<Record<string, KalshiEntry>> {
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/market-intelligence/sport/${KALSHI_SPORT}`, fetchImpl, waitMs);
  const out: Record<string, KalshiEntry> = {};
  if (body?.enabled && Array.isArray(body.events)) {
    for (const e of body.events) if (usableEntry(e)) out[String(e.event.canonical_event_id)] = e;
  }
  return out;
}

/** Poll state. A settled market never changes again; a closed one only waits
 * for the venue's settlement; otherwise the API event state decides. */
export function kalshiPollState(entry: KalshiEntry | null | undefined): "live" | "pregame" | "closed" | "settled" | "idle" {
  const lc = marketLifecycle(entry);
  if (lc === "SETTLED") return "settled";
  if (lc === "CLOSED") return "closed";
  const s = entry?.event?.state;
  if (s === "in" || s === "live") return "live";
  if (s === "pre") return "pregame";
  return "idle";
}

/* Live 20 s / pregame 45 s come from the shared client; a closed market is
 * re-read every 5 minutes until it settles; a settled market is never polled. */
export const KALSHI_CLOSED_POLL_MS = 5 * 60_000;
export function kalshiPollMs(state: ReturnType<typeof kalshiPollState>, sharedPollMs: (s: string) => number): number | null {
  if (state === "settled") return null;
  if (state === "closed") return KALSHI_CLOSED_POLL_MS;
  return sharedPollMs(state);
}

/** Lifecycle label for the fight-page module (the MLB PBEcast standard):
 * [phase key, text], or null without an entry. The venue's market lifecycle
 * decides first (a finished fight is not a settled market); then the bout:
 * a result on file -> FIGHT FINAL while the market still trades; the API's
 * live bout state -> LIVE MARKET; otherwise pre-fight. A stale quote is never
 * labelled live. */
export function ufcMarketPhase(entry: KalshiEntry | null | undefined, { final = false }: { final?: boolean } = {}): [string, string] | null {
  if (!entry) return null;
  const lc = marketLifecycle(entry);
  if (lc === "SETTLED") return ["settled", "MARKET SETTLED"];
  if (lc === "CLOSED") return ["closed", "MARKET CLOSED · AWAITING SETTLEMENT"];
  if (final) return ["final-open", "FIGHT FINAL · MARKET STILL TRADING"];
  if (entry.kalshi?.freshness === "stale") return ["stale", "MARKET OPEN · LAST QUOTE STALE"];
  const s = entry.event?.state;
  if (s === "in" || s === "live") return ["live", "LIVE MARKET"];
  return ["pre", "MARKET OPEN · PRE-FIGHT"];
}

/** Fight-page module, directly under the faceoff for the whole bout lifecycle:
 * the full Market Pulse card (Mid-market, Updated Ns ago, movement, bid / ask,
 * View market on Kalshi) while the market trades, "How the market closed" in
 * the SAME place once it has closed or settled, always with the lifecycle
 * label and the UFC draw / no-contest note (the fight-winner contract resolves
 * 50/50 on either). "" without an entry or without anything to show. */
export function ufcKalshiCardHtml(entry: KalshiEntry | null | undefined, placement = "fight-page", { final = false }: { final?: boolean } = {}): string {
  const phase = ufcMarketPhase(entry, { final });
  if (!entry || !phase) return "";
  const body = closedOrSettled(entry)
    ? marketHistoryCard(entry, { placement }) || kalshiCard(entry, { placement })
    : kalshiCard(entry, { placement });
  if (!body) return "";
  return `<div class="ufc-mkt" data-phase="${phase[0]}"><div class="ufc-mkt-phase"><span class="ufc-mkt-dot" aria-hidden="true"></span>${phase[1]}</div>${body}<p class="ufc-kx__rule">${UFC_KALSHI_NOTE}</p></div>`;
}

/** Restrained compact line for a bout row: live prices while trading, the
 * market's close once the bout's market has closed or settled, or "". A result
 * card (`result`) never shows live prices: only the close line, when it has content. */
export function ufcKalshiLineHtml(entry: KalshiEntry | null | undefined, { result = false }: { result?: boolean } = {}): string {
  if (!entry) return "";
  if (closedOrSettled(entry)) return marketCloseLine(entry);
  return result ? "" : kalshiLine(entry);
}
