import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getCurrentAccount, revokeSessionByRaw, SESSION_COOKIE } from "@/lib/auth";
import { readUfcEntitlement, ufcOwnerEmail } from "@/lib/entitlement";
import { decideUfcAccess, needsLedger, FREE_SIGNED_OUT, type LedgerRead, type UfcAccess } from "@/lib/accessDecision";
import { readMembership } from "@/lib/pbe-membership.js";

/* Server entry point for every UFC access decision. See lib/accessDecision.ts
 * (paid-only rule) and lib/authPolicy.ts. Deduplicated per request.
 *
 * Only the canonical owner and current ufc_pro subscribers hold a session. A
 * session belonging to anyone else is treated as signed out and, when the
 * billing Worker positively reports "not entitled", deleted on the spot. A
 * billing outage signs such a request out without deleting anything. */

async function networkAccess(jar: Awaited<ReturnType<typeof cookies>>): Promise<UfcAccess | null> {
  const token = jar.get("pbe_session")?.value;
  if (!token) return null;
  try {
    const r = await fetch("https://auth.propbetedge.ai/membership?sport=ufc", {
      headers: { cookie: `pbe_session=${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const body = await r.json();
    const membership = readMembership(body?.membership, "ufc");
    if (!body?.authenticated || !membership.entitled || !["all_access", "owner"].includes(membership.state)) return null;
    return {
      tier: membership.state === "owner" ? "owner" : "pro",
      pro: true,
      signedIn: true,
      source: "network",
      subscription: membership.state === "all_access" ? {
        plan: membership.plan || null,
        status: "active",
        current_period_end: membership.current_period_end || null,
        cancel_at_period_end: Boolean(membership.cancel_at_period_end),
        product_key: membership.product_key || "pbe_all_access",
      } : null,
      membership,
      ledger: "skipped",
      revokeSession: false,
    };
  } catch {
    return null;
  }
}

async function resolve(withBilling: boolean): Promise<UfcAccess> {
  /* Reading the cookie store unconditionally makes every route that asks for
   * access dynamic, so a Pro render can never be cached and replayed. */
  const jar = await cookies();
  const account = await getCurrentAccount();
  if (!account) return (await networkAccess(jar)) || FREE_SIGNED_OUT;
  const owner = ufcOwnerEmail();
  const ledger: LedgerRead = withBilling || needsLedger(account, owner) ? await readUfcEntitlement(account.email) : { state: "skipped" };
  const access = decideUfcAccess(account, ledger, owner);
  if (access.revokeSession) {
    await revokeSessionByRaw(jar.get(SESSION_COOKIE)?.value);
    console.warn("[access] revoked a session with no owner status and no ufc_pro entitlement");
  }
  return access;
}

/** The access decision for gating content. */
export const getUfcAccess = cache(() => resolve(false));

/** Same decision, always carrying the ledger subscription (account page). */
export const getUfcAccessWithBilling = cache(() => resolve(true));

export type { UfcAccess };
