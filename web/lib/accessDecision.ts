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
 * Valid Pro during the Stripe transition, in order:
 *   1. owner / unlimited
 *   2. legacy ufc_accounts.plan = "pro" with no expiry or an unexpired one
 *   3. ufc_pro in pbe_sport_entitlements (active/trialing, period end in the
 *      future — decided by pbe_has_sport_entitlement, not re-derived here)
 *
 * A Stripe redirect, a query string, a session_id or anything else the browser
 * sends grants nothing. Pro unlocks proprietary analysis that exists; it never
 * makes unavailable model output appear.
 */

export type AccessTier = "free" | "pro" | "owner";

export type AccountInput = {
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
  source: "owner" | "legacy" | "stripe" | null;
  /** Legacy plan expiry when legacy access is what grants Pro. */
  legacyAccessThrough: string | null;
  /** The newest ledger subscription for this email, entitled or not, for the account page. */
  subscription: LedgerSubscription | null;
  ledger: LedgerRead["state"];
};

export const FREE_SIGNED_OUT: UfcAccess = Object.freeze({
  tier: "free", pro: false, signedIn: false, source: null, legacyAccessThrough: null, subscription: null, ledger: "skipped",
});

export function isOwner(account: AccountInput | null): boolean {
  return Boolean(account && (account.unlimited === true || account.role === "owner" || account.plan === "owner"));
}

export function legacyProActive(account: AccountInput | null, now: number): boolean {
  if (!account || account.plan !== "pro") return false;
  if (!account.access_expires_at) return true;
  const t = Date.parse(account.access_expires_at);
  return Number.isFinite(t) && t > now;
}

/** Whether the ledger must be consulted at all (owner and legacy Pro never need it to be Pro). */
export function needsLedger(account: AccountInput | null, now: number): boolean {
  return Boolean(account) && !isOwner(account) && !legacyProActive(account, now);
}

export function decideUfcAccess(account: AccountInput | null, ledger: LedgerRead, now: number): UfcAccess {
  if (!account) return FREE_SIGNED_OUT;
  const subscription = ledger.state === "ok" ? ledger.subscription : null;
  if (isOwner(account)) {
    return { tier: "owner", pro: true, signedIn: true, source: "owner", legacyAccessThrough: null, subscription, ledger: ledger.state };
  }
  if (ledger.state === "ok" && ledger.entitled === true) {
    return { tier: "pro", pro: true, signedIn: true, source: "stripe", legacyAccessThrough: null, subscription, ledger: ledger.state };
  }
  if (legacyProActive(account, now)) {
    return { tier: "pro", pro: true, signedIn: true, source: "legacy", legacyAccessThrough: account.access_expires_at, subscription, ledger: ledger.state };
  }
  return { tier: "free", pro: false, signedIn: true, source: null, legacyAccessThrough: null, subscription, ledger: ledger.state };
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
