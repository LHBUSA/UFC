import { NextResponse } from "next/server";
import { getCurrentAccount, hasProAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const account = await getCurrentAccount();
  return NextResponse.json({
    authenticated: Boolean(account),
    account: account ? {
      email: account.email,
      display_name: account.display_name,
      role: account.role,
      plan: account.plan,
      unlimited: account.unlimited,
      access_expires_at: account.access_expires_at,
    } : null,
    pro: hasProAccess(account),
  }, { headers: { "Cache-Control": "no-store" } });
}
