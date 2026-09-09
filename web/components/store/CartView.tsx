"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { imagePath } from "@/lib/store/art";
import { lineKey, validateAgainstCatalog, subtotalCents, MAX_QTY } from "@/lib/store/cart";
import { formatPrice } from "@/lib/store/types";
import { useCart } from "./CartProvider";

const HOODIE_SLUG = "propbetedge-hoodie";
const DROP003_IMAGES: Record<string, string> = {
  "tale-of-the-tape-hoodie": "/store/img/tale-of-the-tape-hoodie.webp",
  "propbetedge-hat": "/store/img/pbe-classic-hat.webp",
  "trust-the-data-mug": "/store/img/trust-the-data-mug.webp",
};

export function CartView({ cancelled }: { cancelled: boolean }) {
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ok, problems } = useMemo(() => validateAgainstCatalog(cart.lines, "ufc"), [cart.lines]);
  const subtotal = subtotalCents(ok);
  const units = ok.reduce((sum, item) => sum + item.line.qty, 0);

  async function checkout() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/store/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: cart.lines }) });
      const data = (await res.json()) as { url?: string; message?: string; error?: string; items?: string[] };
      if (res.ok && data.url) { window.location.href = data.url; return; }
      setError(data.message || (data.items?.length ? `Not available: ${data.items.join(", ")}` : null) || (data.error === "CHECKOUT_NOT_CONFIGURED" ? "Checkout is not switched on yet. Nothing was charged." : "We could not start that order. Nothing was charged."));
    } catch { setError("We could not reach checkout. Nothing was charged."); }
    finally { setBusy(false); }
  }

  if (!cart.ready) return <p className="st-fine">Loading your bag…</p>;
  if (!cart.lines.length) return <div className="st-empty-cart" role="status"><span className="st-empty-icon" aria-hidden="true">□</span><div><strong>{cancelled ? "Checkout cancelled." : "Your bag is empty."}</strong><p>{cancelled ? "Nothing was charged. Your order was not placed." : "Add a piece from the store and it will stay here while you shop."}</p></div><Link href="/store" className="btn gold">Back to the store</Link></div>;

  return <>
    {cancelled && <p className="st-notice" role="status"><strong>Checkout cancelled.</strong> Nothing was charged and your bag is exactly as you left it.</p>}
    {problems.length > 0 && <p className="st-notice" role="status"><strong>Some items need attention.</strong> {problems.map((p) => p.reason).join("; ")}.</p>}
    <div className="st-cart-layout">
      <div className="st-cart-items-panel">
        <div className="st-cart-panel-head"><div><span className="st-kicker">Your bag</span><h2>{units === 1 ? "1 item" : `${units} items`}</h2></div><Link href="/store" className="st-continue-link">Continue shopping</Link></div>
        <ul className="st-cart">
          {ok.map(({ line, name, unit_price_cents }) => {
            const key = lineKey(line);
            const image = line.slug === HOODIE_SLUG ? "/store/img/propbetedge-premium-hoodie.jpg" : DROP003_IMAGES[line.slug] ?? imagePath(line.slug);
            return <li className="st-cart-row" key={key}>
              <Link href={`/store/${line.slug}`} className="st-cart-art-link" aria-label={`View ${name}`}><img className="st-cart-art" src={image} alt="" width={96} height={120} loading="lazy" /></Link>
              <div className="st-cart-main"><Link href={`/store/${line.slug}`} className="st-cart-name">{name}</Link><span className="st-cart-variant">{line.size} · {line.color}</span><button type="button" className="st-cart-remove" onClick={() => cart.remove(key)} aria-label={`Remove ${name}`}>Remove</button></div>
              <label className="st-cart-qty"><span className="st-opt-label">Qty</span><select value={line.qty} onChange={(e) => cart.setQuantity(key, Number(e.target.value))} aria-label={`Quantity of ${name}, ${line.size} ${line.color}`}>{Array.from({ length: MAX_QTY }, (_, i) => i + 1).map((qty) => <option key={qty} value={qty}>{qty}</option>)}</select></label>
              <span className="st-cart-line-price">{formatPrice(unit_price_cents * line.qty)}</span>
            </li>;
          })}
        </ul>
      </div>
      <aside className="st-cart-summary" aria-label="Order summary">
        <span className="st-kicker">Order summary</span><h2>Ready when you are.</h2>
        <div className="st-summary-lines"><div><span>Items</span><strong>{formatPrice(subtotal)}</strong></div><div><span>Shipping</span><span>Calculated next</span></div><div><span>Tax</span><span>Calculated next</span></div></div>
        <div className="st-summary-total"><span>Subtotal</span><strong>{formatPrice(subtotal)}</strong></div>
        <button type="button" className="btn gold st-checkout-button" onClick={checkout} disabled={busy || !ok.length}>{busy ? "Opening secure checkout…" : "Continue to secure checkout"}{!busy && <span aria-hidden="true">→</span>}</button>
        <div className="st-checkout-trust"><div><span aria-hidden="true">▣</span><span><strong>Secure payment</strong><small>Handled by Stripe</small></span></div><div><span aria-hidden="true">◇</span><span><strong>Made for your order</strong><small>Printed on demand</small></span></div></div>
        <p className="st-fine st-summary-note">Shipping and any applicable tax are shown before you pay. Card details never reach PropBetEdge servers.</p>
      </aside>
    </div>
    {error && <p className="st-notice st-cart-error" role="alert"><strong>{error}</strong></p>}
    <p className="st-fine st-cart-policy">Printed and shipped on demand by our print partner. <Link href="/store/policies">Shipping, returns and print policies</Link>.</p>
  </>;
}
