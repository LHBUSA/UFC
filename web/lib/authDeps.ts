import "server-only";
import { createHmac } from "node:crypto";
import type { AuthDeps } from "@/lib/authFlow";
import {
  consumeLoginToken, countRecentAuthAttempts, createEntitledMemberAccount, createLoginToken, createSession,
  findAccountByEmail, recordAuthAttempt, type Account,
} from "@/lib/auth";
import { readUfcEntitlement, ufcOwnerEmail } from "@/lib/entitlement";
import { SITE } from "@/lib/site";
import { EMAIL_FOOTER_HTML, EMAIL_FOOTER_TEXT } from "@/lib/emailFooter";

/* Real dependencies for lib/authFlow.ts. Throttle keys are HMACs keyed with a
 * server-only secret, so the attempts table holds no recoverable email or IP. */

const FROM = "PropBetEdge <access@propbetedge.ai>";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function emailHtml(link: string) {
  const safe = escapeHtml(link);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head><body style="margin:0;padding:0;background:#090b0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#f5f2e8;-webkit-text-size-adjust:100%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#090b0d"><tr><td align="center" style="padding:28px 14px 36px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:#111512;border:1px solid #343225;border-radius:16px"><tr><td style="padding:28px 24px 18px;text-align:center"><div style="font-family:Georgia,'Times New Roman',serif;font-size:27px;line-height:1;font-weight:700;color:#f5f2e8">PROPBETEDGE <span style="color:#d4af37">/</span></div><div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:1.4;color:#d4af37;letter-spacing:.18em;margin-top:8px">SPORTS INTELLIGENCE NETWORK</div></td></tr><tr><td style="padding:4px 24px 8px"><div style="font-size:24px;line-height:1.18;font-weight:750;color:#fff;margin:0 0 10px">Your sign-in link is ready.</div><div style="font-size:15px;line-height:1.6;color:#c9cec8">Open the secure sign-in screen, then tap <strong style="color:#fff">Continue to PropBetEdge</strong> to finish signing in to UFC.</div></td></tr><tr><td style="padding:18px 24px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#d4af37" style="border-radius:10px"><a href="${safe}" target="_blank" style="display:block;width:100%;box-sizing:border-box;padding:17px 18px;color:#0b0d0b;text-decoration:none;font-size:16px;line-height:1.15;font-weight:800;text-align:center;border-radius:10px">Open secure sign-in</a></td></tr></table></td></tr><tr><td style="padding:0 24px 24px"><div style="padding:14px 15px;border:1px solid #2b302c;border-radius:10px;background:#0c0f0d;font-size:12px;line-height:1.55;color:#969e98"><strong style="color:#d4af37">15-minute secure link</strong><br>Email previews and security scanners can open this page, but they cannot complete your sign-in.</div></td></tr></table>${EMAIL_FOOTER_HTML}</td></tr></table></body></html>`;
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
      subject: "Sign in to PropBetEdge",
      html: emailHtml(verify.toString()),
      text: `Your secure PropBetEdge sign-in link is ready.

${verify}

Open the link, then tap Continue to PropBetEdge to finish signing in to UFC.
The link expires in 15 minutes.

${EMAIL_FOOTER_TEXT}`,
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
