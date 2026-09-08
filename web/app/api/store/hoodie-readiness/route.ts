import { NextResponse } from "next/server";
import {
  getPrintAreas,
  getProductDetail,
  getVariants,
  isConfigured,
  listCatalog,
  resolveStoreContext,
} from "@/lib/store/printful";

/**
 * TEMPORARY read-only release probe for the first PropBetEdge hoodie.
 *
 * This route intentionally exposes no credential, provider store id/name,
 * costs, customer data or write capability. It exists only long enough to
 * resolve the exact Cotton Heritage M2580 blank, Black S-2XL catalog variants,
 * and provider-reported print placements/dimensions in the production runtime
 * where the Sensitive Printful token is available. Remove after the release
 * facts have been committed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZES = ["S", "M", "L", "XL", "2XL"] as const;

export async function GET() {
  const env = {
    printful: isConfigured(),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    stripe_webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    fulfill_gate: Boolean(process.env.STORE_FULFILL_TOKEN),
  };

  if (!env.printful) {
    return NextResponse.json({ ok: false, env, error: "PRINTFUL_NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const ctx = await resolveStoreContext();
    if (!ctx.ok) {
      return NextResponse.json(
        { ok: false, env, provider_store_resolved: false, error: "PROVIDER_STORE_NOT_RESOLVED" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
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
          env,
          provider_store_resolved: true,
          error: exact.length ? "HOODIE_BLANK_AMBIGUOUS" : "HOODIE_BLANK_NOT_FOUND",
          candidates: exact.map((p) => ({ id: p.id, brand: p.brand, model: p.model, type: p.type })),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
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
    for (const size of SIZES) {
      const hit = variants.find((v) =>
        String(v.color || "").trim().toLowerCase() === "black" &&
        String(v.size || "").trim().toLowerCase() === size.toLowerCase(),
      );
      if (hit) black[size] = hit.id;
      else missing.push(size);
    }

    return NextResponse.json(
      {
        ok: missing.length === 0,
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
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, env, error: "PROVIDER_READ_FAILED", detail: String((e as Error)?.message || e).slice(0, 160) },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
