/* Same-origin read for the article-market/1 module (components/ArticleMarket.tsx).
 *
 * One exact route: UFC only, a bout uuid only, published_at passed through unchanged. The shared
 * propsports-markets Worker stays the authority for eligibility (activation time, NO BACKFILL) and
 * for every price; this handler never edits, merges or caches a payload beyond the Worker's own
 * short freshness. The browser therefore never names a Worker host, Kalshi or Polymarket. */
import { ARTICLE_MARKET_UPSTREAM, articleMarketPath, isBoutId } from "@/lib/articleMarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const publishedAt = new URL(req.url).searchParams.get("published_at");
  if (!isBoutId(id) || !publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers: NO_STORE });
  }
  try {
    const res = await fetch(`${ARTICLE_MARKET_UPSTREAM}${articleMarketPath(id, publishedAt)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: NO_STORE });
  } catch {
    return new Response(JSON.stringify({ error: "upstream_unavailable" }), { status: 502, headers: NO_STORE });
  }
}
