import "server-only";
import { SITE } from "@/lib/site";
import { liveBySlug } from "./live-products";
import { formatPrice } from "./types";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "PropBetEdge UFC Store <picks@propbetedge.ai>";

type StoreOrder = {
  id: string;
  public_token: string;
  stripe_session_id: string;
  state: string;
  currency: string;
  email: string | null;
  amount_total_cents: number | null;
  amount_shipping_cents: number | null;
  amount_tax_cents: number | null;
  ship_city: string | null;
  ship_state: string | null;
  ship_country: string | null;
  created_at: string;
  paid_at: string | null;
  submitted_at: string | null;
  confirmation_email_sent_at: string | null;
  confirmation_email_provider_id: string | null;
};

type StoreLine = {
  order_id: string;
  slug: string;
  size: string;
  color: string;
  quantity: number;
  unit_price_cents: number;
};

export type CustomerOrder = {
  token: string;
  placed_at: string;
  status: "paid" | "in_production" | "cancelled";
  currency: string;
  total_cents: number | null;
  shipping_cents: number | null;
  tax_cents: number | null;
  ships_to: string | null;
  lines: Array<{ slug: string; name: string; size: string; color: string; quantity: number; unit_price_cents: number }>;
};

function configured(): boolean {
  return Boolean(URL_ && KEY);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!configured()) throw new Error("ORDERS_NOT_CONFIGURED");
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: headers((init.headers as Record<string, string>) || {}),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`orders ${res.status}: ${text.slice(0, 220)}`);
  return (text ? JSON.parse(text) : null) as T;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function orderStatus(state: string): CustomerOrder["status"] {
  if (state === "cancelled") return "cancelled";
  if (state === "paid") return "paid";
  return "in_production";
}

function summarize(order: StoreOrder, lines: StoreLine[]): CustomerOrder {
  const where = [order.ship_city, order.ship_state, order.ship_country].filter(Boolean).join(", ");
  return {
    token: order.public_token,
    placed_at: order.paid_at || order.created_at,
    status: orderStatus(order.state),
    currency: order.currency,
    total_cents: order.amount_total_cents,
    shipping_cents: order.amount_shipping_cents,
    tax_cents: order.amount_tax_cents,
    ships_to: where || null,
    lines: lines.map((l) => ({
      slug: l.slug,
      name: liveBySlug(l.slug)?.name || l.slug,
      size: l.size,
      color: l.color,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
    })),
  };
}

async function linesForOrderIds(ids: string[]): Promise<StoreLine[]> {
  if (!ids.length) return [];
  return (await rest<StoreLine[]>(
    `store_order_lines?order_id=in.(${ids.join(",")})&select=order_id,slug,size,color,quantity,unit_price_cents&order=created_at.asc`,
  )) || [];
}

export async function getCustomerOrders(email: string, limit = 20): Promise<CustomerOrder[]> {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !configured()) return [];
  const orders = (await rest<StoreOrder[]>(
    `store_orders?email=ilike.${encodeURIComponent(clean)}&state=neq.pending&select=id,public_token,stripe_session_id,state,currency,email,amount_total_cents,amount_shipping_cents,amount_tax_cents,ship_city,ship_state,ship_country,created_at,paid_at,submitted_at,confirmation_email_sent_at,confirmation_email_provider_id&order=created_at.desc&limit=${Math.min(Math.max(limit, 1), 50)}`,
  )) || [];
  const lines = await linesForOrderIds(orders.map((o) => o.id));
  const byOrder = new Map<string, StoreLine[]>();
  for (const line of lines) {
    if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
    byOrder.get(line.order_id)!.push(line);
  }
  return orders.map((order) => summarize(order, byOrder.get(order.id) || []));
}

async function orderBySession(sessionId: string): Promise<{ order: StoreOrder; lines: StoreLine[] } | null> {
  const rows = await rest<StoreOrder[]>(
    `store_orders?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=id,public_token,stripe_session_id,state,currency,email,amount_total_cents,amount_shipping_cents,amount_tax_cents,ship_city,ship_state,ship_country,created_at,paid_at,submitted_at,confirmation_email_sent_at,confirmation_email_provider_id&limit=1`,
  );
  const order = rows?.[0];
  if (!order) return null;
  return { order, lines: await linesForOrderIds([order.id]) };
}

