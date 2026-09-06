import { NextRequest, NextResponse } from "next/server";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await deleteSession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/", SITE.url), 303);
  res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 0 });
  return res;
}
