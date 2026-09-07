/**
 * Printful client — read paths only.
 *
 * There is deliberately no create, update or order function in this file. The
 * web app must not be able to provision anything: creation happens in one
 * place, scripts/store/provision.mjs, run on purpose by an operator against
 * the durable claim in store_provisioning. A serverless function that can
 * create products is a serverless function that creates two of them the first
 * time it is called twice.
 *
 * Nothing here hardcodes a catalog id. Variant ids differ by region and are
 * easy to transcribe wrongly, and a wrong one does not fail loudly — it
 * prints the wrong garment. Everything is resolved live and reported back,
 * and a blank that cannot be resolved unambiguously is a failure rather than
 * a best guess.
 *
 * The token is read from the environment and never returned, logged or
 * echoed. A store-scoped private token is already bound to its store and must
 * not be sent an X-PF-Store-Id header; only an account-level token needs one,
 * which is why PRINTFUL_STORE_ID stays optional.
 */
import "server-only";

const API = "https://api.printful.com";

export class ProviderError extends Error {
  status: number;
  detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.detail = detail;
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.PRINTFUL_API_TOKEN);
}

function headers(): Record<string, string> {
  const token = process.env.PRINTFUL_API_TOKEN;
  if (!token) throw new ProviderError(0, "PROVIDER_NOT_CONFIGURED");
  const h: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (process.env.PRINTFUL_STORE_ID) h["x-pf-store-id"] = String(process.env.PRINTFUL_STORE_ID);
  return h;
}

async function get<T>(path: string, storeId?: number): Promise<T> {
  /* Some endpoints demand store_id even from a store-scoped token, which is
   * a surprise given the token is already bound to one store. The mockup
   * generator is one: it answers 400 "This endpoint requires `store_id`!"
   * without it. So callers that know the resolved store pass it. */
  const h = headers();
  if (storeId) h["x-pf-store-id"] = String(storeId);
  const res = await fetch(`${API}${path}`, {
    headers: h,
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) {
    /* The provider's own message is far more useful than anything we could
     * invent, so it is carried through — truncated, and never alongside the
     * request headers that contained the token. */
    throw new ProviderError(res.status, `Printful ${res.status} on ${path}`, text.slice(0, 300));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(res.status, `unparseable response from ${path}`, text.slice(0, 200));
  }
}

/* ---- store context ------------------------------------------------------ */

export type Store = { id: number; name: string; type: string | null; website: string | null; currency: string | null };

/** GET /stores is the cheapest call that proves the token is valid, reaches
 * the API, and says which store it actually controls. Worth knowing before an
 * order exists, rather than discovering it when a shirt arrives from one. */
export async function getStores(): Promise<Store[]> {
  const r = await get<{ result?: Store[] | Store }>("/stores");
  const raw = r?.result;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type ?? null,
    website: s.website ?? null,
    currency: s.currency ?? null,
  }));
}

export type StoreContext =
  | { ok: true; mode: "store-scoped token" | "account-level token"; selected: Store; stores: Store[]; ambiguous: false }
  | { ok: false; mode: "account-level token"; selected: null; stores: Store[]; ambiguous: boolean };

export async function resolveStoreContext(): Promise<StoreContext> {
  const stores = await getStores();
  const pinned = process.env.PRINTFUL_STORE_ID ? String(process.env.PRINTFUL_STORE_ID) : null;

  if (pinned) {
    const hit = stores.find((s) => String(s.id) === pinned);
    return hit
      ? { ok: true, mode: "account-level token", selected: hit, stores, ambiguous: false }
      : { ok: false, mode: "account-level token", selected: null, stores, ambiguous: false };
  }
  if (stores.length === 1) return { ok: true, mode: "store-scoped token", selected: stores[0], stores, ambiguous: false };
  return { ok: false, mode: "account-level token", selected: null, stores, ambiguous: true };
}

/* ---- catalog ------------------------------------------------------------ */

