/**
 * GET /api/catalog/products — the shared catalog, server to server.
 *
 * UFC owns the catalog and the provisioning state; this is how the other
 * storefront reads it. Both sites therefore resolve products from the same
 * authoritative records rather than from two copies of a slug list that agree
 * until the day somebody edits one of them.
 *
 * What crosses the wire is exactly what a storefront needs to render and
 * nothing else: slug, title, description, price and currency, the options a
 * customer chooses between, availability, and permanent image URLs. Provider
 * costs, provider product and variant ids, claim identities and provisioning
 * notes stay here. That is not a policy applied at the edge of this handler —
 * it is `toStorefront`, the same single crossing the UFC pages use, so there
 * is one place to audit rather than two.
 *
 * Availability is derived, never asserted. A product is available only when
 * the provider has confirmed that exact product exists. Everything else,
 * including an outcome we are still unsure about, is unavailable with a
 * reason. A consumer that cannot reach this endpoint is expected to do the
 * same, which is why the response carries no "assume available on error"
 * escape hatch.
 */
import { NextResponse } from "next/server";
import { CATALOG_VERSION, productsFor } from "@/lib/store/catalog";
import { getProvisioning, provisioningConfigured } from "@/lib/store/provisioning";
import { toStorefront } from "@/lib/store/types";
import { verifySignedRequest } from "@/lib/store/signing";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pathWithQuery = `${url.pathname}${url.search}`;

  const auth = await verifySignedRequest(req, pathWithQuery, process.env.CATALOG_SHARED_SECRET);
  if (!auth.ok) {
    /* The reason is safe to return: it describes the request that was made,
     * never the secret it failed against. Debugging a signing mismatch
     * blind is miserable, and "unauthorized" with no detail is how that
     * happens. */
    return json({ error: auth.status === 503 ? "CATALOG_NOT_CONFIGURED" : "unauthorized", reason: auth.reason }, auth.status);
  }

  /* Absolute, permanent URLs. A consumer renders these on its own domain, so
   * a relative path would resolve against the wrong host. STORE_PUBLIC_ORIGIN
   * exists so a preview deployment can serve images that actually exist on
   * that preview rather than pointing at production, where this branch has
   * not been promoted. */
  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");

  const site = url.searchParams.get("site") === "news" ? "news" : "ufc";

  /* If provisioning state is unreachable we do not guess. getProvisioning
   * returns an empty map on any failure, every product then projects as
   * unavailable, and the consumer is told the source was degraded so it can
   * say so rather than silently showing a closed shop as if that were news. */
  const configured = provisioningConfigured();
  const provisioning = await getProvisioning();
  const degraded = configured && provisioning.size === 0;

  const products = productsFor(site).map((d) => toStorefront(d, provisioning.get(d.slug) ?? null, origin));

  return json({
    catalog_version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    site,
    /* Told plainly, because a consumer must be able to distinguish "nothing
     * is available" from "we could not find out what is available". */
    provisioning_source: !configured ? "unconfigured" : degraded ? "unreachable" : "ok",
    any_purchasable: products.some((p) => p.purchasable),
    count: products.length,
    products,
  });
}
