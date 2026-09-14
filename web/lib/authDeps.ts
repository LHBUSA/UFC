import "server-only";
import { createHmac } from "node:crypto";
import type { AuthDeps } from "@/lib/authFlow";
import {
  consumeLoginToken, countRecentAuthAttempts, createEntitledMemberAccount, createLoginToken, createSession,
  findAccountByEmail, recordAuthAttempt, type Account,
} from "@/lib/auth";
import { readUfcEntitlement, ufcOwnerEmail } from "@/lib/entitlement";
import { SITE } from "@/lib/site";

/* Real dependencies for lib/authFlow.ts. Throttle keys are HMACs keyed with a
 * server-only secret, so the attempts table holds no recoverable email or IP. */

const FROM = "PropBetEdge UFC <picks@propbetedge.ai>";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function emailHtml(link: string) {
  const safe = escapeHtml(link);
  return `<!doctype html><html><body style="margin:0;background:#0d0b08;color:#f5f1eb;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="padding:38px 16px;background:#0d0b08"><tr><td align="center"><table width="100%" style="max-width:620px;background:#17130f;border:1px solid rgba(212,175,55,.34);border-radius:18px;padding:34px"><tr><td><img src="https://propbetedge.ai/logo/pbe-full-400.png" width="190" alt="PropBetEdge" style="display:block;max-width:190px;height:auto;margin-bottom:26px"><div style="font-size:11px;font-weight:800;letter-spacing:2.2px;color:#d4af37">UFC · SECURE ACCESS</div><h1 style="font-size:34px;line-height:1.08;margin:12px 0;color:#fff">Your fight room is ready.</h1><p style="color:#b8b3a8;font-size:15px;line-height:1.65;margin:0 0 24px">Use this one-time link to sign in to PropBetEdge UFC. Your browser will stay signed in for 30 days.</p><a href="${safe}" style="display:inline-block;padding:15px 22px;border-radius:8px;background:#d4af37;color:#14110d;text-decoration:none;font-weight:900">OPEN PROPBETEDGE UFC →</a><p style="margin-top:24px;color:#777168;font-size:11px;line-height:1.6">This link expires in 15 minutes and can be used once. If you did not request it, ignore this message.</p></td></tr></table></td></tr></table></body></html>`;
}

async function sendLoginEmail(email: string, rawToken: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY || "";
  if (!apiKey) throw new Error("resend_not_configured");
  const verify = new URL("/api/auth/verify", SITE.url);
  verify.searchParams.set("token", rawToken);
  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: "PropBetEdge UFC — secure sign-in",
      html: emailHtml(verify.toString()),
      text: `Your PropBetEdge UFC sign-in link:

${verify}

This one-time link expires in 15 minutes.`,
    }),
    cache: "no-store",
  });
  if (!sent.ok) throw new Error(`resend_${sent.status}`);
}

export function authDeps(): AuthDeps {
  const hmacKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return {
    ownerEmail: ufcOwnerEmail(),
    hash: (value) => {
      if (!hmacKey) throw new Error("auth_not_configured");
      return createHmac("sha256", hmacKey).update(value).digest("hex");
    },
    countRecentAttempts: countRecentAuthAttempts,
    recordAttempt: recordAuthAttempt,
    findAccount: findAccountByEmail,
    readEntitlement: async (email) => {
      const r = await readUfcEntitlement(email);
      return r.state === "ok" ? { state: "ok", entitled: r.entitled } : { state: "unavailable" };
    },
    createLoginToken: (email, nextPath, fingerprintHash) => createLoginToken(email, nextPath, fingerprintHash.slice(0, 32)),
    sendLoginEmail,
    consumeLoginToken,
    createEntitledMember: createEntitledMemberAccount,
    createSession: (account, userAgent) => createSession(account as Account, userAgent),
    now: () => Date.now(),
    log: (event, detail) => console.log(`[auth] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
  };
}
