import { NextRequest, NextResponse } from "next/server";
import { authDeps } from "@/lib/authDeps";
import { handleLoginVerify } from "@/lib/authFlow";
import { safeNextPath, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loginRedirect(code: string) {
  const url = new URL("/login", SITE.url);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url, 302);
}

/* Consumes the one-time token, then RE-CHECKS paid-only eligibility before any
 * account or session is created. Query parameters other than the token are
 * ignored entirely. */
export async function GET(req: NextRequest) {
  try {
    const result = await handleLoginVerify(authDeps(), {
      rawToken: req.nextUrl.searchParams.get("token") || "",
      userAgent: req.headers.get("user-agent"),
    });
    if (!result.ok) return loginRedirect(result.error);
    const res = NextResponse.redirect(new URL(safeNextPath(result.nextPath, "/account"), SITE.url), 302);
    res.cookies.set({ name: SESSION_COOKIE, value: result.sessionRaw, httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
    return res;
  } catch (error) {
    console.error("[auth] verify", String((error as Error)?.message || error).slice(0, 220));
    return loginRedirect("unavailable");
  }
}
