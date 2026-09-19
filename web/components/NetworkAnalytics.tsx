"use client";

import { useEffect } from "react";

const GA_ID = "G-BRS48R8PG9";

function isProductionHost(host: string): boolean {
  const h = String(host || "").toLowerCase();
  return (h === "propbetedge.ai" || h.endsWith(".propbetedge.ai"))
    && !h.endsWith(".vercel.app")
    && !h.endsWith(".workers.dev")
    && !h.endsWith(".pages.dev")
    && h !== "localhost"
    && h !== "127.0.0.1";
}

function initAnalytics(surface: string) {
  if (typeof window === "undefined" || !isProductionHost(window.location.hostname)) return;
  const w = window as any;
  if (w.__pbeGaInitialized) return;
  w.__pbeGaInitialized = true;

  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  w.gtag("js", new Date());
  w.gtag("set", { pbe_surface: surface });
  w.gtag("config", GA_ID, {
    cookie_domain: ".propbetedge.ai",
    cookie_flags: "SameSite=Lax;Secure",
  });

  if (!document.querySelector('script[data-pbe-ga4="1"]')) {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.pbeGa4 = "1";
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(script);
  }

  document.addEventListener("click", (event) => {
    const node = event.target as Element | null;
    const anchor = node?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    try {
      const url = new URL(anchor.href, window.location.href);
      const host = window.location.hostname.toLowerCase();
      if (url.hostname !== host && (url.hostname === "propbetedge.ai" || url.hostname.endsWith(".propbetedge.ai"))) {
        w.gtag?.("event", "pbe_network_click", {
          pbe_surface: surface,
          source_host: host,
          target_host: url.hostname,
          link_url: url.href,
        });
      }
    } catch {
      // Ignore malformed href values.
    }
  }, { capture: true });
}

export function NetworkAnalytics({ surface }: { surface: string }) {
  useEffect(() => {
    initAnalytics(surface);
  }, [surface]);

  return null;
}
