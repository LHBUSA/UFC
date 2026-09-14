/* POST /api/ufc/house-promo
 *
 * First-party click event for PropBetEdge house promotions in articles.
 * Impressions are logged by the article render itself (components/StoryView),
 * so CTR = clicks / impressions per campaign without any client request on
 * page view. The site has no analytics vendor and this does not add one: a
 * validated event becomes one structured log line (Vercel runtime logs, filter
 * "house_promo_"). No cookie is read, nothing identifies the reader, and the
 * endpoint answers only POST under the robots-disallowed /api/, so it creates
 * no crawlable URL. */
import { PROMO_CAMPAIGN_IDS, PROMO_DESTINATIONS, PROMO_SLUG } from "@/lib/housePromo";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  if (raw.length > 512) return new Response(null, { status: 413 });
  let e: Record<string, unknown>;
  try { e = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  const { event, placement, campaign, dest, slug } = e;
  if (event !== "click" || placement !== "end") return new Response(null, { status: 400 });
  if (typeof campaign !== "string" || !PROMO_CAMPAIGN_IDS.has(campaign)) return new Response(null, { status: 400 });
  if (typeof dest !== "string" || !PROMO_DESTINATIONS.has(dest)) return new Response(null, { status: 400 });
  if (typeof slug !== "string" || !PROMO_SLUG.test(slug)) return new Response(null, { status: 400 });
  console.info(JSON.stringify({ evt: "house_promo_click", campaign, placement, dest, slug, at: new Date().toISOString() }));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
