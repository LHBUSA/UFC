/** POST /api/store/checkout — authoritative server-side store checkout. */
import { NextResponse } from "next/server";
import { MAX_LINES, parseCart, validateAgainstCatalog } from "@/lib/store/cart";
import { getProvisioning, provisioningConfigured } from "@/lib/store/provisioning";
import { createPendingOrder, newExternalId, newPublicToken, ordersConfigured } from "@/lib/store/orders";
import { DROP001_SLUG, drop001ProvisioningReady, drop001RuntimeStatus, isDrop001Line } from "@/lib/store/release";
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

  const releaseProblems = ok.flatMap((r) => {
    if (r.line.slug !== DROP001_SLUG) return [`${r.name}: not part of Drop 001`];
    if (!isDrop001Line(r.line.slug, r.line.color)) return [`${r.name}: Drop 001 is Black only`];
    return [];
  });
  if (releaseProblems.length) return json({ error: "NOT_IN_CURRENT_DROP", problems: releaseProblems }, 409);

  const provisioning = await getProvisioning();
  const priced: Array<{ line: (typeof ok)[number]["line"]; name: string; unit_price_cents: number; provider_variant_id: number }> = [];
  const unavailable: string[] = [];

  for (const r of ok) {
    const rec = provisioning.get(r.line.slug);
    const confirmed = r.line.slug === DROP001_SLUG && drop001ProvisioningReady(rec);
    const variant = confirmed ? rec?.provider_variant_ids[variantKey(r.line.size, r.line.color)] : undefined;
    if (!confirmed || typeof variant !== "number") {
      unavailable.push(`${r.name} (${r.line.size} / ${r.line.color})`);
      continue;
    }
    priced.push({ line: r.line, name: r.name, unit_price_cents: r.unit_price_cents, provider_variant_id: variant });
  }

  if (unavailable.length || !priced.length) {
    return json(
      {
        error: "NOT_AVAILABLE",
        message: "That exact hoodie variant is not available for checkout right now. Nothing was charged.",
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
    line_items: priced.map((p) => ({
      quantity: p.line.qty,
      price_data: {
        currency: "usd",
        unit_amount: p.unit_price_cents,
        product_data: {
          name: p.name,
          description: `${p.line.size} / ${p.line.color}`,
          metadata: { slug: p.line.slug, size: p.line.size, color: p.line.color },
        },
      },
    })),
    shipping_address_collection: { allowed_countries: SHIP_TO_COUNTRIES },
    shipping_options: shippingOptions(),
    ...(automaticTaxEnabled() ? { automatic_tax: { enabled: true } } : {}),
    customer_creation: "if_required",
    metadata: { public_token: publicToken, external_id: externalId },
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
