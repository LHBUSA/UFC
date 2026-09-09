import { NextResponse } from "next/server";
import { getPrintAreas, getProductDetail, getVariants, listCatalog, resolveStoreContext } from "@/lib/store/printful";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ error: "production only" }, { status: 404 });
  const ctx = await resolveStoreContext();
  if (!ctx.ok) return NextResponse.json({ error: "store unresolved" }, { status: 409 });
  const catalog = await listCatalog();
  const hits = catalog.filter((p) => /otto|hat|cap|snapback|trucker|headwear/i.test(`${p.brand || ""} ${p.title} ${p.model || ""} ${p.type || ""}`)).slice(0, 40);
  const rows = [];
  for (const p of hits) {
    const [detail, variants, areas] = await Promise.all([
      getProductDetail(p.id),
      getVariants(p.id),
      getPrintAreas(p.id, ctx.selected.id),
    ]);
    rows.push({
      id: p.id,
      title: detail.title,
      brand: p.brand,
      model: p.model,
      type: p.type,
      variants: variants.filter((v) => /black/i.test(String(v.color || ""))).map((v) => ({ id: v.id, size: v.size, color: v.color, name: v.name, in_stock: v.inStock, price: v.price })),
      print_areas: areas,
    });
  }
  return NextResponse.json({ store: { id: ctx.selected.id, name: ctx.selected.name }, rows }, { headers: { "Cache-Control": "no-store" } });
}