export type CatalogProduct = { id: number; type: string | null; brand: string | null; model: string | null; title: string };

/** The blanks V1 uses, described by what they are rather than by id. `match`
 * must identify exactly one product; `prefer` breaks a tie only when several
 * genuinely describe the same blank. */
export const BASE_PRODUCTS: Record<string, { label: string; match: RegExp; model?: string }> = {
  /* `model` is an EXACT tiebreak, and it has to be exact.
   *
   * A substring preference looked reasonable and resolved nothing: the live
   * catalog carries 3001, 3001B, 3001T, 3001Y and 3001ECO — youth, tall,
   * different fits — and /3001/ matches all five, so the blank stayed
   * ambiguous and the canary refused rather than guessing. Which is the
   * correct behaviour, and also why the tiebreak must be equality. */
  tee: { label: "Unisex premium tee", match: /bella\s*\+?\s*canvas\s*3001|unisex staple t-shirt/i, model: "3001" },
  hoodie: { label: "Unisex heavy blend hoodie", match: /gildan\s*18500|unisex heavy blend hooded/i, model: "18500" },
  cap: { label: "Embroidered cap", match: /dad hat|embroidered.*(cap|hat)|trucker cap|snapback/i },
  mug: { label: "White glossy mug", match: /white glossy mug/i },
};

export async function listCatalog(): Promise<CatalogProduct[]> {
  const r = await get<{ result?: Array<{ id: number; type?: string; brand?: string; model?: string }> }>("/products");
  return (r?.result || []).map((p) => ({
    id: p.id,
    type: p.type ?? null,
    brand: p.brand ?? null,
    model: p.model ?? null,
    title: `${p.brand || ""} ${p.model || ""}`.trim(),
  }));
}

export type Resolution =
  | { ok: true; product: CatalogProduct }
  | { ok: false; reason: "none" | "ambiguous"; candidates: CatalogProduct[] };

export function resolveBaseProduct(key: string, catalog: CatalogProduct[]): Resolution {
  const spec = BASE_PRODUCTS[key];
  if (!spec) return { ok: false, reason: "none", candidates: [] };
  const hits = catalog.filter((p) => spec.match.test(p.title) || spec.match.test(p.model || ""));
  if (!hits.length) return { ok: false, reason: "none", candidates: [] };
  if (hits.length === 1) return { ok: true, product: hits[0] };
  if (spec.model) {
    const exact = hits.filter((p) => String(p.model || "").toLowerCase() === spec.model!.toLowerCase());
    if (exact.length === 1) return { ok: true, product: exact[0] };
  }
  /* Several blanks match and none is clearly the one. Guessing here silently
   * chooses a different garment, so it fails and lists the options. */
  return { ok: false, reason: "ambiguous", candidates: hits.slice(0, 8) };
}

export type Variant = {
  id: number;
  name: string;
  size: string | null;
  color: string | null;
  /** Provider cost. Operational — never projected to a storefront. */
  price: string | null;
  inStock: boolean;
};

export async function getVariants(catalogProductId: number): Promise<Variant[]> {
  const r = await get<{ result?: { variants?: Array<Record<string, unknown>> } }>(`/products/${catalogProductId}`);
  return (r?.result?.variants || []).map((v) => ({
    id: Number(v.id),
    name: String(v.name ?? ""),
    size: (v.size as string) ?? null,
    color: (v.color as string) ?? null,
    price: (v.price as string) ?? null,
    inStock: v.in_stock !== false,
  }));
}

export function selectVariants(
  variants: Variant[],
  sizes: readonly string[],
  colors: readonly string[],
): { chosen: Record<string, number>; costs: Record<string, string>; missing: string[] } {
  const chosen: Record<string, number> = {};
  const costs: Record<string, string> = {};
  const missing: string[] = [];
  for (const color of colors) {
    for (const size of sizes) {
      const hit = variants.find(
        (v) =>
          String(v.color || "").toLowerCase() === color.toLowerCase() &&
          String(v.size || "").toLowerCase() === size.toLowerCase(),
      );
      const key = `${size} / ${color}`;
      if (hit) {
        chosen[key] = hit.id;
        if (hit.price) costs[key] = hit.price;
      } else {
        missing.push(key);
      }
    }
  }
  return { chosen, costs, missing };
}

