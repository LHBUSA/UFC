import { NextResponse } from "next/server";
import { authConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const database = authConfigured();
  const email = Boolean(process.env.RESEND_API_KEY);
  return NextResponse.json({ ok: database && email, database, email }, { status: database && email ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
