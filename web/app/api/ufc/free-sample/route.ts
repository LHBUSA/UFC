import { getAlgoFreeSample } from "@/lib/algo";
import { getFighters, getImagesForFighters } from "@/lib/db";
import { espnVerifiedPortrait } from "@/lib/espnPortraitGate";

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

async function pickMedia(name: string) {
  const { rows } = await getFighters(name, 10, 0);
  const normalized = name.trim().toLowerCase();
  const fighter = rows.find((row) => row.name.trim().toLowerCase() === normalized) || null;
  if (!fighter) return null;

  const stored = (await getImagesForFighters([fighter.id]).catch(() => new Map())).get(fighter.id) || null;
  const portrait = stored || await espnVerifiedPortrait(fighter, null).catch(() => null);
  if (!portrait) return null;

  return {
    image_url: portrait.card || portrait.portrait,
    thumb_url: portrait.thumb || portrait.card || portrait.portrait,
    attribution_text: portrait.attribution_text
      || [portrait.author, portrait.license].filter(Boolean).join(" · ")
      || null,
    source_url: portrait.source_url || null,
    display_policy: portrait.source_family === "espn" || portrait.kind === "display_fallback"
      ? "display_only"
      : "stored_asset",
  };
}

export async function GET() {
  try {
    const body = await getAlgoFreeSample();
    const media = body.pick?.pick_name ? await pickMedia(body.pick.pick_name) : null;
    const enriched = body.pick ? { ...body, pick: { ...body.pick, media } } : body;
    return new Response(JSON.stringify(enriched), { status: 200, headers: HEADERS });
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
