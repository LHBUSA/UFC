/**
 * Order persistence. Server only, service role only.
 *
 * This module holds shipping addresses and provider variant ids, so nothing
 * it returns may be handed to a page unfiltered — `publicOrder` is the one
 * projection that crosses, and it is built field by field for the same reason
 * `toStorefront` is.
 *
 * Unlike the read paths elsewhere in the store, this one does NOT swallow its
 * errors. A storefront that cannot reach the database should render as "not
 * released", because guessing wrong there costs a customer nothing. An order
 * that cannot be recorded must fail loudly, because the alternative is taking
 * money for something no system remembers.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { CartLine } from "./cart";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function ordersConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    apikey: KEY,
    "content-type": "application/json",
    Accept: "application/json",
    ...extra,
  };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export class OrderStoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OrderStoreError";
    this.status = status;
  }
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!ordersConfigured()) throw new OrderStoreError(0, "ORDERS_NOT_CONFIGURED");
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: headers((init.headers as Record<string, string>) || {}),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    /* Truncated, and never alongside the key. The provider's own message is
     * more useful than anything invented here. */
    throw new OrderStoreError(res.status, `orders ${res.status}: ${text.slice(0, 240)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export type OrderState =
  | "pending"
  | "paid"
  | "submitting"
  | "submitted"
  | "submit_failed"
  | "submit_uncertain"
  | "cancelled";

export type OrderRow = {
  id: string;
  public_token: string;
  state: OrderState;
  stripe_session_id: string;
  external_id: string;
  currency: string;
  amount_total_cents: number | null;
  amount_shipping_cents: number | null;
  amount_tax_cents: number | null;
  provider_order_id: number | null;
  attempt_id: string | null;
  email: string | null;
  ship_name: string | null;
  ship_line1: string | null;
  ship_line2: string | null;
  ship_city: string | null;
  ship_state: string | null;
  ship_postal: string | null;
  ship_country: string | null;
  created_at: string;
  paid_at: string | null;
  submitted_at: string | null;
};

export type OrderLineRow = {
  slug: string;
  size: string;
  color: string;
  quantity: number;
  unit_price_cents: number;
  provider_variant_id: number | null;
};

/** Unguessable, URL-safe, and short enough to paste into an email. */
export function newPublicToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Our identity for this order at the print provider. Generated before the
 * first submission so an unobserved outcome is reconcilable by lookup. */
export function newExternalId(): string {
  return `pbe-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export type CreateOrderInput = {
  stripeSessionId: string;
  publicToken: string;
  externalId: string;
  currency: string;
  lines: Array<{ line: CartLine; unit_price_cents: number; provider_variant_id: number | null }>;
};

/**
 * Record the intended order BEFORE the customer is sent to Stripe.
 *
 * The ordering matters more than it looks. If the row is written after the
 * redirect, a webhook can arrive referring to a session nothing on our side
 * has ever heard of, and the only recovery is reading it back out of Stripe
 * and hoping the cart is reconstructible. Writing first means the worst case
 * is an abandoned pending row, which costs nothing.
 */
export async function createPendingOrder(input: CreateOrderInput): Promise<OrderRow> {
  const [order] = await rest<OrderRow[]>("store_orders", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      public_token: input.publicToken,
      stripe_session_id: input.stripeSessionId,
      external_id: input.externalId,
      currency: input.currency,
      state: "pending",
    }),
  });
  if (!order?.id) throw new OrderStoreError(500, "order row was not returned after insert");

  await rest("store_order_lines", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(
      input.lines.map((l) => ({
        order_id: order.id,
        slug: l.line.slug,
        size: l.line.size,
        color: l.line.color,
        quantity: l.line.qty,
        unit_price_cents: l.unit_price_cents,
        provider_variant_id: l.provider_variant_id,
      })),
    ),
  });

  return order;
}

/**
 * Record payment. Idempotent in the database, not here.
 *
 * A replay returns no row, which is success: it means the order has already
 * moved past pending and nothing needs doing. Treating that as an error is
 * how a webhook ends up being retried forever.
 */
export async function markPaid(args: {
  sessionId: string;
  paymentIntent: string | null;
  totalCents: number | null;
  shippingCents: number | null;
  taxCents: number | null;
  email: string | null;
  ship: Record<string, string | null> | null;
}): Promise<{ applied: boolean; order: OrderRow | null }> {
  const rows = await rest<OrderRow[]>("rpc/store_order_mark_paid", {
    method: "POST",
    body: JSON.stringify({
      p_session_id: args.sessionId,
      p_intent: args.paymentIntent,
      p_total: args.totalCents,
      p_shipping: args.shippingCents,
      p_tax: args.taxCents,
      p_email: args.email,
      p_ship: args.ship ?? {},
    }),
  });
  const order = Array.isArray(rows) ? (rows[0] ?? null) : ((rows as unknown as OrderRow) ?? null);
  return { applied: Boolean(order?.id), order: order?.id ? order : null };
}

