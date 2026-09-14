"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/* After a Stripe return, re-run the server render a few times while the
 * webhook lands. It re-reads our own server decision and nothing else: the
 * browser never tells the server it paid, and a refresh can only reveal access
 * the ledger already grants. Stops after `attempts`. */
export function CheckoutVerifyRefresh({ seconds = 5, attempts = 12 }: { seconds?: number; attempts?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > attempts) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") router.refresh();
    }, Math.max(3, seconds) * 1000);
    return () => clearInterval(timer);
  }, [router, seconds, attempts]);
  return null;
}
