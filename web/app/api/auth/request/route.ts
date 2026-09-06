import { NextRequest, NextResponse } from "next/server";
import { createLoginToken, hashToken, normalizeEmail, recentLoginRequestExists, safeNextPath } from "@/lib/auth";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FROM = "PropBetEdge UFC <picks@propbetedge.ai>";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function emailHtml(link: string) {
  const safe = escapeHtml(link);
  return `<!doctype html><html><body style="margin:0;background:#0d0b08;color:#f5f1eb;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="padding:38px 16px;background:#0d0b08"><tr><td align="center"><table width="100%" style="max-width:620px;background:#17130f;border:1px solid rgba(212,175,55,.34);border-radius:18px;padding:34px"><tr><td><img src="https://propbetedge.ai/logo/pbe-full-400.png" width="190" alt="PropBetEdge" style="display:block;max-width:190px;height:auto;margin-bottom:26px"><div style="font-size:11px;font-weight:800;letter-spacing:2.2px;color:#d4af37">UFC · SECURE ACCESS</div><h1 style="font-size:34px;line-height:1.08;margin:12px 0;color:#fff">Your fight room is ready.</h1><p style="color:#b8b3a8;font-size:15px;line-height:1.65;margin:0 0 24px">Use this one-time link to sign in to PropBetEdge UFC. Your browser will stay signed in for 30 days.</p><a href="${safe}" style="display:inline-block;padding:15px 22px;border-radius:8px;background:#d4af37;color:#14110d;text-decoration:none;font-weight:900">OPEN PROPBETEDGE UFC →</a><p style="margin-top:24px;color:#777168;font-size:11px;line-height:1.6">This link expires in 15 minutes and can be used once. If you did not request it, ignore this message.</p></td></tr></table></td></tr></table></body></html>`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);
    const nextPath = safeNextPath(body?.next, "/account");
    if (!email) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });

    if (await recentLoginRequestExists(email, 60)) {
      return NextResponse.json({ ok: true, message: "If that address can receive mail, a secure sign-in link is already on the way." });
    }

    const fingerprintRaw = `${req.headers.get("x-forwarded-for") || ""}|${req.headers.get("user-agent") || ""}`;
    const { raw } = await createLoginToken(email, nextPath, hashToken(fingerprintRaw).slice(0, 32));
    const verify = new URL("/api/auth/verify", SITE.url);
    verify.searchParams.set("token", raw);

    const apiKey = process.env.RESEND_API_KEY || "";
    if (!apiKey) {
      console.error("[auth] RESEND_API_KEY missing");
      return NextResponse.json({ error: "Secure email sign-in is temporarily unavailable." }, { status: 503 });
    }

    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: "PropBetEdge UFC — secure sign-in",
        html: emailHtml(verify.toString()),
        text: `Your PropBetEdge UFC sign-in link:\n\n${verify}\n\nThis one-time link expires in 15 minutes.`,
      }),
      cache: "no-store",
    });
    if (!sent.ok) {
      const detail = await sent.text().catch(() => "");
      console.error("[auth] Resend", sent.status, detail.slice(0, 280));
      return NextResponse.json({ error: "We could not send the sign-in email right now." }, { status: 502 });
    }

    return NextResponse.json({ ok: true, message: "Check your inbox. Your secure UFC sign-in link is on the way." });
  } catch (error) {
    console.error("[auth] request", String((error as Error)?.message || error).slice(0, 220));
    return NextResponse.json({ error: "Secure sign-in is temporarily unavailable." }, { status: 503 });
  }
}
