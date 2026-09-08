/**
 * POST /api/webhooks/stripe — the only thing allowed to say an order was paid.
 *
 * Three properties, in the order they matter.
 *
 * 1. IT VERIFIES BEFORE IT BELIEVES. The raw body is read as text and checked
 *    against STRIPE_WEBHOOK_SECRET. An unverified body is an unauthenticated
 *    stranger asserting that money changed hands, and this endpoint is
 *    necessarily public. Reading the body as JSON would destroy the bytes the
 *    signature covers, which is why it is `req.text()` and why the payload is
 *    never parsed before construction succeeds.
 *
 * 2. IT IS IDEMPOTENT. Stripe delivers at least once — which means sometimes
 *    twice, sometimes concurrently, and sometimes again after we already
 *    succeeded but before Stripe saw the 200. All of those collapse onto
 *    store_order_mark_paid, which moves pending -> paid and does nothing at
 *    all on a second call. A replay returning "no row updated" is success,
 *    not an error, and answering anything but 2xx to it would earn another
 *    retry.
 *
 * 3. IT DOES NOT CALL THE PRINTER. Fulfilment happens out of band, claimed
 *    from the database by /api/store/fulfill. A provider call inside a
 *    webhook handler is a call that can exceed Stripe's timeout, which
 *    produces a retry, which — without the claim discipline — produces a
 *    second parcel. The handler's only job is to record the fact and get out.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { markPaid, ordersConfigured } from "@/lib/store/orders";
import { stripe, stripeConfigured, webhookConfigured } from "@/lib/store/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const cents = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);

export async function POST(req: Request) {
  if (!stripeConfigured() || !webhookConfigured() || !ordersConfigured()) {
    /* 503 rather than 400: nothing is wrong with the caller. Stripe will
     * retry, which is the correct behaviour while the deployment is being
     * configured. */
    return json({ error: "WEBHOOK_NOT_CONFIGURED" }, 503);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "missing signature" }, 400);

  /* Raw bytes. The signature covers exactly these. */
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET as string);
  } catch (e) {
    /* Do not log the body. It is unverified input and may be anything. */
    console.error(`[store] webhook signature rejected: ${String((e as Error)?.message).slice(0, 120)}`);
    return json({ error: "invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;

        /* `complete` is not the same as paid. A session can complete with a
         * payment still processing, and treating that as paid would hand an
         * unpaid order to fulfilment. The async_payment_succeeded event is
         * the one that arrives later for those. */
        if (session.payment_status !== "paid") {
          return json({ received: true, ignored: `payment_status=${session.payment_status}` });
        }

        const ship = session.collected_information?.shipping_details?.address ?? null;
        const shipName = session.collected_information?.shipping_details?.name ?? null;

        const { applied } = await markPaid({
          sessionId: session.id,
          paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : null,
          totalCents: cents(session.amount_total),
          shippingCents: cents(session.total_details?.amount_shipping),
          taxCents: cents(session.total_details?.amount_tax),
          email: session.customer_details?.email ?? null,
          ship: ship
            ? {
                name: shipName,
                line1: ship.line1 ?? null,
                line2: ship.line2 ?? null,
                city: ship.city ?? null,
                state: ship.state ?? null,
                postal_code: ship.postal_code ?? null,
                country: ship.country ?? null,
              }
            : null,
        });

        /* `applied: false` means the row had already moved past pending: a
         * replay, or a race with another delivery of the same event. Both are
         * fine and both are 200. */
        return json({ received: true, applied });
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        /* Nothing is written. An expired pending row is harmless, and a
         * cancel path that mutates state is one more way for a late
         * `completed` event to be lost. */
        return json({ received: true, note: `session ${session.id} expired; pending row left as-is` });
      }

      default:
        return json({ received: true, ignored: event.type });
    }
  } catch (e) {
    /* A 500 asks Stripe to try again, which is right: the payment is real and
     * we failed to record it. The retry hits the same idempotent function. */
    console.error(`[store] webhook handling failed for ${event.type}: ${String((e as Error)?.message).slice(0, 200)}`);
    return json({ error: "handler failed" }, 500);
  }
}
