/* UFC authentication policy: paid-only.
 *
 *   NO PAID UFC ENTITLEMENT = NO LOGIN EMAIL, NO ACCOUNT, NO SESSION, NO PRO.
 *   OWNER = THE ONLY EXCEPTION.
 *
 * Pure and I/O-free so every branch is testable. The inputs are gathered on
 * the server only:
 *   ownerEmail   UFC_OWNER_EMAIL, a server environment value (never the browser)
 *   account      the ufc_accounts row for the email, if one exists
 *   ledger       the billing Worker's answer for ufc_pro
 *
 * The owner is the account whose email equals UFC_OWNER_EMAIL AND whose row is
 * role=owner with unlimited access. Either half alone grants nothing, so a row
 * flag cannot promote an arbitrary email, and a configured email cannot promote
 * an account that is not the owner row. A missing UFC_OWNER_EMAIL means there
 * is no owner exception at all (fail closed).
 *
 * Nothing the browser sends counts: not a checkout query, not a session_id, not
 * a subscription claim. Legacy ufc_accounts.plan='pro' grants nothing.
 */

export type AuthAccount = { id: string; email: string; role: string | null; plan: string | null; unlimited: boolean | null };

export type EntitlementRead =
  | { state: "ok"; entitled: boolean }
  | { state: "unavailable" };

export type Eligibility =
  | { allowed: true; kind: "owner" }
  | { allowed: true; kind: "entitled" }
  | { allowed: false; reason: "not_entitled" | "entitlement_unavailable" };

export function normalizeAuthEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function isCanonicalOwner(email: string, account: AuthAccount | null, ownerEmail: string | undefined | null): boolean {
  const owner = normalizeAuthEmail(ownerEmail);
  const e = normalizeAuthEmail(email);
  if (!owner || !e || e !== owner || !account) return false;
  return normalizeAuthEmail(account.email) === owner && account.role === "owner" && account.unlimited === true;
}

/** Whether this email may receive a sign-in link, or turn one into a session. */
export function decideLoginEligibility(input: {
  email: string;
  account: AuthAccount | null;
  ownerEmail: string | undefined | null;
  entitlement: EntitlementRead | null;
}): Eligibility {
  if (isCanonicalOwner(input.email, input.account, input.ownerEmail)) return { allowed: true, kind: "owner" };
  if (!input.entitlement || input.entitlement.state !== "ok") return { allowed: false, reason: "entitlement_unavailable" };
  return input.entitlement.entitled === true ? { allowed: true, kind: "entitled" } : { allowed: false, reason: "not_entitled" };
}

/* ---- abuse throttling ------------------------------------------------- */

export const THROTTLE = Object.freeze({
  windowSeconds: 15 * 60,
  perEmail: 3,
  perFingerprint: 10,
});

export function isThrottled(counts: { email: number; fingerprint: number }): boolean {
  return counts.email >= THROTTLE.perEmail || counts.fingerprint >= THROTTLE.perFingerprint;
}

/** One public response for every outcome of a valid-looking request, so the endpoint never reveals who is subscribed. */
export const GENERIC_LOGIN_RESPONSE = Object.freeze({
  ok: true,
  message: "If this email belongs to an active UFC Pro subscription, a secure sign-in link is on its way.",
});
