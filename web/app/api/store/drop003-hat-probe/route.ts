import { NextResponse } from "next/server";
import { getPrintAreas, getProductDetail, getVariants, listCatalog, resolveStoreContext } from "@/lib/store/printful";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ error: "production only" }, { status: 404 });
  const ctx = await resolveStoreContext();
  if (!ctx.ok) return NextResponse.json({ error: "store unresolved" }, { status: 409 });

  const catalog = await listCatalog();
  const embroidery = catalog.filter((p) => String(p.type || "").toUpperCase() === "EMBROIDERY");
  const rows = [];

  for (const p of embroidery) {
    const detail = await getProductDetail(p.id);
    if (!/\b(hat|cap|snapback|trucker)\b/i.test(detail.title)) continue;
    const [variants, areas] = await Promise.all([
      getVariants(p.id),
      getPrintAreas(p.id, ctx.selected.id),
    ]);
    const black = variants
      .filter((v) => /black/i.test(String(v.color || "")))
      .map((v) => ({ id: v.id, size: v.size, color: v.color, name: v.name, in_stock: v.inStock, price: v.price }));
    rows.push({
      id: p.id,
      title: detail.title,
      brand: p.brand,
      model: p.model,
      variants: black,
      print_areas: areas,
    });
  }

  return NextResponse.json({ store: { id: ctx.selected.id, name: ctx.selected.name }, count: rows.length, rows }, { headers: { "Cache-Control": "no-store" } });
}
