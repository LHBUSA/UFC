import { getAlgoFreeSample } from "@/lib/algo";

export const dynamic = "force-dynamic";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "x-content-type-options": "nosniff",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

export async function GET() {
  try {
    const body = await getAlgoFreeSample();
    if (body.pick?.pick_fighter_id) {
      try {
        const mediaRes = await fetch(
          `https://ufc-api.propbetedge.ai/v1/ufc/fighters/${encodeURIComponent(body.pick.pick_fighter_id)}?include=media`,
          { headers: { accept: "application/json" }, next: { revalidate: 3600 } },
        );
        if (mediaRes.ok) {
          const mediaBody = await mediaRes.json();
          const primary = mediaBody?.data?.primary_image ?? null;
          body.pick = {
            ...body.pick,
            fighter_image: primary
              ? {
                  image_url: primary.image_url ?? null,
                  card_url: primary.card_url ?? null,
                  thumb_url: primary.thumb_url ?? null,
                  attribution_text: primary.attribution_text ?? null,
                  source_url: primary.source_url ?? null,
                  license: primary.license ?? null,
                }
              : null,
          };
        }
      } catch {
        body.pick = { ...body.pick, fighter_image: null };
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
  } catch (error) {
    console.error("[ufc-free-sample]", error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      contract: "pbe-free-sample-v1",
      sport: "UFC",
      generated_at: new Date().toISOString(),
      pick: null,
      full_product_url: "https://ufc.propbetedge.ai/algo",
    }), { status: 503, headers: HEADERS });
  }
}
