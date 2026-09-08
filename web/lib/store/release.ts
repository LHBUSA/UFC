import "server-only";

export const DROP001_SLUG = "propbetedge-hoodie";
export const DROP001_COLOR = "Black";
export const DROP001_SIZES = ["S", "M", "L", "XL", "2XL"] as const;

export function drop001RuntimeStatus() {
  const checks = {
    printful: Boolean(process.env.PRINTFUL_API_TOKEN),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    stripe_webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    fulfill_gate: Boolean(process.env.CRON_SECRET || process.env.STORE_FULFILL_TOKEN),
    hoodie_front_art: Boolean(process.env.STORE_HOODIE_FRONT_FILE_URL),
    hoodie_sleeve_art: Boolean(process.env.STORE_HOODIE_SLEEVE_FILE_URL),
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

export function drop001ArtFiles() {
  const front = process.env.STORE_HOODIE_FRONT_FILE_URL || "";
  const sleeve = process.env.STORE_HOODIE_SLEEVE_FILE_URL || "";
  return {
    ready: Boolean(front && sleeve),
    front,
    sleeve,
    missing: [!front && "STORE_HOODIE_FRONT_FILE_URL", !sleeve && "STORE_HOODIE_SLEEVE_FILE_URL"].filter(Boolean) as string[],
  };
}

export function isDrop001Line(slug: string, color: string): boolean {
  return slug === DROP001_SLUG && color === DROP001_COLOR;
}
