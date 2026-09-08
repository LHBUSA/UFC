"use client";

/**
 * The cart page body.
 *
 * The subtotal here is a courtesy. Shipping and tax are Stripe's to compute
 * from an address this page has never seen, so the page shows the item total
 * and says plainly that the rest is calculated at checkout, rather than
 * inventing a number that changes on the next screen.
 *
 * "Checkout" posts slugs, sizes, colours and quantities. Every price is looked
 * up again on the server. If the route answers 409 the piece stopped being
 * available between rendering and clicking, which is exactly the case a stale
 * page cannot detect on its own, so the message is shown rather than swallowed.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { imagePath } from "@/lib/store/art";
import { lineKey, validateAgainstCatalog, subtotalCents, MAX_QTY } from "@/lib/store/cart";
import { formatPrice } from "@/lib/store/types";
import { useCart } from "./CartProvider";

export function CartView({ cancelled }: { cancelled: boolean }) {
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { ok, problems } = useMemo(() => validateAgainstCatalog(cart.lines, "ufc"), [cart.lines]);
  const subtotal = subtotalCents(ok);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/store/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: cart.lines }),
      });
      const data = (await res.json()) as { url?: string; message?: string; error?: string; items?: string[] };
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setError(
        data.message ||
          (data.items?.length ? `Not available: ${data.items.join(", ")}` : null) ||
          (data.error === "CHECKOUT_NOT_CONFIGURED"
            ? "Checkout is not switched on yet. Nothing was charged."
            : "We could not start that order. Nothing was charged."),
      );
    } catch {
      setError("We could not reach checkout. Nothing was charged.");
    } finally {
      setBusy(false);
    }
  }

  if (!cart.ready) return <p className="st-fine">Loading your cart…</p>;

  if (!cart.lines.length) {
    return (
      <p className="st-notice" role="status">
        {cancelled ? <strong>Checkout cancelled. Nothing was charged.</strong> : <strong>Your cart is empty.</strong>}{" "}
        <Link href="/store">Back to the store</Link>.
      </p>
    );
  }

  return (
    <>
      {cancelled && (
        <p className="st-notice" role="status">
          <strong>Checkout cancelled.</strong> Nothing was charged and your cart is exactly as you left it.
        </p>
      )}

      {problems.length > 0 && (
        <p className="st-notice" role="status">
          <strong>Some items were removed.</strong> {problems.map((p) => p.reason).join("; ")}.
        </p>
      )}

      <ul className="st-cart">
        {ok.map(({ line, name, unit_price_cents }) => {
          const key = lineKey(line);
          return (
            <li className="st-cart-row" key={key}>
              <img className="st-cart-art" src={imagePath(line.slug)} alt="" width={72} height={90} loading="lazy" />
              <div className="st-cart-main">
                <Link href={`/store/${line.slug}`} className="st-cart-name">
                  {name}
                </Link>
                <span className="st-cart-variant">
                  {line.size} / {line.color}
                </span>
              </div>
              <label className="st-cart-qty">
                <span className="st-opt-label">Qty</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_QTY}
                  value={line.qty}
                  onChange={(e) => cart.setQuantity(key, Number(e.target.value))}
                  aria-label={`Quantity of ${name}, ${line.size} ${line.color}`}
                />
              </label>
              <span className="st-price">{formatPrice(unit_price_cents * line.qty)}</span>
              <button type="button" className="st-cart-remove" onClick={() => cart.remove(key)} aria-label={`Remove ${name}`}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <div className="st-cart-foot">
        <div className="st-cart-totals">
          <span>Items</span>
          <span className="st-price">{formatPrice(subtotal)}</span>
          <span className="st-fine">Shipping and tax</span>
          <span className="st-fine">Calculated at checkout</span>
        </div>

        <button type="button" className="btn gold st-add" onClick={checkout} disabled={busy || !ok.length}>
          {busy ? "Starting checkout…" : "Checkout"}
        </button>
      </div>

      {error && (
        <p className="st-notice" role="alert">
          <strong>{error}</strong>
        </p>
      )}

      <p className="st-fine">
        Payment is handled by Stripe; card details never reach our servers. Printed and shipped on demand —{" "}
        <Link href="/store/policies">shipping, returns and print policies</Link>.
      </p>
    </>
  );
}
