/* GET /api/ufc/round-live
 *
 * The poll target for /round-by-round during a card. It answers exactly two
 * questions, from two different sources, and never blurs them:
 *
 *   is the BROADCAST live?        ufc_event_broadcasts (UFC.com, verified)
 *   which fights have ROUND DATA? ufc_bout_round_stats
 *
 * It carries no in-fight telemetry because none exists: no current round, no
 * live strikes, no clock. The page polls this only while `live` is true and
 * stops otherwise, so between cards this endpoint is not called at all.
 */
import { NextResponse } from "next/server";
import { getRoundLiveState, livePollMs } from "@/lib/roundLive";
import { fmtRecord } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = Date.now();
    const s = await getRoundLiveState(now);
    return NextResponse.json({
      ok: true,
      data: {
        /* Broadcast facts. */
        event: s.broadcast ? {
          name: s.broadcast.event_name,
          slug: s.broadcast.ufc_slug,
          event_id: s.broadcast.event_id,
          venue: s.broadcast.venue,
          location: s.broadcast.location_raw,
          prelims_start_utc: s.broadcast.prelims_start_utc,
          main_card_start_utc: s.broadcast.main_card_start_utc,
          ufc_event_url: s.broadcast.ufc_event_url,
          verified_at: s.broadcast.verified_at,
        } : null,
        event_state: s.eventState,
        live: s.isLive,
        /* Round-data facts — deliberately a separate object. */
        round_data: {
          completed_with_rounds: s.completed.length,
          card_size: s.cardSize,
          bouts: s.completed.map(({ bout, coverage }) => ({
            bout_id: bout.id,
            a: { id: bout.fighter_a.id, name: bout.fighter_a.name, record: fmtRecord(bout.fighter_a) },
            b: { id: bout.fighter_b.id, name: bout.fighter_b.name, record: fmtRecord(bout.fighter_b) },
            winner_id: bout.result?.winner_id ?? null,
            method: bout.result?.method ?? null,
            finish_round: bout.result?.round ?? null,
            rounds_covered: coverage.rounds,
            both_corners: coverage.bothCorners,
          })),
        },
      },
      meta: {
        poll_ms: livePollMs(s),
        checked_at: s.checkedAt,
        /* Stated so no consumer can mistake this for a live feed. */
        in_fight_telemetry: false,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/ufc/round-live] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: "round_live_unavailable" }, { status: 503 });
  }
}
