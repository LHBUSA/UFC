/* POST /api/ufc/house-promo
 *
 * First-party click event for PropBetEdge house promotions in articles. The
 * site has no analytics vendor and this does not add one: a validated event is
 * written as one structured log line (Vercel runtime logs, filter
 * "house_promo_click") and nothing else. No cookie is read, no identifier is
 * stored, and the response carries nothing. /api/ is disallowed in robots.txt,
 * and the endpoint answers only POST, so it creates no crawlable URL. */
import { PROMO_DESTINATIONS, PROMO_SLUG } from "@/lib/housePromo";

export const dynamic = "force-dynamic";

const PLACEMENTS = new Set(["inline", "end"]);

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  if (raw.length > 512) return new Response(null, { status: 413 });
  let e: { placement?: unknown; dest?: unknown; slug?: unknown };
  try { e = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  const { placement, dest, slug } = e;
  if (typeof placement !== "string" || !PLACEMENTS.has(placement)) return new Response(null, { status: 400 });
  if (typeof dest !== "string" || !PROMO_DESTINATIONS.has(dest)) return new Response(null, { status: 400 });
  if (typeof slug !== "string" || !PROMO_SLUG.test(slug)) return new Response(null, { status: 400 });
  console.info(JSON.stringify({ evt: "house_promo_click", placement, dest, slug, at: new Date().toISOString() }));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
