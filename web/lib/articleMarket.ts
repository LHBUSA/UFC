/* Article Market module for UFC news (contract article-market/1; propbetedge-workers
 * workers/propsports-markets/docs/POST_EVENT_MARKET_RESULT.md). ONE module with a lifecycle on an
 * article linked to ONE bout: LIVE MARKET WATCH while the market trades -> THE MARKET RESULT once
 * the bout is over. Reference implementation: soccer 063b772.
 *
 * - Link = ufc_articles.bout_id (= ufc_bouts.id, the canonical id the propsports-markets ufc and
 *   pm-ufc lanes key by). Never a title or name match.
 * - Prospective only (owner 2026-10-04, NO BACKFILL): the shared API refuses an article first
 *   published before its activation time. ARTICLE_MARKET_ACTIVATED_AT here only saves a request
 *   for older stories; the API stays the authority. Never move it.
 * - published_at = the ORIGINAL first publication (ufc_articles.published_at; corrections and
 *   refreshes move updated_at, never published_at).
 * - The browser reads through the same-origin route /api/markets/v1/article-market/ufc/:id
 *   (app/api/markets/...), never a Worker host, Kalshi or Polymarket.
 * - Nothing eligible / nothing observed / a failed or slow read -> nothing rendered.
 *
 * No `server-only` / `@/` imports: node's test runner loads this file directly. */
import { articleMarketModule } from "../vendor/kalshi/article-market-ui.js";
import type { ArticleMarketPayload } from "../vendor/kalshi/article-market-ui.js";

export type { ArticleMarketPayload };

export const ARTICLE_MARKET_ACTIVATED_AT = "2026-10-04T14:31:40Z";
export const ARTICLE_MARKET_SPORT = "ufc";
export const ARTICLE_MARKET_UPSTREAM = "https://propsports-markets.sales-fd3.workers.dev";
/** Same-origin base the browser client reads through (the vendored client requires one). */
export const ARTICLE_MARKET_BASE = "/api/markets";
export const ARTICLE_MARKET_REFRESH_MS = 30_000;
/** First paint waits at most this long; a slower read renders the page without the module. */
export const ARTICLE_MARKET_SERVER_WAIT_MS = 1200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isBoutId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

type ArticleLike = { bout_id?: string | null; published_at?: string | null; status?: string | null };

/** The canonical bout id of an eligible article, else null. */
export function articleMarketEvent(a: ArticleLike | null | undefined): string | null {
  if (!a || (a.status && a.status !== "published")) return null;
  const pub = Date.parse(a.published_at || "");
  if (!Number.isFinite(pub) || pub < Date.parse(ARTICLE_MARKET_ACTIVATED_AT)) return null;
  return isBoutId(a.bout_id) ? a.bout_id : null;
}

export function articleMarketPath(boutId: string, publishedAt: string): string {
  return `/v1/article-market/${ARTICLE_MARKET_SPORT}/${encodeURIComponent(boutId)}?published_at=${encodeURIComponent(publishedAt)}`;
}

type FetchLike = (url: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/** Server read for first paint: the eligible payload, or null (ineligible, nothing observed, slow, failed). */
export async function getArticleMarket(a: ArticleLike, { fetchImpl = fetch as FetchLike, waitMs = ARTICLE_MARKET_SERVER_WAIT_MS } = {}): Promise<ArticleMarketPayload | null> {
  const id = articleMarketEvent(a);
  if (!id) return null;
  try {
    const res = await fetchImpl(`${ARTICLE_MARKET_UPSTREAM}${articleMarketPath(id, a.published_at as string)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(waitMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ArticleMarketPayload;
    return body?.eligible && articleMarketModule(body) ? body : null;
  } catch {
    return null;
  }
}

/** First-paint HTML ('' = render nothing). */
export const articleMarketHtml = (payload: ArticleMarketPayload | null | undefined): string =>
  payload ? articleMarketModule(payload, { placement: "ufc-article" }) : "";

/** Where the module goes in a story's rendered blocks: the block that starts the SECOND section
 * (second h2/h3), else after two blocks (capped at the block count = after the body). */
export function firstSectionEnd(blocks: string[]): number {
  const second = blocks.findIndex((b, i) => i > 0 && /^<h[23]/.test(b));
  return second > 0 ? second : Math.min(2, blocks.length);
}
