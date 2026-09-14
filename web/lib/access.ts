import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getCurrentAccount } from "@/lib/auth";
import {
  decideUfcAccess, needsLedger, FREE_SIGNED_OUT,
  type LedgerRead, type LedgerSubscription, type UfcAccess,
} from "@/lib/accessDecision";

/* Server entry point for every UFC Pro decision. See lib/accessDecision.ts for
 * the rule. Deduplicated per request, so a page and its header ask once.
 *
 * The ledger lives in the shared PropBetEdge Supabase project behind the
 * Cloudflare billing Worker (propbetedge-sports-billing POST /v1/entitlement).
 * This server holds a read token for it; the browser never sees the token, the
 * ledger, or any Stripe identifier. If the read fails, Stripe-granted Pro fails
 * closed for that request while owner and legacy access still work. */

const BILLING_URL = (process.env.PBE_BILLING_URL || "https://propbetedge-sports-billing.sales-fd3.workers.dev").replace(/\/$/, "");
const PRODUCT_KEY = "ufc_pro";
const TIMEOUT_MS = 2500;

async function readLedger(email: string): Promise<LedgerRead> {
  const token = process.env.PBE_ENTITLEMENT_READ_TOKEN || "";
  if (!token) return { state: "unavailable" };
  try {
    const res = await fetch(`${BILLING_URL}/v1/entitlement`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, product_key: PRODUCT_KEY }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[access] entitlement read HTTP ${res.status}`);
      return { state: "unavailable" };
    }
    const body = (await res.json()) as { entitled?: unknown; product_key?: unknown; subscription?: LedgerSubscription | null };
    if (body.product_key !== PRODUCT_KEY || typeof body.entitled !== "boolean") return { state: "unavailable" };
    return { state: "ok", entitled: body.entitled, subscription: body.subscription ?? null };
  } catch (error) {
    console.error("[access] entitlement read failed", String((error as Error)?.message || error).slice(0, 160));
    return { state: "unavailable" };
  }
}

async function resolve(withBilling: boolean): Promise<UfcAccess> {
  /* Reading the cookie store unconditionally makes every route that asks for
   * access dynamic, so a Pro render can never be cached and replayed to
   * another reader. */
  await cookies();
  const account = await getCurrentAccount();
  if (!account) return FREE_SIGNED_OUT;
  const now = Date.now();
  /* Owner and legacy Pro need no network hop to be Pro. */
  const ledger: LedgerRead = withBilling || needsLedger(account, now) ? await readLedger(account.email) : { state: "skipped" };
  return decideUfcAccess(account, ledger, now);
}

/** The access decision for gating content. */
export const getUfcAccess = cache(() => resolve(false));

/** Same decision, always carrying the ledger subscription (account page). */
export const getUfcAccessWithBilling = cache(() => resolve(true));

export type { UfcAccess };
