/* The live rail's polling endpoint.
 *
 * The rail re-fetches every 45 seconds, and it must get the SAME merge the
 * server rendered — our published coverage first, superseded wire items
 * removed. The public /v1/ufc/wire API cannot answer that: it serves
 * ufc_news_items and has no view of which of them we have since covered, so a
 * rail polling it would silently revert to an all-external list one poll after
 * the page loaded, and only on the client, which is the hardest kind of
 * regression to notice.
 *
 * The public API is deliberately left alone. It is a wire feed for external
 * consumers and that is a different product from our front page.
 */
import { NextResponse } from "next/server";
import { getWireFirstParty } from "@/lib/wire";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Math.min(40, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  try {
    const wire = await getWireFirstParty(limit);
    return NextResponse.json(
      { ok: true, data: wire.items, meta: wire.meta },
      /* Short shared cache, so a burst of readers costs one query, but never so
       * long that a story we just published is missing from the rail. */
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch (e) {
    /* The rail keeps its current items on a failed poll, so an error here
     * degrades to "no update" rather than an empty ticker. */
    console.error(`[api/ticker] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: "ticker_unavailable" }, { status: 503 });
  }
}
