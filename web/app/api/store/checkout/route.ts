/** POST /api/store/checkout — authoritative server-side store checkout. */
import { NextResponse } from "next/server";
import { MAX_LINES, parseCart, validateAgainstCatalog } from "@/lib/store/cart";
import { getProvisioning, provisioningConfigured } from "@/lib/store/provisioning";
import { createPendingOrder, newExternalId, newPublicToken, ordersConfigured } from "@/lib/store/orders";
import { drop001RuntimeStatus } from "@/lib/store/release";
import { isReleaseLine, releaseProvisioningReady } from "@/lib/store/release-policy";
import { stripeMerch } from "@/lib/store/stripe-catalog";
import { automaticTaxEnabled, SHIP_TO_COUNTRIES, shippingOptions, stripe, stripeConfigured } from "@/lib/store/stripe";
import { variantKey } from "@/lib/store/types";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  /* A payment is not allowed to begin unless the full path is ready: signed
   * Stripe webhook, provider credential, fulfilment gate and final art files,
   * not merely the Stripe secret used to create a Checkout Session. */
  const release = drop001RuntimeStatus();
  if (!release.ready || !stripeConfigured() || !ordersConfigured() || !provisioningConfigured()) {
    return json(
      {
        error: "CHECKOUT_NOT_CONFIGURED",
        missing: [
          ...release.missing,
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

  const { ok, problems } = validateAgainstCatalog(lines, "ufc");
  if (problems.length || !ok.length) {
    return json({ error: "cart is not purchasable", problems: problems.map((p) => p.reason) }, 400);
  }

  const releaseProblems = ok.flatMap((r) =>
    isReleaseLine(r.line.slug, r.line.size, r.line.color)
      ? []
      : [`${r.name}: that size/colour is not in the active release`],
  );
  if (releaseProblems.length) return json({ error: "NOT_IN_CURRENT_RELEASE", problems: releaseProblems }, 409);

  const provisioning = await getProvisioning();
  const priced: Array<{
    line: (typeof ok)[number]["line"];
    name: string;
    unit_price_cents: number;
    provider_variant_id: number;
    stripe_price_id: string;
  }> = [];
  const unavailable: string[] = [];

  for (const r of ok) {
    const rec = provisioning.get(r.line.slug);
    const confirmed = releaseProvisioningReady(r.line.slug, rec);
    const variant = confirmed ? rec?.provider_variant_ids[variantKey(r.line.size, r.line.color)] : undefined;
    const stripeProduct = stripeMerch(r.line.slug);

    /* The local catalog remains the pricing authority for the storefront, but
     * Checkout uses a permanent Stripe Price so every sale lands on the same
     * Stripe Product instead of creating a throwaway inline product. If the
     * two authored amounts ever disagree, fail closed before a Session exists. */
    if (!stripeProduct || stripeProduct.unitAmount !== r.unit_price_cents || stripeProduct.currency !== "usd") {
      unavailable.push(`${r.name}: Stripe catalog binding is missing or price-mismatched`);
      continue;
    }
    if (!confirmed || typeof variant !== "number") {
      unavailable.push(`${r.name} (${r.line.size} / ${r.line.color})`);
      continue;
    }
    priced.push({
      line: r.line,
      name: r.name,
      unit_price_cents: r.unit_price_cents,
      provider_variant_id: variant,
      stripe_price_id: stripeProduct.priceId,
    });
  }

  if (unavailable.length || !priced.length) {
    return json(
      {
        error: "NOT_AVAILABLE",
        message: "One or more exact product variants are not verified for checkout right now. Nothing was charged.",
        items: unavailable,
      },
      409,
    );
  }

  const publicToken = newPublicToken();
  const externalId = newExternalId();
  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    /* Permanent Stripe Price IDs keep revenue reporting, refunds and product
     * analytics attached to the real catalog. Size/colour remain in our signed
     * order record below because fulfilment is variant-specific while price is
     * product-specific. */
    line_items: priced.map((p) => ({
      quantity: p.line.qty,
      price: p.stripe_price_id,
    })),
    client_reference_id: externalId,
    shipping_address_collection: { allowed_countries: SHIP_TO_COUNTRIES },
    shipping_options: shippingOptions(),
    ...(automaticTaxEnabled() ? { automatic_tax: { enabled: true } } : {}),
    customer_creation: "if_required",
    metadata: {
      public_token: publicToken,
      external_id: externalId,
      channel: "ufc_store",
    },
    payment_intent_data: {
      metadata: {
        public_token: publicToken,
        external_id: externalId,
        channel: "ufc_store",
      },
    },
    success_url: `${origin}/store/order/${publicToken}`,
    cancel_url: `${origin}/store/cart?cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });

  try {
    await createPendingOrder({
      stripeSessionId: session.id,
      publicToken,
      externalId,
      currency: "usd",
      lines: priced.map((p) => ({ line: p.line, unit_price_cents: p.unit_price_cents, provider_variant_id: p.provider_variant_id })),
    });
  } catch (e) {
    try {
      await stripe().checkout.sessions.expire(session.id);
    } catch {
      /* best effort; the session self-expires within the hour */
    }
    console.error(`[store] could not record order for ${session.id}: ${String((e as Error)?.message).slice(0, 200)}`);
    return json({ error: "ORDER_NOT_RECORDED", message: "We could not start that order. Nothing was charged." }, 503);
  }

  return json({ url: session.url, token: publicToken });
}
