import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/ui";
import { getOrderByToken, ordersConfigured, publicOrder } from "@/lib/store/orders";
import { bySlug } from "@/lib/store/catalog";
import { formatPrice } from "@/lib/store/types";
import { ClearCartOnConfirm } from "@/components/store/ClearCartOnConfirm";

/* /store/order/[token] — the confirmation page.
 *
 * Reached straight off Stripe's redirect, which means it is frequently loaded
 * BEFORE the webhook has arrived. That race is the whole design problem here,
 * and the page solves it by being honest rather than by polling: an order that
 * is still `pending` is described as "payment is being confirmed", because
 * from this side that is exactly what is true. It does not claim success it
 * cannot see, and it does not claim failure either.
 *
 * The token is unguessable and the primary key is never exposed, so a
 * confirmation URL cannot be walked to somebody else's order. What the page
 * shows is deliberately less than the row holds: no full address, no email,
 * no provider ids — `publicOrder` builds that projection field by field.
 *
 * noindex, because it is a receipt.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Order | PropBetEdge UFC Store" },
  robots: { index: false, follow: false },
};

const STATUS_COPY: Record<string, { head: string; body: string }> = {
  pending: {
    head: "Payment is being confirmed",
    body:
      "Stripe has your payment and we are waiting for it to be confirmed on our side. This usually takes a few seconds. Refresh in a moment — you do not need to pay again, and nothing will be charged twice.",
  },
  paid: {
    head: "Paid. Thank you.",
    body:
      "Your order is recorded and goes to our print partner next. Production takes a few business days before anything is handed to a carrier; the delivery estimate you saw at checkout starts when production finishes.",
  },
  in_production: {
    head: "With the printer",
    body:
      "Your order has been handed to our print partner and is being made. You will get a shipping notification from us when it is on its way.",
  },
  cancelled: {
    head: "This order was cancelled",
    body: "Nothing was charged. If you did not expect this, get in touch and we will take a look.",
  },
};

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!ordersConfigured()) notFound();

  const found = await getOrderByToken(token).catch(() => null);
  if (!found) notFound();

  const order = publicOrder(found.order, found.lines);
  const copy = STATUS_COPY[order.status] ?? STATUS_COPY.pending;
  const paid = order.status !== "pending" && order.status !== "cancelled";

  return (
    <>
      {/* Emptying the cart is the client's job and only once the order is
          real: doing it on the redirect would lose the cart of a customer
          whose payment did not complete. */}
      {paid ? <ClearCartOnConfirm /> : null}

      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="Store"
            title={copy.head}
            lede={`Order ${order.token}`}
            crumbs={[{ name: "Store", href: "/store" }, { name: "Order" }]}
          />
        </div>
      </div>

      <section className="wrap st-section">
        <p className="st-notice" role="status">
          {copy.body}
        </p>

        <ul className="st-cart">
          {order.lines.map((l) => {
            const def = bySlug(l.slug);
            return (
              <li className="st-cart-row" key={`${l.slug}-${l.size}-${l.color}`}>
                <div className="st-cart-main">
                  <span className="st-cart-name">{def?.name ?? l.slug}</span>
                  <span className="st-cart-variant">
                    {l.size} / {l.color} · {l.quantity} ×
                  </span>
                </div>
                <span className="st-price">{formatPrice(l.unit_price_cents * l.quantity)}</span>
              </li>
            );
          })}
        </ul>

        <div className="st-cart-totals">
          {order.shipping_cents != null && (
            <>
              <span>Shipping</span>
              <span className="st-price">{formatPrice(order.shipping_cents)}</span>
            </>
          )}
          {order.tax_cents ? (
            <>
              <span>Tax</span>
              <span className="st-price">{formatPrice(order.tax_cents)}</span>
            </>
          ) : null}
          {order.total_cents != null && (
            <>
              <span>Total</span>
              <span className="st-price st-price-lg">{formatPrice(order.total_cents)}</span>
            </>
          )}
          {order.ships_to && (
            <>
              <span className="st-fine">Ships to</span>
              <span className="st-fine">{order.ships_to}</span>
            </>
          )}
        </div>

        <p className="st-fine">
          Keep this link — it is the receipt for this order. Questions:{" "}
          <Link href="/store/policies">shipping, returns and print policies</Link>.
        </p>
      </section>
    </>
  );
}
