/* Fight DNA division context reader. The daily document lives in the PRIVATE
 * ufc-internal bucket and is read here with the service-role key, server-side
 * only. Callers decide who may see it (UFC Pro pages, the one public homepage
 * demo fighter). Fail-null: a missing or unreadable document renders nothing. */
import "server-only";
import { pickDivisionContext, type DnaDivisionContext } from "@/lib/dnaDivisionContextModel";

export type { DivisionRank, DnaDivisionContext } from "@/lib/dnaDivisionContextModel";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PATH = "ufc-internal/dna/division-context/latest.json";

export async function getDnaDivisionContext(fighterId: string): Promise<DnaDivisionContext | null> {
  if (!URL_ || !KEY || !fighterId) return null;
  try {
    const res = await fetch(`${URL_}/storage/v1/object/authenticated/${PATH}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return pickDivisionContext(await res.json(), fighterId);
  } catch (e) {
    console.error(`[dna-context] read failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return null;
  }
}
