"use client";

/* Keeps /round-by-round current during a live card, and ONLY during one.
 *
 * The page is a server component on a 5-minute ISR cache. During a card that
 * is too slow: a fight finishes, its round observations land, and the page
 * would not show them for minutes. This asks the server for a fresh render on
 * an interval and lets React swap in the new tree.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * Not a stream, not a socket, not a new piece of infrastructure. It is
 * router.refresh() on a timer, using the data path the page already has.
 *
 * IT STOPS. The component is only mounted while the broadcast window is open
 * (see RoundLiveDeck), and on top of that it pauses whenever the tab is
 * hidden, so a page left open in a background tab all week costs nothing. The
 * visibility listener is removed on unmount — the weigh-in desk shipped with a
 * leaked one of exactly this shape, so it is cleaned up explicitly here.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function RoundLiveRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const stop = () => {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
    };
    const start = () => {
      if (timer.current) return;
      timer.current = setInterval(() => { router.refresh(); }, intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        /* Catch up immediately on return, then resume the interval — a reader
         * coming back to the tab should not wait a full cycle. */
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, router]);

  return null;
}
