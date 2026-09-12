/* GET /api/ufc/next-event
 *
 * Everything the homepage or a card needs to render How to Watch in one call:
 * the soonest card that has not finished, its canonical UTC start instants, its
 * carriers with official destinations, the official UFC event URL, and the
 * verification timestamps.
 *
 * It reads OUR cached normalized schedule. It never touches UFC.com — the
 * ufc-broadcast-schedule Cloudflare Worker owns that, on a Cron Trigger, and a
 * reader's page load must never wait on the promotion's website.
 *
 * Times are UTC and only UTC. No ET/PT display string is served as the truth;
 * the client localizes from the instant.
 */
import { NextResponse } from "next/server";
import { getNextBroadcast, watchState, isStale, linkableBroadcasts, startLines } from "@/lib/broadcast";

/* Dynamic, with a short SHARED cache at the edge — the same posture as
 * /api/ticker. Not a static prerender: this endpoint answers "what is the next
 * event", which is an existence question, and a build-time answer to that is
 * wrong the moment a card is added, moved or finishes. A burst of readers still
 * costs one query thanks to s-maxage. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const b = await getNextBroadcast(Date.now(), 0);
    if (!b) {
      /* State 10: no upcoming UFC event found. A 200 with an explicit null is
       * the honest answer; a 404 would read as "this endpoint is broken". */
      return NextResponse.json(
        { ok: true, data: null, meta: { reason: "no upcoming event with a published schedule" } },
        { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=900" } },
      );
    }

    const now = Date.now();
    return NextResponse.json({
      ok: true,
      data: {
        event_id: b.event_id,
        ufc_slug: b.ufc_slug,
        event_name: b.event_name,
        event_date: b.event_date,
        venue: b.venue,
        location: b.location_raw,
        early_prelims_start_utc: b.early_prelims_start_utc,
        prelims_start_utc: b.prelims_start_utc,
        main_card_start_utc: b.main_card_start_utc,
        segments: startLines(b),
        broadcasts: b.broadcasts ?? [],
        linkable_broadcasts: linkableBroadcasts(b),
        ufc_event_url: b.ufc_event_url,
        tickets_url: b.tickets_url,
        source: b.source,
        source_url: b.source_url,
        verified_at: b.verified_at,
        last_changed_at: b.last_changed_at,
      },
      meta: {
        /* Computed against server UTC. The client recomputes it in the
         * visitor's zone — "today" is a property of the viewer, not of us. */
        state: watchState(b, now),
        stale: isStale(b.verified_at, now),
        parser: b.parser,
        generated_at: new Date(now).toISOString(),
      },
    }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=900" } });
  } catch (e) {
    console.error(`[api/ufc/next-event] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: "next_event_unavailable" }, { status: 503 });
  }
}
