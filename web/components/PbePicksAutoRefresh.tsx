"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the PBE Picks page and Upset Radar current using the existing server
 * data path. Backend scoring/market refresh remain authoritative; this merely
 * refreshes the rendered server tree every minute while the tab is visible.
 */
export function PbePicksAutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs < 15_000) return;

    const stop = () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };

    const start = () => {
      if (timer.current || document.visibilityState !== "visible" || !navigator.onLine) return;
      timer.current = setInterval(() => router.refresh(), intervalMs);
    };

    const catchUp = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      router.refresh();
      start();
    };

    const onVisibility = () => document.visibilityState === "visible" ? catchUp() : stop();
    const onOnline = () => catchUp();
    const onOffline = () => stop();

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [intervalMs, router]);

  return null;
}
