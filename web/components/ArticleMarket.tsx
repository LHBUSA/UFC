"use client";
/* The article-market/1 module on a UFC story (LIVE MARKET WATCH -> THE MARKET RESULT).
 *
 * First paint comes from the server (StoryView reads the payload inside its render), so the module
 * is in the document from the start and adds no layout shift. The vendored client then refreshes it
 * ~30 s while it is on screen and the tab is visible; a FINAL packet is never refetched.
 *
 * A server read that missed its budget leaves an empty host (no placeholder, nothing drawn). The
 * browser then reads once and inserts the module only while the host is still BELOW the viewport,
 * so a late answer never moves what the reader is looking at. */
import { useEffect, useRef } from "react";
import { mountArticleMarket } from "@/vendor/kalshi/article-market-ui.js";
import { ARTICLE_MARKET_BASE, ARTICLE_MARKET_REFRESH_MS, ARTICLE_MARKET_SPORT, articleMarketHtml, articleMarketPath, type ArticleMarketPayload } from "@/lib/articleMarket";

export function ArticleMarket({ boutId, publishedAt, initial, html }: { boutId: string; publishedAt: string; initial: ArticleMarketPayload | null; html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const start = (payload: ArticleMarketPayload | null) => mountArticleMarket(host, {
      base: ARTICLE_MARKET_BASE, sport: ARTICLE_MARKET_SPORT, eventId: boutId, publishedAt, initial: payload, refreshMs: ARTICLE_MARKET_REFRESH_MS,
    });
    if (initial) return start(initial);
    let stop = () => {};
    let gone = false;
    fetch(`${ARTICLE_MARKET_BASE}${articleMarketPath(boutId, publishedAt)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((late: ArticleMarketPayload | null) => {
        if (gone || !late?.eligible || !articleMarketHtml(late) || !host.isConnected) return;
        if (host.getBoundingClientRect().top < window.innerHeight) return; // would shift what the reader sees
        stop = start(late);
      })
      .catch(() => {});
    return () => { gone = true; stop(); };
  }, [boutId, publishedAt, initial]);
  return <div ref={ref} className="art-market" data-art-market={boutId} dangerouslySetInnerHTML={{ __html: html }} />;
}
