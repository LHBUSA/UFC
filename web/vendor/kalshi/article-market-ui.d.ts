/* Type declarations for the vendored, unchanged article-market-ui.js (contract article-market/1,
 * packet post_event_market_result/1). This file is ours; article-market-ui.js / .css beside it are
 * byte-identical copies of propbetedge-workers/workers/propsports-markets/client/ at 8d3b73f
 * (enforced by lib/articleMarket.test.ts). */
export interface ArticleMarketPayload {
  contract: string;
  sport: string;
  enabled: boolean;
  eligible?: boolean;
  reason?: string;
  activated_at?: string;
  mode?: "LIVE_MARKET_WATCH" | "MARKET_RESULT" | string;
  freeze?: "EMBED_THIS_PACKET" | "DO_NOT_FREEZE_YET" | string;
  packet: { packet_state: string; sha256: string; canonical_event_id: string; [k: string]: unknown } | null;
  live: { mode: string; [k: string]: unknown } | null;
  [k: string]: unknown;
}
/** HTML string; '' when ineligible or nothing observed (no empty state). */
export function articleMarketModule(payload: ArticleMarketPayload | null | undefined, opts?: { placement?: string }): string;
/** Progressive enhancement; returns a stop function. `base` is the product's same-origin path. */
export function mountArticleMarket(
  host: Element | null,
  opts: {
    base: string;
    sport: string;
    eventId: string;
    publishedAt: string;
    initial?: ArticleMarketPayload | null;
    refreshMs?: number;
    fetchImpl?: (url: string) => Promise<Response>;
  },
): () => void;
