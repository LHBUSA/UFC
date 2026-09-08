"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetch this page on an interval while the card is still live.
 *
 * IT POLLS OUR ROUTE AND NOTHING ELSE. The browser never contacts a publisher:
 * fanning out from every reader to ufc.com would multiply that site's load by
 * our readership, get us blocked, and make freshness depend on the visitor's
 * network rather than on our collection. The server fetches sources on its own
 * cadence; this only re-reads what the server already has.
 *
 * Which also means this interval does NOT set freshness. Fifteen seconds of
 * polling against a source read every three minutes learns nothing new for
 * most of those polls — the honest number is the publisher's own timestamp,
 * which the header shows.
 *
 * It stops when the card is finished (`enabled=false`), when the tab is
 * hidden, and it never runs during prerender. A finished weigh-in is a static
 * page and polling it forever would be pure waste on someone's phone.
 */
export function WeighInAutoRefresh({ seconds, enabled }: { seconds: number; enabled: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return undefined;
    const ms = Math.max(5, seconds) * 1000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      /* A background tab does not need live weights, and waking it costs the
       * reader battery for a page nobody is looking at. */
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      router.refresh();
    };

    const start = () => { if (!timer) timer = setInterval(tick, ms); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

    start();
    document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? start() : stop()));
    return () => { stop(); };
  }, [router, seconds, enabled]);

  return null;
}
