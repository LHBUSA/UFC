"use client";

/**
 * Product option selection and the handoff into checkout.
 *
 * Purchasability still comes from the server and checkout re-validates every
 * line. This component only makes the customer journey explicit: choose a
 * size, add once, then present a large next-step action instead of hiding the
 * cart behind a sentence-sized link.
 */
import { useState } from "react";
import Link from "next/link";
import { useCart } from "./CartProvider";

export function AddToCart({
  slug,
  sizes,
  colors,
  purchasable,
  reason,
}: {
  slug: string;
  sizes: string[];
  colors: string[];
  purchasable: boolean;
  reason: string | null;
}) {
  const cart = useCart();
  /* Apparel should not silently choose a size for the customer. One-size
   * products can select themselves; everything else asks for a deliberate
   * choice before the buy button turns on. */
  const [size, setSize] = useState(sizes.length === 1 ? (sizes[0] ?? "") : "");
  const [color, setColor] = useState(colors[0] ?? "");
  const [added, setAdded] = useState(false);

  const choose = (kind: "size" | "color", value: string) => {
    if (kind === "size") setSize(value);
    else setColor(value);
    setAdded(false);
  };

  const canAdd = purchasable && Boolean(size && color);
  const bagLabel = cart.units === 1 ? "1 item" : `${cart.units} items`;

  return (
    <div className="st-buy">
      <fieldset className="st-opts" disabled={!purchasable}>
        <legend className="st-opts-title">Choose your options</legend>

        <div className="st-option-group">
          <div className="st-option-head">
            <span className="st-opt-label">Size</span>
            {sizes.length > 1 && <span className={size ? "st-opt-value" : "st-opt-hint"}>{size || "Choose one"}</span>}
          </div>
          <div className="st-chips" role="radiogroup" aria-label="Size">
            {sizes.map((s) => (
              <button
                type="button"
                key={s}
                role="radio"
                aria-checked={s === size}
                className={s === size ? "st-chip st-chip-on" : "st-chip"}
                onClick={() => choose("size", s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="st-option-group">
          <div className="st-option-head">
            <span className="st-opt-label">Colour</span>
            <span className="st-opt-value">{color}</span>
          </div>
          <div className="st-chips" role="radiogroup" aria-label="Colour">
            {colors.map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={c === color}
                className={c === color ? "st-chip st-chip-on" : "st-chip"}
                onClick={() => choose("color", c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      {purchasable ? (
        <>
          <button
            type="button"
            className="btn gold st-add"
            disabled={!canAdd || added}
            onClick={() => {
              if (!canAdd) return;
              cart.add({ slug, size, color, qty: 1 });
              setAdded(true);
            }}
          >
            {!size ? "Choose a size" : added ? "Added to bag ✓" : "Add to bag"}
          </button>

          {added ? (
            <div className="st-added-panel" role="status" aria-live="polite">
              <div className="st-added-copy">
                <span className="st-added-check" aria-hidden="true">✓</span>
                <span>
                  <strong>Added to your bag</strong>
                  <small>{size} · {color} · {bagLabel} in bag</small>
                </span>
              </div>
              <div className="st-added-actions">
                <Link href="/store/cart" className="btn gold st-checkout-now">
                  Review bag &amp; checkout <span aria-hidden="true">→</span>
                </Link>
                <Link href="/store" className="btn st-keep-shopping">Keep shopping</Link>
              </div>
            </div>
          ) : (
            <p className="st-fine st-buy-note" role="status" aria-live="polite">
              Printed for your order. Secure payment is handled by Stripe.
            </p>
          )}
        </>
      ) : (
        <>
          <button type="button" className="btn st-add" disabled aria-disabled="true">
            Not on sale yet
          </button>
          {reason ? (
            <p className="st-fine" role="status">
              {reason}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
