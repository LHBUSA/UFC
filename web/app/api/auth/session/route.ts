import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/auth";
import { getUfcAccess } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [rawAccount, access] = await Promise.all([getCurrentAccount(), getUfcAccess()]);
  const account = access.signedIn ? rawAccount : null;
  return NextResponse.json({
    authenticated: access.signedIn,
    account: account ? {
      email: account.email,
      display_name: account.display_name,
      role: account.role,
      plan: account.plan,
      unlimited: account.unlimited,
      access_expires_at: account.access_expires_at,
    } : null,
    pro: access.pro,
    tier: access.tier,
  }, { headers: { "Cache-Control": "no-store" } });
}
