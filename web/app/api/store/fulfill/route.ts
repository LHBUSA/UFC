/**
 * POST /api/store/fulfill — hand paid orders to the printer, one at a time.
 *
 * Deliberately not part of the webhook. Stripe's handler must answer fast and
 * is retried when it does not; a provider call inside it is a call that can
 * time out into a second parcel. So payment and fulfilment are separated by
 * the database, and this is the second half: it reads orders that are already
 * recorded as paid and submits them under a claim.
 *
 * Called by a scheduler, or by an operator. It is authenticated by a bearer
 * compared in constant time and is DISABLED when that secret is absent —
 * failing closed on a missing credential, so forgetting to configure it
 * cannot leave an endpoint that submits orders open to the internet.
 *
 * The sequence per order, and why each step is where it is:
 *
 *   expire stale claims first    a submission nobody came back from becomes
 *                                uncertain, never retryable
 *   claim in SQL                 only paid and observed-failed rows are
 *                                claimable, enforced by the database
 *   submit as a draft            confirm=false, so the irreversible confirm
 *                                is a separate deliberate act
 *   settle by what we SAW        observed refusal -> failed (retryable);
 *                                anything unobserved -> uncertain
 *
 * An uncertain order is never resubmitted here. It is reconciled by looking
 * for our external id among the provider's orders, and exactly one match is
 * conclusive: the order exists, so adopt it.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  adoptExisting,
  claimForSubmission,
  expireStaleSubmissions,
  fulfillableOrders,
  getOrderById,
  markSubmitFailed,
  markSubmitted,
  markSubmitUncertain,
  ordersConfigured,
} from "@/lib/store/orders";
import { createDraftOrder, findOrdersByExternalId, ProviderWriteError, writeConfigured } from "@/lib/store/printful-orders";
import { bySlug } from "@/lib/store/catalog";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function bearerMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const gate = process.env.STORE_FULFILL_TOKEN;
  if (!gate) {
    return json(
      {
        error: "FULFILMENT_NOT_ENABLED",
        message: "Set STORE_FULFILL_TOKEN to enable submission to the print provider.",
      },
      503,
    );
  }
  const presented = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!presented || !bearerMatches(presented, gate)) return json({ error: "unauthorized" }, 401);

  if (!ordersConfigured()) return json({ error: "ORDERS_NOT_CONFIGURED" }, 503);
  if (!writeConfigured()) return json({ error: "PROVIDER_NOT_CONFIGURED" }, 503);

  /* `?dry=1` reports what would be submitted and contacts nobody. The default
   * for an endpoint that prints garments should be easy to inspect. */
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");
  const worker = `fulfill@${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local"}`;
  const report: Array<Record<string, unknown>> = [];

  /* Crash recovery before anything else. An abandoned claim is an unknown
   * outcome, and age does not turn an unknown into a known. */
  const expired = await expireStaleSubmissions();

  const queue = await fulfillableOrders(10);
  for (const row of queue) {
    const full = await getOrderById(row.id);
    if (!full) continue;
    const { order, lines } = full;

    /* Every line needs a variant the provider confirmed and a print file that
     * exists. A missing either is a refusal to submit, not a guess. */
    const items = [];
    const missing: string[] = [];
    for (const l of lines) {
      const def = bySlug(l.slug);
      if (!def || typeof l.provider_variant_id !== "number") {
        missing.push(`${l.slug} ${l.size}/${l.color}: no provider variant recorded`);
        continue;
      }
      items.push({
        variantId: l.provider_variant_id,
        quantity: l.quantity,
        name: `${def.name} (${l.size} / ${l.color})`,
        fileUrl: `${origin}/store/print/${def.art}.png`,
      });
    }

    if (missing.length || !items.length) {
      report.push({ order: order.public_token, action: "refused", reasons: missing });
      continue;
    }
    if (!order.ship_line1 || !order.ship_city || !order.ship_country || !order.ship_postal) {
      report.push({ order: order.public_token, action: "refused", reasons: ["incomplete shipping address"] });
      continue;
    }

    if (dry) {
      report.push({
        order: order.public_token,
        action: "would submit",
        external_id: order.external_id,
        items: items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity, name: i.name, file: i.fileUrl })),
      });
      continue;
    }

    const claim = await claimForSubmission(order.id, worker);
    if (!claim) {
      report.push({ order: order.public_token, action: "not claimable", state: order.state });
      continue;
    }

    try {
      const created = await createDraftOrder({
        externalId: order.external_id,
        recipient: {
          name: order.ship_name || "Customer",
          address1: order.ship_line1,
          address2: order.ship_line2,
          city: order.ship_city,
          stateCode: order.ship_state,
          countryCode: order.ship_country,
          zip: order.ship_postal,
          email: order.email,
        },
        items,
      });
      await markSubmitted(order.id, claim.attemptId, created.id);
      report.push({ order: order.public_token, action: "submitted", provider_order_id: created.id, status: created.status });
    } catch (e) {
      const err = e instanceof ProviderWriteError ? e : null;
      const detail = err ? `HTTP ${err.status}: ${String(err.detail || err.message).slice(0, 200)}` : String((e as Error)?.message).slice(0, 200);

      if (err?.observed) {
        /* Printful read the request and refused. Nothing was created, so this
         * may be retried once the cause is fixed. */
        await markSubmitFailed(order.id, claim.attemptId, detail);
        report.push({ order: order.public_token, action: "refused by provider", detail });
      } else {
        /* We do not know whether it landed. Never retry; reconcile. */
        await markSubmitUncertain(order.id, claim.attemptId, detail);
        report.push({ order: order.public_token, action: "uncertain", detail });
      }
    }
  }

  /* Reconcile what is uncertain, by looking rather than by trying again. */
  const reconciled: Array<Record<string, unknown>> = [];
  if (!dry) {
    for (const row of expired) {
      try {
        const matches = await findOrdersByExternalId(row.external_id);
        if (matches.length === 1) {
          await adoptExisting(row.id, matches[0].id);
          reconciled.push({ order: row.public_token, action: "adopted", provider_order_id: matches[0].id });
        } else if (matches.length > 1) {
          /* Two orders under one external id is not something to resolve
           * automatically. It needs a person and a refund decision. */
          reconciled.push({ order: row.public_token, action: "ESCALATE", matches: matches.map((m) => m.id) });
        } else {
          reconciled.push({ order: row.public_token, action: "still absent", note: "absence is not proof; leave uncertain" });
        }
      } catch (e) {
        reconciled.push({ order: row.public_token, action: "lookup failed", detail: String((e as Error)?.message).slice(0, 160) });
      }
    }
  }

  return json({
    ran_at: new Date().toISOString(),
    dry_run: dry,
    expired_stale_claims: expired.length,
    considered: queue.length,
    results: report,
    reconciled,
  });
}
