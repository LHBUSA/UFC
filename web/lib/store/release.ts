import "server-only";
import type { ProvisionRecord } from "./types";
import { variantKey } from "./types";

export const DROP001_SLUG = "propbetedge-hoodie";
export const DROP001_COLOR = "Black";
export const DROP001_SIZES = ["S", "M", "L", "XL", "2XL"] as const;

const DEFAULT_DROP001_FRONT_ART = "https://ufc.propbetedge.ai/store/print/drop001-front";
const DEFAULT_DROP001_SLEEVE_ART = "https://ufc.propbetedge.ai/store/print/drop001-sleeve-right";

export function drop001ArtFiles() {
  const front = process.env.STORE_HOODIE_FRONT_FILE_URL || DEFAULT_DROP001_FRONT_ART;
  const sleeve = process.env.STORE_HOODIE_SLEEVE_FILE_URL || DEFAULT_DROP001_SLEEVE_ART;
  return {
    ready: Boolean(front && sleeve),
    front,
    sleeve,
    missing: [!front && "STORE_HOODIE_FRONT_FILE_URL", !sleeve && "STORE_HOODIE_SLEEVE_FILE_URL"].filter(Boolean) as string[],
  };
}

export function drop001RuntimeStatus() {
  const art = drop001ArtFiles();
  const checks = {
    printful: Boolean(process.env.PRINTFUL_API_TOKEN),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    stripe_webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    fulfill_gate: Boolean(process.env.CRON_SECRET || process.env.STORE_FULFILL_TOKEN),
    hoodie_front_art: Boolean(art.front),
    hoodie_sleeve_art: Boolean(art.sleeve),
  };
  const envName: Record<keyof typeof checks, string> = {
    printful: "PRINTFUL_API_TOKEN",
    stripe: "STRIPE_SECRET_KEY",
    stripe_webhook: "STRIPE_WEBHOOK_SECRET",
    supabase: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY",
    fulfill_gate: "CRON_SECRET/STORE_FULFILL_TOKEN",
    hoodie_front_art: "STORE_HOODIE_FRONT_FILE_URL",
    hoodie_sleeve_art: "STORE_HOODIE_SLEEVE_FILE_URL",
  };
  const missing = (Object.entries(checks) as Array<[keyof typeof checks, boolean]>)
    .filter(([, ok]) => !ok)
    .map(([name]) => envName[name]);
  return { ready: missing.length === 0, checks, missing };
}

/**
 * Drop 001 is fulfilled directly from Printful's catalog variant ids plus our
 * production files. A separately-created sync product is not required for an
 * order, so the sale gate is the thing fulfillment actually needs: a recent
 * provider reconciliation and every exact Black S-2XL variant id.
 *
 * `unclaimed` is valid here because it means no sync-product creation claim is
 * active; it does not mean the catalog variants are unknown. Failed,
 * uncertain, and in-flight rows remain fail-closed.
 */
export function drop001ProvisioningReady(rec: ProvisionRecord | null | undefined): boolean {
  if (!rec || !rec.reconciled_at) return false;
  if (rec.state !== "unclaimed" && rec.state !== "created") return false;
  return DROP001_SIZES.every((size) => {
    const id = rec.provider_variant_ids?.[variantKey(size, DROP001_COLOR)];
    return typeof id === "number" && Number.isInteger(id) && id > 0;
  });
}

export function isDrop001Line(slug: string, color: string): boolean {
  return slug === DROP001_SLUG && color === DROP001_COLOR;
}
