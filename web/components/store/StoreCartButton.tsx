"use client";

import Link from "next/link";
import { useCart } from "./CartProvider";

export function StoreCartButton({ mobile = false }: { mobile?: boolean }) {
  const cart = useCart();
  const units = cart.ready ? cart.units : 0;

  return (
    <Link
      href="/store/cart"
      className={mobile ? "st-cart-link st-cart-link-mobile" : "st-cart-link"}
      aria-label={units === 1 ? "Shopping bag, 1 item" : `Shopping bag, ${units} items`}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M6.75 8.25h10.5l.9 12H5.85l.9-12Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 9V6.75a3 3 0 0 1 6 0V9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>Bag</span>
      <span className="st-cart-count" aria-hidden="true">{units}</span>
    </Link>
  );
}
