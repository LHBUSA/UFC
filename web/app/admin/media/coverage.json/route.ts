import { NextResponse } from "next/server";
import { MediaAdminError, currentMediaReviewer, getCoverage } from "@/lib/fighterMediaAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_INDEX = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  if (!(await currentMediaReviewer())) return new NextResponse("Not found", { status: 404, headers: NO_INDEX });
  try {
    return NextResponse.json(await getCoverage(), { headers: NO_INDEX });
  } catch (e) {
    return NextResponse.json({ error: e instanceof MediaAdminError ? e.message : "coverage_failed" }, { status: 503, headers: NO_INDEX });
  }
}
