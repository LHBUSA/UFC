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
import { kalshiCard, kalshiLine } from "../vendor/kalshi/kalshi-market-ui.js";
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

const usableEntry = (e: unknown): e is KalshiEntry => {
  const x = e as KalshiEntry | null;
  return Boolean(x && x.event && x.event.canonical_event_id && x.kalshi);
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

/** API event state ('pre' | 'in' | 'post') -> the shared client's poll state. */
export function kalshiPollState(entry: KalshiEntry | null | undefined): "live" | "pregame" | "idle" {
  const s = entry?.event?.state;
  if (s === "in" || s === "live") return "live";
  if (s === "pre") return "pregame";
  return "idle";
}

/** Full card plus the UFC draw / no-contest note, or "" when there is nothing to show. */
export function ufcKalshiCardHtml(entry: KalshiEntry | null | undefined, placement = "fight-page"): string {
  const card = entry ? kalshiCard(entry, { placement }) : "";
  if (!card) return "";
  return `${card}<p class="ufc-kx__rule">${UFC_KALSHI_NOTE}</p>`;
}

/** Restrained compact line for a bout row, or "". */
export function ufcKalshiLineHtml(entry: KalshiEntry | null | undefined): string {
  return entry ? kalshiLine(entry) : "";
}