/* ---- print areas -------------------------------------------------------- */

export type PrintArea = { placement: string; width: number; height: number; dpi: number | null };

/**
 * The authoritative print-area dimensions for a blank.
 *
 * This is the endpoint that answers "how big must the artwork actually be",
 * and it is the only acceptable source for that number. Assuming 1800x2400
 * because it is Printful's common DTG area is how a mug ends up rendered at
 * cap dimensions: plausible, wrong, and invisible until it is printed.
 */
export async function getPrintAreas(catalogProductId: number, storeId?: number): Promise<PrintArea[]> {
  const r = await get<{
    result?: { available_placements?: Record<string, string>; printfiles?: Array<Record<string, unknown>>; variant_printfiles?: Array<Record<string, unknown>> };
  }>(`/mockup-generator/printfiles/${catalogProductId}`, storeId);

  const files = r?.result?.printfiles || [];
  const byId = new Map<number, { width: number; height: number; dpi: number | null }>();
  for (const f of files) {
    byId.set(Number(f.printfile_id), {
      width: Number(f.width),
      height: Number(f.height),
      dpi: f.dpi != null ? Number(f.dpi) : null,
    });
  }

  /* variant_printfiles maps each variant's placements onto printfile ids. The
   * placement set is what we want, deduplicated: within one blank a placement
   * has one printfile size. */
  const seen = new Map<string, PrintArea>();
  for (const vp of r?.result?.variant_printfiles || []) {
    const placements = (vp.placements || {}) as Record<string, number>;
    for (const [placement, printfileId] of Object.entries(placements)) {
      if (seen.has(placement)) continue;
      const f = byId.get(Number(printfileId));
      if (!f || !Number.isFinite(f.width) || !Number.isFinite(f.height)) continue;
      seen.set(placement, { placement, width: f.width, height: f.height, dpi: f.dpi });
    }
  }
  return [...seen.values()].sort((a, b) => a.placement.localeCompare(b.placement));
}

/* ---- existing sync products (read-only) --------------------------------- */

export type SyncProduct = { id: number; external_id: string | null; name: string; variants: number };

/**
 * Every sync product in the store, with its external id.
 *
 * Used to reconcile an uncertain provisioning outcome against reality, and to
 * check the assumption that external_id is unique rather than trusting it.
 * Paged, because a store with more than one page of products would otherwise
 * silently reconcile against a partial view and conclude a product is absent
 * when it is on page two.
 */
export async function listSyncProducts(limit = 100): Promise<SyncProduct[]> {
  const out: SyncProduct[] = [];
  for (let offset = 0; offset < 2000; offset += limit) {
    const r = await get<{ result?: Array<Record<string, unknown>>; paging?: { total?: number } }>(
      `/store/products?limit=${limit}&offset=${offset}`,
    );
    const page = r?.result || [];
    for (const p of page) {
      out.push({
        id: Number(p.id),
        external_id: (p.external_id as string) ?? null,
        name: String(p.name ?? ""),
        variants: Number(p.variants ?? 0),
      });
    }
    const total = r?.paging?.total;
    if (page.length < limit || (typeof total === "number" && out.length >= total)) break;
  }
  return out;
}

/**
 * All sync products carrying an external id — plural on purpose.
 *
 * The provisioning design must not assume the provider enforces uniqueness on
 * external_id. It may; the documentation does not promise it, and a guarantee
 * we have not observed is an assumption. Returning every match lets the caller
 * detect duplicates instead of taking the first and never noticing.
 */
export function findByExternalId(products: SyncProduct[], externalId: string): SyncProduct[] {
  return products.filter((p) => String(p.external_id) === String(externalId));
}