function emailBody(order: StoreOrder, lines: StoreLine[], receiptUrl: string): { html: string; text: string; subject: string } {
  const number = order.public_token.slice(-8).toUpperCase();
  const total = order.amount_total_cents == null ? null : formatPrice(order.amount_total_cents);
  const rows = lines.map((line) => {
    const name = liveBySlug(line.slug)?.name || line.slug;
    const lineTotal = formatPrice(line.unit_price_cents * line.quantity);
    return `<tr><td style="padding:14px 0;border-bottom:1px solid #302a22"><div style="font-weight:800;color:#f5f1eb">${escapeHtml(name)}</div><div style="margin-top:4px;color:#9f988c;font-size:13px">${escapeHtml(line.size)} / ${escapeHtml(line.color)} · Qty ${line.quantity}</div></td><td align="right" style="padding:14px 0;border-bottom:1px solid #302a22;color:#f5f1eb;font-weight:800">${escapeHtml(lineTotal)}</td></tr>`;
  }).join("");
  const ship = [order.ship_city, order.ship_state, order.ship_country].filter(Boolean).join(", ");
  const safeUrl = escapeHtml(receiptUrl);
  const html = `<!doctype html><html><body style="margin:0;background:#0d0b08;color:#f5f1eb;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="padding:38px 16px;background:#0d0b08"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#17130f;border:1px solid rgba(212,175,55,.34);border-radius:18px;padding:34px"><tr><td><img src="https://propbetedge.ai/logo/pbe-full-400.png" width="190" alt="PropBetEdge" style="display:block;max-width:190px;height:auto;margin-bottom:26px"><div style="font-size:11px;font-weight:800;letter-spacing:2.2px;color:#d4af37">UFC STORE · ORDER CONFIRMED</div><h1 style="font-size:34px;line-height:1.08;margin:12px 0;color:#fff">We got your order.</h1><p style="color:#b8b3a8;font-size:15px;line-height:1.65;margin:0 0 18px">Order #${number} is paid and recorded. We will send another update when it ships.</p><table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 24px">${rows}</table>${order.amount_shipping_cents != null ? `<div style="display:flex;justify-content:space-between;color:#b8b3a8;font-size:14px;margin:7px 0"><span>Shipping</span><strong style="color:#f5f1eb">${escapeHtml(formatPrice(order.amount_shipping_cents))}</strong></div>` : ""}${order.amount_tax_cents ? `<div style="display:flex;justify-content:space-between;color:#b8b3a8;font-size:14px;margin:7px 0"><span>Tax</span><strong style="color:#f5f1eb">${escapeHtml(formatPrice(order.amount_tax_cents))}</strong></div>` : ""}${total ? `<div style="display:flex;justify-content:space-between;border-top:1px solid #302a22;padding-top:14px;margin-top:14px;font-size:18px"><strong>Total</strong><strong style="color:#d4af37">${escapeHtml(total)}</strong></div>` : ""}${ship ? `<p style="color:#8e877c;font-size:12px;line-height:1.6;margin:20px 0 0">Ships to ${escapeHtml(ship)}</p>` : ""}<a href="${safeUrl}" style="display:inline-block;margin-top:24px;padding:15px 22px;border-radius:8px;background:#d4af37;color:#14110d;text-decoration:none;font-weight:900">VIEW ORDER →</a><p style="margin-top:22px;color:#777168;font-size:11px;line-height:1.6">Keep this email or the order link for your records. You can also sign in to PropBetEdge UFC with this same email address to see your order history.</p></td></tr></table></td></tr></table></body></html>`;
  const textLines = lines.map((line) => `${liveBySlug(line.slug)?.name || line.slug} — ${line.size} / ${line.color} — Qty ${line.quantity} — ${formatPrice(line.unit_price_cents * line.quantity)}`).join("\n");
  const text = `PropBetEdge UFC Store\n\nOrder confirmed #${number}\n\n${textLines}\n${order.amount_shipping_cents != null ? `\nShipping: ${formatPrice(order.amount_shipping_cents)}` : ""}${order.amount_tax_cents ? `\nTax: ${formatPrice(order.amount_tax_cents)}` : ""}${total ? `\nTotal: ${total}` : ""}${ship ? `\nShips to: ${ship}` : ""}\n\nView your order: ${receiptUrl}\n\nWe will send another update when it ships.`;
  return { html, text, subject: `Order confirmed — PropBetEdge UFC #${number}` };
}

/**
 * Send the paid-order receipt. The Resend idempotency key is stable for the
 * order, so Stripe webhook retries cannot create duplicate confirmation mail.
 */
export async function sendOrderConfirmationForSession(sessionId: string): Promise<"sent" | "already_sent" | "no_email" | "no_order"> {
  const found = await orderBySession(sessionId);
  if (!found) return "no_order";
  const { order, lines } = found;
  if (order.confirmation_email_sent_at) return "already_sent";
  if (!order.email) return "no_email";
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");

  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");
  const receiptUrl = `${origin}/store/order/${order.public_token}`;
  const body = emailBody(order, lines, receiptUrl);
  const sent = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `ufc-store-order-confirmation/${order.id}`,
    },
    body: JSON.stringify({
      from: process.env.STORE_EMAIL_FROM || DEFAULT_FROM,
      to: [order.email],
      subject: body.subject,
      html: body.html,
      text: body.text,
    }),
    cache: "no-store",
  });
  const detail = await sent.text();
  if (!sent.ok) throw new Error(`Resend ${sent.status}: ${detail.slice(0, 240)}`);
  let providerId: string | null = null;
  try { providerId = (JSON.parse(detail) as { id?: string })?.id || null; } catch { providerId = null; }

  await rest(
    `store_orders?id=eq.${order.id}&confirmation_email_sent_at=is.null`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ confirmation_email_sent_at: new Date().toISOString(), confirmation_email_provider_id: providerId }),
    },
  );
  return "sent";
}
