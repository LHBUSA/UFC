import { NextResponse } from "next/server";
import {
  getPrintAreas,
  getProductDetail,
  getVariants,
  isConfigured,
  listCatalog,
  resolveStoreContext,
} from "@/lib/store/printful";
import { DROP001_SIZES, drop001RuntimeStatus } from "@/lib/store/release";

/** Temporary, read-only Drop 001 readiness probe. No secret value, store id,
 * provider cost or customer data is returned. Remove after the first release
 * facts are committed and the paid acceptance order has passed. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const release = drop001RuntimeStatus();
  const env = release.checks;

  if (!isConfigured()) {
    return NextResponse.json({ ok: false, runtime_ready: false, env, error: "PRINTFUL_NOT_CONFIGURED" }, { status: 503, headers: noStore });
  }

  try {
    const ctx = await resolveStoreContext();
    if (!ctx.ok) {
      return NextResponse.json({ ok: false, runtime_ready: release.ready, env, provider_store_resolved: false, error: "PROVIDER_STORE_NOT_RESOLVED" }, { status: 503, headers: noStore });
    }

    const catalog = await listCatalog();
    const exact = catalog.filter((p) =>
      String(p.model || "").trim().toLowerCase() === "m2580" &&
      String(p.brand || "").toLowerCase().includes("cotton heritage"),
    );
    if (exact.length !== 1) {
      return NextResponse.json(
        {
          ok: false,
          runtime_ready: release.ready,
          env,
          provider_store_resolved: true,
          error: exact.length ? "HOODIE_BLANK_AMBIGUOUS" : "HOODIE_BLANK_NOT_FOUND",
          candidates: exact.map((p) => ({ id: p.id, brand: p.brand, model: p.model, type: p.type })),
        },
        { status: 409, headers: noStore },
      );
    }

    const product = exact[0];
    const [detail, variants, printAreas] = await Promise.all([
      getProductDetail(product.id),
      getVariants(product.id),
      getPrintAreas(product.id, ctx.selected.id),
    ]);
    const black: Record<string, number> = {};
    const missing: string[] = [];
    for (const size of DROP001_SIZES) {
      const hit = variants.find((v) =>
        String(v.color || "").trim().toLowerCase() === "black" &&
        String(v.size || "").trim().toLowerCase() === size.toLowerCase(),
      );
      if (hit) black[size] = hit.id;
      else missing.push(size);
    }

    const placements = new Set(printAreas.map((p) => p.placement));
    const placementReady = placements.has("front") && placements.has("sleeve_right");
    const variantsReady = missing.length === 0;

    return NextResponse.json(
      {
        ok: release.ready && variantsReady && placementReady,
        runtime_ready: release.ready,
        variants_ready: variantsReady,
        placements_ready: placementReady,
        env,
        provider_store_resolved: true,
        hoodie: {
          catalog_product_id: product.id,
          brand: product.brand,
          model: product.model,
          title: detail.title || product.title,
          type: product.type,
          black_variants: black,
          missing_black_sizes: missing,
          print_areas: printAreas,
        },
      },
      { headers: noStore },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, runtime_ready: release.ready, env, error: "PROVIDER_READ_FAILED", detail: String((e as Error)?.message || e).slice(0, 160) },
      { status: 502, headers: noStore },
    );
  }
}
