/**
 * POST /api/store/checkout — turn a cart into a Stripe Checkout Session.
 *
 * The request body carries slugs, sizes, colours and quantities. Nothing else
 * is read from it. Not prices, not totals, not shipping, not variant ids, not
 * a currency. Every one of those is resolved here, and a body that supplies
 * them is ignored rather than rejected, because rejecting teaches an attacker
 * which field mattered.
 *
 * The order of operations is the security property:
 *
 *   1. parse the cart into the smallest possible shape
 *   2. resolve prices from lib/store/catalog.ts
 *   3. resolve purchasability and variant ids from store_provisioning, with
 *      the service role, and REFUSE any line the provider has not confirmed
 *   4. write the pending order, with its lines and our external id
 *   5. only then create the Stripe session
 *
 * Step 3 is re-derived at this moment rather than trusted from the page the
 * customer was looking at. A storefront render can be sixty seconds stale and
 * a product can be deleted at the provider in between; the page saying "on
 * sale" is not evidence.
 *
 * Step 4 before step 5 is deliberate. A row written after the redirect leaves
 * a window where a webhook can arrive for a session nothing here has heard
 * of. Written first, the worst case is an abandoned pending row.
 */
import { NextResponse } from "next/server";
import { MAX_LINES, parseCart, validateAgainstCatalog } from "@/lib/store/cart";
import { getProvisioning, provisioningConfigured } from "@/lib/store/provisioning";
import { createPendingOrder, newExternalId, newPublicToken, ordersConfigured } from "@/lib/store/orders";
import { automaticTaxEnabled, SHIP_TO_COUNTRIES, shippingOptions, stripe, stripeConfigured } from "@/lib/store/stripe";
import { variantKey } from "@/lib/store/types";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  /* Fail closed, and say which piece is missing. A half-configured checkout
   * that creates orders it cannot charge for is worse than none. */
  if (!stripeConfigured() || !ordersConfigured() || !provisioningConfigured()) {
    return json(
      {
        error: "CHECKOUT_NOT_CONFIGURED",
        missing: [
          !stripeConfigured() && "STRIPE_SECRET_KEY",
          !ordersConfigured() && "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY",
          !provisioningConfigured() && "provisioning source",
        ].filter(Boolean),
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "malformed body" }, 400);
  }

  const lines = parseCart((body as Record<string, unknown>)?.items);
  if (!lines.length) return json({ error: "cart is empty" }, 400);
  if (lines.length > MAX_LINES) return json({ error: "cart is too large" }, 400);

  /* Catalog first: does this product exist, is it in the launch collection,
   * do we make it in that size and colour, and what do we charge. */
  const { ok, problems } = validateAgainstCatalog(lines, "ufc");
  if (problems.length || !ok.length) {
    return json({ error: "cart is not purchasable", problems: problems.map((p) => p.reason) }, 400);
  }

  /* Provider second. A line survives only if the provider has confirmed this
   * exact product AND holds a variant for this exact size and colour. */
  const provisioning = await getProvisioning();
  const priced: Array<{ line: (typeof ok)[number]["line"]; name: string; unit_price_cents: number; provider_variant_id: number }> = [];
  const unavailable: string[] = [];

  for (const r of ok) {
    const rec = provisioning.get(r.line.slug);
    const confirmed =
      rec?.state === "created" && typeof rec.provider_product_id === "number" && rec.provider_variant_ids;
    const variant = confirmed ? rec.provider_variant_ids[variantKey(r.line.size, r.line.color)] : undefined;
    if (!confirmed || typeof variant !== "number") {
      unavailable.push(`${r.name} (${r.line.size} / ${r.line.color})`);
      continue;
    }
    priced.push({ line: r.line, name: r.name, unit_price_cents: r.unit_price_cents, provider_variant_id: variant });
  }

  if (unavailable.length || !priced.length) {
    /* 409, not 400: the request was well formed and the answer changed. */
    return json(
      {
        error: "NOT_AVAILABLE",
        message:
          "These pieces are not confirmed with our print partner yet, so we cannot take an order for them.",
        items: unavailable,
      },
      409,
    );
  }

  const publicToken = newPublicToken();
  const externalId = newExternalId();
  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");

  /* Stripe needs a session id to key the order on, and the order must exist
   * before the session is live. Resolved by creating the session first but
   * writing the row before returning the URL: if the write throws, the
   * customer never receives a payable link, and the orphaned session expires
   * on its own without being paid. */
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: priced.map((p) => ({
      quantity: p.line.qty,
      price_data: {
        currency: "usd",
        /* The authoritative number. Taken from catalog.ts moments ago and
         * never from the request. */
        unit_amount: p.unit_price_cents,
        product_data: {
          name: p.name,
          description: `${p.line.size} / ${p.line.color}`,
          metadata: { slug: p.line.slug, size: p.line.size, color: p.line.color },
        },
      },
    })),
    /* Server-defined, both of them. The browser chooses between options it
     * was given; it does not supply them. */
    shipping_address_collection: { allowed_countries: SHIP_TO_COUNTRIES },
    shipping_options: shippingOptions(),
    ...(automaticTaxEnabled() ? { automatic_tax: { enabled: true } } : {}),
    /* No account required. Stripe collects the email it needs for a receipt. */
    customer_creation: "if_required",
    metadata: { public_token: publicToken, external_id: externalId },
    success_url: `${origin}/store/order/${publicToken}`,
    cancel_url: `${origin}/store/cart?cancelled=1`,
    /* Short. An abandoned session holding a price we might change is not
     * something to leave open for a day. */
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });

  try {
    await createPendingOrder({
      stripeSessionId: session.id,
      publicToken,
      externalId,
      currency: "usd",
      lines: priced.map((p) => ({
        line: p.line,
        unit_price_cents: p.unit_price_cents,
        provider_variant_id: p.provider_variant_id,
      })),
    });
  } catch (e) {
    /* The session exists but we could not record it. Expiring it is the
     * honest cleanup: an unrecorded session that gets paid is money taken for
     * an order no system remembers. */
    try {
      await stripe().checkout.sessions.expire(session.id);
    } catch {
      /* Best effort. The session expires on its own within the hour. */
    }
    console.error(`[store] could not record order for ${session.id}: ${String((e as Error)?.message).slice(0, 200)}`);
    return json({ error: "ORDER_NOT_RECORDED", message: "We could not start that order. Nothing was charged." }, 503);
  }

  return json({ url: session.url, token: publicToken });
}
