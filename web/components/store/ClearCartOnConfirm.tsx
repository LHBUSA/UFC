"use client";

/* Empty the cart, once, when an order is confirmed real.
 *
 * Deliberately not done on the redirect from Stripe. A customer whose payment
 * did not complete comes back through the cancel URL with their cart intact,
 * and clearing on arrival would throw away the thing they were about to buy.
 * This renders only on a confirmation page for an order the server has
 * already seen as paid. */
import { useEffect } from "react";
import { useCart } from "./CartProvider";

export function ClearCartOnConfirm() {
  const cart = useCart();
  useEffect(() => {
    if (cart.ready && cart.lines.length) cart.clear();
  }, [cart]);
  return null;
}
