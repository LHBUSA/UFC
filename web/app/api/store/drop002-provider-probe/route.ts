import { NextResponse } from "next/server";
import { getPrintAreas, getProductDetail, getVariants, listCatalog, resolveStoreContext } from "@/lib/store/printful";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview" || process.env.VERCEL_GIT_COMMIT_REF !== "store-checkout-products-v1") {
    return NextResponse.json({ error: "preview only" }, { status: 404 });
  }

  const ctx = await resolveStoreContext();
  if (!ctx.ok) return NextResponse.json({ error: "store context unresolved", stores: ctx.stores.map((s) => ({ id: s.id, name: s.name })) }, { status: 409 });

  const catalog = await listCatalog();
  const tee = catalog.find((p) => String(p.model || "").toLowerCase() === "3001" && /bella|unisex staple/i.test(`${p.brand || ""} ${p.title || ""}`));
  const mugHits = catalog.filter((p) => /black.*glossy.*mug|glossy.*black.*mug/i.test(`${p.brand || ""} ${p.model || ""} ${p.title || ""} ${p.type || ""}`));

  const inspect = async (id: number | undefined) => {
    if (!id) return null;
    const [detail, variants, areas] = await Promise.all([
      getProductDetail(id),
      getVariants(id),
      getPrintAreas(id, ctx.selected.id),
    ]);
    return {
      product: { id, title: detail.title, model: catalog.find((p) => p.id === id)?.model ?? null, type: catalog.find((p) => p.id === id)?.type ?? null },
      variants: variants.map((v) => ({ id: v.id, name: v.name, size: v.size, color: v.color, in_stock: v.inStock, price: v.price })),
      print_areas: areas,
    };
  };

  return NextResponse.json({
    store: { id: ctx.selected.id, name: ctx.selected.name },
    tee: await inspect(tee?.id),
    mug_candidates: mugHits.map((p) => ({ id: p.id, title: p.title, brand: p.brand, model: p.model, type: p.type })),
    mugs: await Promise.all(mugHits.slice(0, 8).map((p) => inspect(p.id))),
  }, { headers: { "Cache-Control": "no-store" } });
}
