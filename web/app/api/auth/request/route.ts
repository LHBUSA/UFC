import { NextRequest, NextResponse } from "next/server";
import { authDeps } from "@/lib/authDeps";
import { handleLoginRequest } from "@/lib/authFlow";
import { safeNextPath } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Paid-only magic-link request. Authorization (owner, or a current ufc_pro
 * entitlement from the billing Worker) is decided before any login token,
 * account or email exists; every valid-looking request gets the same response.
 * See lib/authFlow.ts and lib/authPolicy.ts. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const result = await handleLoginRequest(authDeps(), {
      email: body?.email,
      next: safeNextPath(body?.next, "/account"),
      fingerprint: ip || `ua:${req.headers.get("user-agent") || ""}`,
    });
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[auth] request", String((error as Error)?.message || error).slice(0, 220));
    return NextResponse.json({ error: "Secure sign-in is temporarily unavailable." }, { status: 503 });
  }
}
