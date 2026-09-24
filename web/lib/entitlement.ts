import "server-only";
import type { LedgerRead, LedgerSubscription } from "@/lib/accessDecision";

/* Server-to-server read of the shared PropBetEdge entitlement ledger through the
 * Cloudflare billing Worker (propbetedge-sports-billing POST /v1/entitlement).
 * The only source of truth for a UFC Pro subscription. Any failure is
 * "unavailable", which every caller treats as NOT entitled (fail closed). */

const BILLING_URL = (process.env.PBE_BILLING_URL || "https://propbetedge-sports-billing.sales-fd3.workers.dev").replace(/\/$/, "");
const PRODUCT_KEY = "ufc_pro";
const TIMEOUT_MS = 2500;

export async function readUfcEntitlement(email: string): Promise<Exclude<LedgerRead, { state: "skipped" }>> {
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
      console.error(`[entitlement] read HTTP ${res.status}`);
      return { state: "unavailable" };
    }
    /* The verdict body: the top-level product_key must echo what we asked for,
     * `access_source` says WHICH grant is behind `entitled` ('sport' = ufc_pro
     * itself, 'all_access' = the network umbrella, 'owner'), and
     * subscription.product_key names the product actually subscribed. Both are
     * kept for the shared membership contract; neither decides access here. */
    const body = (await res.json()) as { entitled?: unknown; product_key?: unknown; access_source?: unknown; subscription?: LedgerSubscription | null };
    if (body.product_key !== PRODUCT_KEY || typeof body.entitled !== "boolean") return { state: "unavailable" };
    const accessSource = body.access_source === "sport" || body.access_source === "all_access" || body.access_source === "owner" ? body.access_source : null;
    const subscription = body.subscription && typeof body.subscription === "object"
      ? { ...body.subscription, product_key: typeof body.subscription.product_key === "string" ? body.subscription.product_key : null }
      : null;
    return { state: "ok", entitled: body.entitled, accessSource, subscription };
  } catch (error) {
    console.error("[entitlement] read failed", String((error as Error)?.message || error).slice(0, 160));
    return { state: "unavailable" };
  }
}

export function ufcOwnerEmail(): string | undefined {
  return process.env.UFC_OWNER_EMAIL || undefined;
}
