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
