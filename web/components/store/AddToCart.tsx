"use client";

/**
 * Size, colour, add. The whole product interaction.
 *
 * The control is disabled when the piece is not purchasable, and it says why
 * rather than simply refusing. Purchasability arrives as a prop derived on the
 * server from what the provider has confirmed; nothing here can turn it on,
 * and the checkout route re-derives it anyway on the assumption that this
 * component was bypassed entirely.
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
  const [size, setSize] = useState(sizes[0] ?? "");
  const [color, setColor] = useState(colors[0] ?? "");
  const [added, setAdded] = useState(false);

  const choose = (kind: "size" | "color", value: string) => {
    if (kind === "size") setSize(value);
    else setColor(value);
    setAdded(false);
  };

  return (
    <div className="st-buy">
      <fieldset className="st-opts" disabled={!purchasable}>
        <legend className="st-opt-label">Size</legend>
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

        <legend className="st-opt-label">Colour</legend>
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
      </fieldset>

      {purchasable ? (
        <>
          <button
            type="button"
            className="btn gold st-add"
            onClick={() => {
              cart.add({ slug, size, color, qty: 1 });
              setAdded(true);
            }}
          >
            Add to cart
          </button>
          <p className="st-fine" role="status" aria-live="polite">
            {added ? (
              <>
                Added {size} / {color}. <Link href="/store/cart">Go to cart</Link>.
              </>
            ) : (
              <>Printed for your order. Nothing is made until you buy it.</>
            )}
          </p>
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
