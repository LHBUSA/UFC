/* The UFC access decision.
 *
 * ONE function decides whether a request may receive UFC Pro data. Every
 * premium module and API asks lib/access.ts, which asks this. Pure and free of
 * I/O so the rule itself is testable; the inputs are gathered server-side and
 * none of them can come from the browser:
 *
 *   account  the UFC account behind a verified HttpOnly session cookie
 *   ledger   the shared PropBetEdge entitlement ledger, read through the
 *            Cloudflare billing Worker with a server-held token
 *
 * Valid access (paid-only; see lib/authPolicy.ts):
 *   1. the canonical owner (UFC_OWNER_EMAIL and the owner row, both)
 *   2. ufc_pro in pbe_sport_entitlements (active/trialing, period end in the
 *      future — decided by pbe_has_sport_entitlement, not re-derived here)
 * There is no legacy ufc_accounts.plan='pro' grant and no free member.
 *
 * A Stripe redirect, a query string, a session_id or anything else the browser
 * sends grants nothing. Pro unlocks proprietary analysis that exists; it never
 * makes unavailable model output appear.
 */

import { isCanonicalOwner } from "./authPolicy.ts";

export type AccessTier = "free" | "pro" | "owner";

export type AccountInput = {
  id?: string;
  email: string;
  role: string | null;
  plan: string | null;
  unlimited: boolean | null;
  access_expires_at: string | null;
};

export type LedgerSubscription = {
  plan: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type LedgerRead =
  | { state: "ok"; entitled: boolean; subscription: LedgerSubscription | null }
  | { state: "unavailable" }
  | { state: "skipped" };

export type UfcAccess = {
  tier: AccessTier;
  pro: boolean;
  signedIn: boolean;
  source: "owner" | "stripe" | null;
  /** The ledger subscription behind a Stripe grant, for the account page. */
  subscription: LedgerSubscription | null;
  ledger: LedgerRead["state"];
  /** True when the session belongs to a non-owner with no current entitlement:
   *  the caller must revoke it. Never set when the ledger was unreachable. */
  revokeSession: boolean;
};

export const FREE_SIGNED_OUT: UfcAccess = Object.freeze({
  tier: "free", pro: false, signedIn: false, source: null, subscription: null, ledger: "skipped", revokeSession: false,
});

export function isOwner(account: AccountInput | null, ownerEmail: string | undefined | null): boolean {
  if (!account) return false;
  return isCanonicalOwner(account.email, { id: account.id || "", email: account.email, role: account.role, plan: account.plan, unlimited: account.unlimited }, ownerEmail);
}

/** The ledger must be consulted for every signed-in account except the canonical owner. */
export function needsLedger(account: AccountInput | null, ownerEmail: string | undefined | null): boolean {
  return Boolean(account) && !isOwner(account, ownerEmail);
}

/* Paid-only: a session is only a session for the canonical owner or a current
 * ufc_pro entitlement. Anything else (free rows, legacy plan='pro', a row
 * flagged owner/unlimited under another email, a lapsed subscription) is signed
 * out, and its session is revoked when the ledger positively says "not entitled". */
export function decideUfcAccess(account: AccountInput | null, ledger: LedgerRead, ownerEmail: string | undefined | null): UfcAccess {
  if (!account) return FREE_SIGNED_OUT;
  if (isOwner(account, ownerEmail)) {
    return { tier: "owner", pro: true, signedIn: true, source: "owner", subscription: ledger.state === "ok" ? ledger.subscription : null, ledger: ledger.state, revokeSession: false };
  }
  if (ledger.state === "ok" && ledger.entitled === true) {
    return { tier: "pro", pro: true, signedIn: true, source: "stripe", subscription: ledger.subscription, ledger: ledger.state, revokeSession: false };
  }
  return { ...FREE_SIGNED_OUT, ledger: ledger.state, revokeSession: ledger.state === "ok" };
}

/* ---- Stripe return copy ------------------------------------------------ */

export type CheckoutReturn = { success: boolean; plan: "monthly" | "weekly" | null };

/** Display-only parse of ?checkout=success&plan=… — it selects copy, never access. */
export function parseCheckoutReturn(params: Record<string, string | string[] | undefined>): CheckoutReturn {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";
  const success = one(params.checkout) === "success";
  const plan = one(params.plan);
  return { success, plan: success && (plan === "monthly" || plan === "weekly") ? plan : null };
}

export type ReturnState = "not_returning" | "sign_in" | "active" | "verifying";

export function checkoutReturnState(ret: CheckoutReturn, access: UfcAccess): ReturnState {
  if (!ret.success) return "not_returning";
  if (!access.signedIn) return "sign_in";
  return access.pro ? "active" : "verifying";
}

/* ---- CTA --------------------------------------------------------------- */

/** Where a locked module's "Unlock UFC Pro" goes: signed-out readers carry their return path. */
export function unlockHref(access: Pick<UfcAccess, "signedIn">, returnPath: string | null): string {
  if (access.signedIn || !returnPath || !returnPath.startsWith("/") || returnPath.startsWith("//")) return "/pro";
  return `/pro?next=${encodeURIComponent(returnPath)}`;
}
