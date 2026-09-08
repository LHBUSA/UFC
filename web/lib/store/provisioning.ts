/**
 * Read side of the provisioning state.
 *
 * The storefront asks one question of this module: has the provider confirmed
 * this product exists? Everything else in the row — costs, variant ids, the
 * claim, the error text — is read here and goes no further, because
 * `toStorefront` is the only thing allowed to cross into a page.
 *
 * Like the rest of the data layer, a missing env var, an absent table or a
 * network failure yields an EMPTY result and a log line. A store that cannot
 * reach its provisioning table renders as "not yet released", which is the
 * honest reading: we cannot confirm anything, so we offer nothing.
 */
import "server-only";
import type { ProvisionRecord, ProvisionState } from "./types";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/* Short. Provisioning changes rarely, but when it does the difference is a
 * product becoming buyable, and a five-minute stale window on that is longer
 * than anyone wants to explain. */
export const REVALIDATE = 60;

export function provisioningConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

type Row = {
  slug: string;
  state: string;
  provider_store_id: number | null;
  provider_product_id: number | null;
  provider_variant_ids: Record<string, number> | null;
  provider_costs: Record<string, number> | null;
  print_areas: Record<string, { width: number; height: number }> | null;
  reconciled_at: string | null;
  reconcile_note: string | null;
  last_error: string | null;
  attempts: number | null;
  updated_at: string | null;
};

const STATES: ProvisionState[] = ["unclaimed", "in_flight", "created", "failed", "uncertain"];

function normalise(r: Row): ProvisionRecord {
  return {
    slug: r.slug,
    state: (STATES.includes(r.state as ProvisionState) ? r.state : "unclaimed") as ProvisionState,
    provider_store_id: r.provider_store_id ?? null,
    provider_product_id: r.provider_product_id ?? null,
    provider_variant_ids: r.provider_variant_ids ?? {},
    provider_costs: r.provider_costs ?? {},
    print_areas: r.print_areas ?? {},
    reconciled_at: r.reconciled_at ?? null,
    reconcile_note: r.reconcile_note ?? null,
    last_error: r.last_error ?? null,
    attempts: r.attempts ?? 0,
    updated_at: r.updated_at ?? null,
  };
}

/**
 * Provisioning rows by slug. Empty map when unconfigured or unreachable —
 * never a throw, so a store page renders its shell either way.
 */
export async function getProvisioning(): Promise<Map<string, ProvisionRecord>> {
  const out = new Map<string, ProvisionRecord>();
  if (!provisioningConfigured()) return out;
  try {
    const res = await fetch(`${URL_}/rest/v1/store_provisioning?select=*`, {
      headers: headers(),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) {
      console.error(`[store] provisioning -> HTTP ${res.status}`);
      return out;
    }
    const text = await res.text();
    const rows: Row[] = text ? JSON.parse(text) : [];
    for (const r of rows) if (r?.slug) out.set(r.slug, normalise(r));
    return out;
  } catch (e) {
    console.error(`[store] provisioning failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return out;
  }
}

/**
 * Whether anything at all is purchasable. Drives the store's own banner, so
 * the page states its condition rather than letting a reader discover it at
 * the button.
 */
export function anyPurchasable(recs: Map<string, ProvisionRecord>): boolean {
  for (const r of recs.values()) {
    if (r.state === "created" && r.provider_product_id && Object.keys(r.provider_variant_ids).length) return true;
  }
  return false;
}
