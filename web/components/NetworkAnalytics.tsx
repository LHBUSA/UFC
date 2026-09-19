"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

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

function sendPageView(surface: string) {
  if (typeof window === "undefined" || !isProductionHost(window.location.hostname)) return;
  const w = window as any;
  const current = window.location.href;
  if (w.__pbeGaLastLocation === current) return;
  w.__pbeGaLastLocation = current;
  w.gtag?.("event", "page_view", {
    page_title: document.title,
    page_location: current,
    page_path: window.location.pathname + window.location.search + window.location.hash,
    pbe_surface: surface,
  });
}

function initAnalytics(surface: string) {
  if (typeof window === "undefined" || !isProductionHost(window.location.hostname)) return;
  const w = window as any;
  if (w.__pbeGaInitialized) return;
  w.__pbeGaInitialized = true;
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  w.gtag("js", new Date());
  w.gtag("config", GA_ID, {
    cookie_domain: ".propbetedge.ai",
    cookie_flags: "SameSite=Lax;Secure",
    send_page_view: false,
  });

  if (!document.querySelector('script[data-pbe-ga4="1"]')) {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.pbeGa4 = "1";
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(script);
  }

  const trigger = () => setTimeout(() => sendPageView(surface), 0);
  for (const method of ["pushState", "replaceState"] as const) {
    const historyAny = history as any;
    const original = historyAny[method];
    if (!original || original.__pbeAnalyticsWrapped) continue;
    const wrapped = function (this: History, ...args: any[]) {
      const result = original.apply(this, args);
      trigger();
      return result;
    };
    (wrapped as any).__pbeAnalyticsWrapped = true;
    historyAny[method] = wrapped;
  }

  addEventListener("popstate", trigger);
  addEventListener("hashchange", trigger);

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
  const pathname = usePathname();

  useEffect(() => {
    initAnalytics(surface);
    sendPageView(surface);
  }, [surface]);

  useEffect(() => {
    setTimeout(() => sendPageView(surface), 0);
  }, [pathname, surface]);

  return null;
}
