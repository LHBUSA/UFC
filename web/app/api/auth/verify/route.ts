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
function confirmPage(token: string) {
  const safe = token.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
  return new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>Continue sign-in · PropBetEdge</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#090b0d;color:#f5f2e8}body{min-height:100dvh;display:grid;place-items:center;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}.card{width:min(100%,460px);padding:28px 22px;border:1px solid #393628;border-radius:18px;background:linear-gradient(180deg,#151914,#0e110f);box-shadow:0 24px 70px rgba(0,0,0,.45)}.brand{font:700 24px/1 Georgia,serif}.brand b{color:#d4af37}.eyebrow{margin-top:8px;font:700 10px/1.4 monospace;letter-spacing:.16em;color:#d4af37}h1{margin:30px 0 10px;font-size:30px;line-height:1.05}p{margin:0;color:#b8c0ba;font-size:15px;line-height:1.6}form{margin-top:24px}button{display:block;width:100%;min-height:56px;border:1px solid #e0c45a;border-radius:11px;background:#d4af37;color:#090b0d;font:800 16px/1.1 inherit;cursor:pointer}</style></head><body><main class="card"><div class="brand">PROPBETEDGE <b>/</b></div><div class="eyebrow">UFC · SECURE MEMBER ACCESS</div><h1>Finish signing in.</h1><p>This final tap confirms it is really you opening the email. Your link has not been used yet.</p><form method="post" action="/api/auth/verify"><input type="hidden" name="token" value="${safe}"><button type="submit">Continue to PropBetEdge</button></form></main></body></html>`, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function consumeAndRedirect(req: NextRequest, rawToken: string) {
  try {
    const result = await handleLoginVerify(authDeps(), {
      rawToken,
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

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!token) return loginRedirect("expired");
  return confirmPage(token);
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") || "");
  if (!token) return loginRedirect("expired");
  return consumeAndRedirect(req, token);
}
