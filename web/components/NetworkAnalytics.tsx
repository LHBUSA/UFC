"use client";

import { useEffect } from "react";

function isProductionHost(host: string): boolean {
  const h = String(host || "").toLowerCase();
  return (h === "propbetedge.ai" || h.endsWith(".propbetedge.ai"))
    && !h.endsWith(".vercel.app")
    && !h.endsWith(".workers.dev")
    && !h.endsWith(".pages.dev")
    && h !== "localhost"
    && h !== "127.0.0.1";
}

export function NetworkAnalytics({ surface }: { surface: string }) {
  useEffect(() => {
    if (typeof window === "undefined" || !isProductionHost(window.location.hostname)) return;
    const p = (window as any).PBEPrivacy;
    p?.initAnalytics?.({ surface, analytics: true, sendPageView: true });
  }, [surface]);

  return null;
}
