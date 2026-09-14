import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getCurrentAccount, revokeSessionByRaw, SESSION_COOKIE } from "@/lib/auth";
import { readUfcEntitlement, ufcOwnerEmail } from "@/lib/entitlement";
import { decideUfcAccess, needsLedger, FREE_SIGNED_OUT, type LedgerRead, type UfcAccess } from "@/lib/accessDecision";

/* Server entry point for every UFC access decision. See lib/accessDecision.ts
 * (paid-only rule) and lib/authPolicy.ts. Deduplicated per request.
 *
 * Only the canonical owner and current ufc_pro subscribers hold a session. A
 * session belonging to anyone else is treated as signed out and, when the
 * billing Worker positively reports "not entitled", deleted on the spot. A
 * billing outage signs such a request out without deleting anything. */

async function resolve(withBilling: boolean): Promise<UfcAccess> {
  /* Reading the cookie store unconditionally makes every route that asks for
   * access dynamic, so a Pro render can never be cached and replayed. */
  const jar = await cookies();
  const account = await getCurrentAccount();
  if (!account) return FREE_SIGNED_OUT;
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