export async function getOrderByToken(token: string): Promise<{ order: OrderRow; lines: OrderLineRow[] } | null> {
  const rows = await rest<OrderRow[]>(
    `store_orders?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
  );
  const order = rows?.[0];
  if (!order) return null;
  const lines = await rest<OrderLineRow[]>(
    `store_order_lines?order_id=eq.${order.id}&select=slug,size,color,quantity,unit_price_cents,provider_variant_id`,
  );
  return { order, lines: lines ?? [] };
}

export async function getOrderById(id: string): Promise<{ order: OrderRow; lines: OrderLineRow[] } | null> {
  const rows = await rest<OrderRow[]>(`store_orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const order = rows?.[0];
  if (!order) return null;
  const lines = await rest<OrderLineRow[]>(
    `store_order_lines?order_id=eq.${order.id}&select=slug,size,color,quantity,unit_price_cents,provider_variant_id`,
  );
  return { order, lines: lines ?? [] };
}

/** Orders the fulfilment worker may act on. Uncertain ones are excluded: they
 * are reconciled by lookup, never resubmitted. */
export async function fulfillableOrders(limit = 20): Promise<OrderRow[]> {
  return (
    (await rest<OrderRow[]>(
      `store_orders?state=in.(paid,submit_failed)&select=*&order=paid_at.asc&limit=${limit}`,
    )) ?? []
  );
}

export async function claimForSubmission(orderId: string, by: string): Promise<{ order: OrderRow; attemptId: string } | null> {
  const attemptId = randomUUID();
  const rows = await rest<OrderRow[]>("rpc/store_order_claim", {
    method: "POST",
    body: JSON.stringify({ p_order_id: orderId, p_attempt_id: attemptId, p_claimed_by: by }),
  });
  const order = Array.isArray(rows) ? rows[0] : (rows as unknown as OrderRow);
  return order?.id ? { order, attemptId } : null;
}

const settle = (fn: string) => async (orderId: string, attemptId: string, arg: number | string | null) => {
  const body: Record<string, unknown> = { p_order_id: orderId, p_attempt_id: attemptId };
  if (fn === "store_order_mark_submitted") body.p_provider_id = arg;
  else body.p_error = arg;
  await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });
};

export const markSubmitted = settle("store_order_mark_submitted");
export const markSubmitFailed = settle("store_order_mark_failed");
export const markSubmitUncertain = settle("store_order_mark_uncertain");

export async function expireStaleSubmissions(): Promise<OrderRow[]> {
  return (
    (await rest<OrderRow[]>("rpc/store_order_expire_stale_claims", {
      method: "POST",
      body: JSON.stringify({}),
    })) ?? []
  );
}

export async function adoptExisting(orderId: string, providerOrderId: number): Promise<void> {
  await rest("rpc/store_order_adopt_existing", {
    method: "POST",
    body: JSON.stringify({ p_order_id: orderId, p_provider_id: providerOrderId }),
  });
}

/**
 * What a confirmation page may see.
 *
 * Built field by field rather than spread. The row carries a full shipping
 * address, an email, provider variant ids and an internal uuid; the page needs
 * to say "this arrived, here is what you bought, it is going to this city".
 * A spread would publish the rest the first time somebody adds a column.
 */
export type PublicOrder = {
  token: string;
  placed_at: string;
  status: "paid" | "in_production" | "pending" | "cancelled";
  currency: string;
  total_cents: number | null;
  shipping_cents: number | null;
  tax_cents: number | null;
  /* Enough to recognise the destination, not enough to be an address leak if
   * the link is forwarded: city, region and country only. */
  ships_to: string | null;
  lines: Array<{ slug: string; size: string; color: string; quantity: number; unit_price_cents: number }>;
};

export function publicOrder(order: OrderRow, lines: OrderLineRow[]): PublicOrder {
  const status: PublicOrder["status"] =
    order.state === "pending"
      ? "pending"
      : order.state === "cancelled"
        ? "cancelled"
        : order.state === "paid"
          ? "paid"
          : "in_production";
  const where = [order.ship_city, order.ship_state, order.ship_country].filter(Boolean).join(", ");
  return {
    token: order.public_token,
    placed_at: order.created_at,
    status,
    currency: order.currency,
    total_cents: order.amount_total_cents,
    shipping_cents: order.amount_shipping_cents,
    tax_cents: order.amount_tax_cents,
    ships_to: where || null,
    lines: lines.map((l) => ({
      slug: l.slug,
      size: l.size,
      color: l.color,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
      /* provider_variant_id is deliberately not copied. */
    })),
  };
}
