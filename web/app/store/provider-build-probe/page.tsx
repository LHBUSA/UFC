import "server-only";
import { getPrintAreas, getProductDetail, getVariants, listCatalog, resolveStoreContext } from "@/lib/store/printful";

export const dynamic = "force-static";
export const revalidate = false;

export default async function ProviderBuildProbe() {
  const ctx = await resolveStoreContext();
  if (!ctx.ok) {
    console.log(`[drop002-provider] ${JSON.stringify({ error: "store-context", stores: ctx.stores.map((s) => ({ id: s.id, name: s.name })) })}`);
    return <main style={{ display: "none" }} aria-hidden="true">provider probe</main>;
  }

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
      product: { id, title: detail.title, model: catalog.find((p) => p.id === id)?.model ?? null },
      variants: variants.map((v) => ({ id: v.id, name: v.name, size: v.size, color: v.color, in_stock: v.inStock })),
      print_areas: areas,
    };
  };

  const report = {
    store: { id: ctx.selected.id, name: ctx.selected.name },
    tee: await inspect(tee?.id),
    mug_candidates: mugHits.map((p) => ({ id: p.id, title: p.title, model: p.model, type: p.type })),
    mugs: await Promise.all(mugHits.slice(0, 8).map((p) => inspect(p.id))),
  };
  console.log(`[drop002-provider] ${JSON.stringify(report)}`);
  return <main style={{ display: "none" }} aria-hidden="true">provider probe</main>;
}
