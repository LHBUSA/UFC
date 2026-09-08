"use client";

/**
 * The cart, in the browser.
 *
 * It holds slugs, sizes, colours and quantities, and nothing else. No prices,
 * no totals, no variant ids. The subtotal shown to the customer is computed
 * from the catalog that shipped with the page, so it is correct, but it is
 * never sent anywhere: the checkout route resolves every price again from the
 * server's own copy. A cart that carries a price is a cart that can be edited
 * to carry a different one.
 *
 * localStorage is the right home for this and a poor one to rely on. It is
 * per-browser, survives a refresh, and is exactly what somebody expects of a
 * cart they did not sign in for. It also throws outright in some contexts —
 * a private window with site data blocked, a thumbnail render — so every
 * access is wrapped and an unreadable store simply means an empty cart rather
 * than a page that fails to render.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  CART_STORAGE_KEY,
  addLine,
  countUnits,
  lineKey,
  parseCart,
  setQty,
  type CartLine,
} from "@/lib/store/cart";

type CartApi = {
  lines: CartLine[];
  /** False until the stored cart has been read, so the server-rendered markup
   * and the first client render agree and React does not hydrate a mismatch. */
  ready: boolean;
  units: number;
  add: (line: CartLine) => void;
  setQuantity: (key: string, qty: number) => void;
  remove: (key: string) => void;
  clear: () => void;
};

const Ctx = createContext<CartApi | null>(null);

function read(): CartLine[] {
  try {
    return parseCart(window.localStorage.getItem(CART_STORAGE_KEY));
  } catch {
    return [];
  }
}

function write(lines: CartLine[]) {
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  } catch {
    /* A cart that cannot be persisted still works for this page view. */
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLines(read());
    setReady(true);
  }, []);

  /* Another tab is the same cart. Without this, two open tabs quietly
   * disagree and the last one to write wins. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === CART_STORAGE_KEY) setLines(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const commit = useCallback((next: CartLine[]) => {
    setLines(next);
    write(next);
  }, []);

  const api = useMemo<CartApi>(
    () => ({
      lines,
      ready,
      units: countUnits(lines),
      add: (line) => commit(addLine(lines, line)),
      setQuantity: (key, qty) => commit(setQty(lines, key, qty)),
      remove: (key) => commit(lines.filter((l) => lineKey(l) !== key)),
      clear: () => commit([]),
    }),
    [lines, ready, commit],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCart(): CartApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
