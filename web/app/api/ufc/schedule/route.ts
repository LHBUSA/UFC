/* GET /api/ufc/schedule?limit=20&include=upcoming|all
 *
 * The verified broadcast schedule: every card UFC.com currently publishes a
 * start time for, soonest first, with its carriers and its verification
 * timestamps. Same source and same rules as /api/ufc/next-event — our cached
 * normalized rows, never a live UFC.com fetch on a page load.
 */
import { NextResponse } from "next/server";
import { getBroadcastSchedule, watchState, isFinished, isStale } from "@/lib/broadcast";

/* Same reasoning as /api/ufc/next-event: dynamic, cached at the edge. */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const include = url.searchParams.get("include") === "all" ? "all" : "upcoming";

  try {
    const now = Date.now();
    const rows = await getBroadcastSchedule(60, 0);
    const filtered = (include === "all" ? rows : rows.filter((r) => !isFinished(r, now))).slice(0, limit);

    return NextResponse.json({
      ok: true,
      data: filtered.map((b) => ({
        event_id: b.event_id,
        ufc_slug: b.ufc_slug,
        event_name: b.event_name,
        event_date: b.event_date,
        venue: b.venue,
        location: b.location_raw,
        early_prelims_start_utc: b.early_prelims_start_utc,
        prelims_start_utc: b.prelims_start_utc,
        main_card_start_utc: b.main_card_start_utc,
        broadcasts: b.broadcasts ?? [],
        ufc_event_url: b.ufc_event_url,
        source: b.source,
        source_url: b.source_url,
        verified_at: b.verified_at,
        last_changed_at: b.last_changed_at,
        state: watchState(b, now),
      })),
      meta: {
        count: filtered.length,
        include,
        source: "UFC.com",
        /* Diagnostics a consumer can act on: the oldest verification in the set
         * is the real freshness of this payload. */
        oldest_verified_at: filtered.reduce<string | null>((acc, r) => (!acc || r.verified_at < acc ? r.verified_at : acc), null),
        any_stale: filtered.some((r) => isStale(r.verified_at, now)),
        generated_at: new Date(now).toISOString(),
      },
    }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=900" } });
  } catch (e) {
    console.error(`[api/ufc/schedule] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: "schedule_unavailable" }, { status: 503 });
  }
}
