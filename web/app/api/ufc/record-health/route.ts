import { NextResponse } from "next/server";
import { getAlgoRecordHealth } from "@/lib/algo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Operational health of the public PBE Picks record, in the shape of
 * /api/auth/health: 200 when healthy, 503 when not, never cached.
 *
 * Unhealthy means one of: the record store could not be read; a card's official
 * picks are still ungraded GRADING_OVERDUE_DAYS after its date; a grade names no
 * official locked pick; a primary key was served twice. Aggregates and event
 * names only: no fighter, side, probability or prediction id is returned, so
 * this cannot leak a current pick. */
export async function GET() {
  const health = await getAlgoRecordHealth();
  return NextResponse.json({ service: "ufc-pbe-record", ...health }, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
