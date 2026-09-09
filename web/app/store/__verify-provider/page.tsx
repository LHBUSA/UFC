import "server-only";

export const dynamic = "force-static";
export const revalidate = false;

const API = "https://api.printful.com";

async function pf(path: string, storeId?: number) {
  const token = process.env.PRINTFUL_API_TOKEN;
  if (!token) return { ok: false as const, error: "PRINTFUL_API_TOKEN missing" };
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (storeId) headers["x-pf-store-id"] = String(storeId);
  else if (process.env.PRINTFUL_STORE_ID) headers["x-pf-store-id"] = String(process.env.PRINTFUL_STORE_ID);
  const res = await fetch(`${API}${path}`, { headers, cache: "force-cache" });
  const text = await res.text();
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  return { ok: true as const, data: JSON.parse(text) as any };
}

function compactVariants(rows: any[], sizes: string[], color: string) {
  return rows
    .filter((v) => String(v.color || "").toLowerCase() === color.toLowerCase() && sizes.some((s) => s.toLowerCase() === String(v.size || "").toLowerCase()))
    .map((v) => ({ id: Number(v.id), size: v.size, color: v.color, name: v.name, in_stock: v.in_stock !== false }));
}

export default async function ProviderVerificationProbe() {
  const stores = await pf("/stores");
  const storeRows = stores.ok ? (Array.isArray(stores.data?.result) ? stores.data.result : stores.data?.result ? [stores.data.result] : []) : [];
  const storeId = Number(process.env.PRINTFUL_STORE_ID || (storeRows.length === 1 ? storeRows[0]?.id : 0)) || undefined;
  const catalog = await pf("/products", storeId);
  const products: any[] = catalog.ok ? catalog.data?.result || [] : [];
  const tee = products.find((p) => /bella\s*\+?\s*canvas/i.test(`${p.brand || ""} ${p.title || ""}`) && String(p.model || "") === "3001")
    || products.find((p) => /unisex staple t-shirt/i.test(String(p.title || "")) && String(p.model || "") === "3001");
  const mug = products.find((p) => /black glossy mug/i.test(String(p.title || "")))
    || products.find((p) => /black.*glossy.*mug/i.test(`${p.brand || ""} ${p.model || ""} ${p.title || ""}`));

  const [teeDetail, mugDetail, teeAreas, mugAreas] = await Promise.all([
    tee?.id ? pf(`/products/${tee.id}`, storeId) : Promise.resolve({ ok: false as const, error: "tee not resolved" }),
    mug?.id ? pf(`/products/${mug.id}`, storeId) : Promise.resolve({ ok: false as const, error: "mug not resolved" }),
    tee?.id ? pf(`/mockup-generator/printfiles/${tee.id}`, storeId) : Promise.resolve({ ok: false as const, error: "tee not resolved" }),
    mug?.id ? pf(`/mockup-generator/printfiles/${mug.id}`, storeId) : Promise.resolve({ ok: false as const, error: "mug not resolved" }),
  ]);

  const teeVariants = teeDetail.ok ? compactVariants(teeDetail.data?.result?.variants || [], ["S", "M", "L", "XL", "2XL"], "Black") : [];
  const mugVariants = mugDetail.ok ? compactVariants(mugDetail.data?.result?.variants || [], ["11 oz"], "Black") : [];

  const summarizeAreas = (r: any) => {
    if (!r.ok) return { error: r.error };
    const result = r.data?.result || {};
    const byId = new Map<number, any>((result.printfiles || []).map((f: any) => [Number(f.printfile_id), f]));
    const out = new Map<string, any>();
    for (const vp of result.variant_printfiles || []) {
      for (const [placement, fileId] of Object.entries(vp.placements || {})) {
        if (out.has(placement)) continue;
        const f = byId.get(Number(fileId));
        if (f) out.set(placement, { placement, width: Number(f.width), height: Number(f.height), dpi: f.dpi == null ? null : Number(f.dpi) });
      }
    }
    return [...out.values()];
  };

  const report = {
    store_count: storeRows.length,
    store_id_resolved: Boolean(storeId),
    tee: tee ? { product_id: tee.id, title: tee.title, brand: tee.brand, model: tee.model, variants: teeVariants, print_areas: summarizeAreas(teeAreas) } : null,
    mug: mug ? { product_id: mug.id, title: mug.title, brand: mug.brand, model: mug.model, variants: mugVariants, print_areas: summarizeAreas(mugAreas) } : null,
    errors: [
      !stores.ok && `stores: ${stores.error}`,
      !catalog.ok && `catalog: ${catalog.error}`,
      !tee && "tee product not resolved",
      !mug && "black glossy mug product not resolved",
      !teeDetail.ok && `tee detail: ${teeDetail.error}`,
      !mugDetail.ok && `mug detail: ${mugDetail.error}`,
    ].filter(Boolean),
  };

  console.log(`[store-provider-probe] ${JSON.stringify(report)}`);
  return <main style={{ display: "none" }} aria-hidden="true">provider verification probe</main>;
}
