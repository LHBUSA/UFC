/**
 * GET /api/store/canary-read — the read-only provider canary.
 *
 * It runs where the credential actually resolves. A laptop is not the Vercel
 * runtime, so a token held as a Vercel environment variable can never be read
 * by a local script; this is the same questions asked server-side.
 *
 * Authentication, and why the shape matters.
 *
 * An environment check is not authentication. "Only runs on preview, only on
 * this branch" describes where code executes, not who is calling it, and a
 * preview URL is a URL — guessable, shareable, and indexed the moment someone
 * pastes it somewhere. So this endpoint requires a bearer token compared in
 * constant time, and it is DISABLED unless that token is configured. Failing
 * closed on a missing secret is the whole point: forgetting to configure it
 * must not leave an open operational endpoint.
 *
 * Vercel Deployment Protection sits in front of this and is genuinely useful,
 * but it is a second layer, not this one. Neither is trusted alone.
 *
 * It is read-only by construction, not by intention: this module imports no
 * function capable of creating a product, a mockup task or an order, because
 * lib/store/printful.ts does not export one.
 *
 * No secret is ever returned or logged. Store metadata, catalog ids, variant
 * ids, provider costs and print-area dimensions are returned, because those
 * are the entire reason to run it — and this response is behind a bearer, not
 * on a page.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  BASE_PRODUCTS,
  findByExternalId,
  getPrintAreas,
  getVariants,
  isConfigured,
  listCatalog,
  listSyncProducts,
  ProviderError,
  resolveBaseProduct,
  resolveStoreContext,
  selectVariants,
  type CatalogProduct,
} from "@/lib/store/printful";
import { PRODUCTS } from "@/lib/store/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Constant-time compare that does not leak length through an early return. */
function bearerMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    /* Still do the work, against b and itself, so a wrong-length guess costs
     * the same as a wrong-value one. */
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

type Step = { name: string; status: "pass" | "fail" | "partial" | "skip"; detail: string };

