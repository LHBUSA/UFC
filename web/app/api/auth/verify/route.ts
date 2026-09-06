import { NextRequest, NextResponse } from "next/server";
import { consumeLoginToken, createSession, getOrCreateAccount, safeNextPath, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loginRedirect(code: string) {
  const url = new URL("/login", SITE.url);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url, 302);
}

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("token") || "";
    const token = await consumeLoginToken(raw);
    if (!token) return loginRedirect("expired");

    const account = await getOrCreateAccount(token.email);
    const session = await createSession(account, req.headers.get("user-agent"));
    const destination = new URL(safeNextPath(token.next_path, "/account"), SITE.url);
    const res = NextResponse.redirect(destination, 302);
    res.cookies.set({
      name: SESSION_COOKIE,
      value: session.raw,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } catch (error) {
    console.error("[auth] verify", String((error as Error)?.message || error).slice(0, 220));
    return loginRedirect("unavailable");
  }
}