export async function GET(req: Request) {
  const gate = process.env.STORE_CANARY_TOKEN;
  if (!gate) {
    return json(
      {
        error: "CANARY_NOT_ENABLED",
        message: "Set STORE_CANARY_TOKEN to enable this endpoint, and unset it once provisioning is proven.",
      },
      503,
    );
  }

  const presented = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!presented || !bearerMatches(presented, gate)) {
    return json({ error: "unauthorized" }, 401);
  }

  const steps: Step[] = [];
  const step = (name: Step["name"], status: Step["status"], detail: string) => steps.push({ name, status, detail });

  const out: Record<string, unknown> = {
    ran_at: new Date().toISOString(),
    runtime: {
      vercel_env: process.env.VERCEL_ENV || null,
      git_ref: process.env.VERCEL_GIT_COMMIT_REF || null,
      git_sha: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    },
    /* Presence only. Values are never read into the response. */
    env: {
      PRINTFUL_API_TOKEN: isConfigured() ? "present" : "MISSING",
      PRINTFUL_STORE_ID: process.env.PRINTFUL_STORE_ID ? "present (account-level token)" : "absent (store-scoped token)",
      SUPABASE_URL: process.env.SUPABASE_URL ? "present" : "MISSING",
    },
    steps,
  };

  try {
    if (!isConfigured()) {
      step("auth", "fail", "PRINTFUL_API_TOKEN is not present in this runtime");
      return json({ ...out, verdict: "fail" });
    }

    /* 1. auth + store context -------------------------------------------- */
    const ctx = await resolveStoreContext();
    out.stores = ctx.stores;
    if (!ctx.ok) {
      step(
        "auth",
        "fail",
        ctx.ambiguous
          ? `token sees ${ctx.stores.length} stores; set PRINTFUL_STORE_ID to choose one`
          : "PRINTFUL_STORE_ID does not match any store this token can see",
      );
      return json({ ...out, verdict: "fail" });
    }
    out.store = ctx.selected;
    out.token_mode = ctx.mode;
    step("auth", "pass", `${ctx.mode} · store ${ctx.selected.id} "${ctx.selected.name}"`);

    /* 2. live catalog resolution ------------------------------------------ */
    const catalog = await listCatalog();
    out.catalog_size = catalog.length;
    const bases: Record<string, { id?: number; title?: string; error?: string; candidates?: CatalogProduct[] }> = {};
    for (const key of Object.keys(BASE_PRODUCTS)) {
      const r = resolveBaseProduct(key, catalog);
      if (r.ok) {
        bases[key] = { id: r.product.id, title: r.product.title };
        step(`base:${key}`, "pass", `${r.product.title} -> catalog product ${r.product.id}`);
      } else {
        bases[key] = { error: r.reason, candidates: r.candidates };
        step(`base:${key}`, "fail", r.reason === "ambiguous" ? `${r.candidates.length} candidates, none decisive` : "no candidate matched");
      }
    }
    out.base_products = bases;

    /* 3. variants, costs and print areas for every resolved blank ---------- */
    const forms: Record<string, unknown> = {};
    for (const [key, base] of Object.entries(bases)) {
      if (!base.id) continue;
      const def = PRODUCTS.find((p) => p.form === key);
      const variants = await getVariants(base.id);
      const sel = def ? selectVariants(variants, def.sizes, def.colors) : { chosen: {}, costs: {}, missing: [] };
      let areas: unknown = null;
      let areaError: string | null = null;
      try {
        areas = await getPrintAreas(base.id);
      } catch (e) {
        areaError = e instanceof ProviderError ? `HTTP ${e.status}` : String((e as Error).message).slice(0, 120);
      }
      forms[key] = {
        catalog_product_id: base.id,
        variant_count: variants.length,
        selected: sel.chosen,
        /* Provider cost. Operational, returned here behind the bearer, and
         * never present in anything lib/store/types.ts projects to a page. */
        costs: sel.costs,
        missing: sel.missing,
        available_colors: [...new Set(variants.map((v) => v.color).filter(Boolean))].slice(0, 30),
        available_sizes: [...new Set(variants.map((v) => v.size).filter(Boolean))].slice(0, 20),
        print_areas: areas,
        print_areas_error: areaError,
      };
      step(
        `variants:${key}`,
        Object.keys(sel.chosen).length ? (sel.missing.length ? "partial" : "pass") : "fail",
        `${Object.keys(sel.chosen).length} resolved${sel.missing.length ? `, ${sel.missing.length} unavailable` : ""}`,
      );
      step(`print-areas:${key}`, areas && (areas as unknown[]).length ? "pass" : "fail", areaError || `${(areas as unknown[])?.length ?? 0} placements`);
    }
    out.forms = forms;

    /* 4. what already exists in the store, and whether external_id is
     *    actually behaving as a unique key ------------------------------- */
    const sync = await listSyncProducts();
    out.sync_product_count = sync.length;
    const ours = PRODUCTS.map((p) => ({ slug: p.slug, matches: findByExternalId(sync, p.slug).map((s) => s.id) }));
    out.existing_for_our_slugs = ours.filter((o) => o.matches.length);
    const dupes = ours.filter((o) => o.matches.length > 1);
    out.external_id_duplicates = dupes;
    /* Observational only. Finding no duplicates does not prove the provider
     * enforces uniqueness on external_id — it proves nobody has created one
     * yet. The create-time behaviour stays unverified until it is tested
     * deliberately, and provisioning does not rely on it either way. */
    step(
      "external_id observation",
      dupes.length ? "fail" : "pass",
      dupes.length
        ? `${dupes.length} slug(s) already map to more than one sync product`
        : `no duplicate external_id among ${sync.length} sync products (observation, not a uniqueness guarantee)`,
    );

    const failed = steps.filter((s) => s.status === "fail").length;
    return json({ ...out, verdict: failed ? "fail" : "pass" });
  } catch (e) {
    const detail =
      e instanceof ProviderError
        ? `HTTP ${e.status}: ${String(e.detail || e.message).slice(0, 200)}`
        : String((e as Error)?.message ?? e).slice(0, 200);
    step("fatal", "fail", detail);
    return json({ ...out, verdict: "fail" });
  }
}
