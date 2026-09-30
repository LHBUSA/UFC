"use client";

import { useEffect } from "react";
import { PREFERRED_SOURCE_SDK, preferredSourceDeeplink, preferredSourceTarget } from "@/lib/preferredSource";

/* One delegated document listener for every [data-pbe-preferred-source]
 * control, installed once per page lifetime: controls rendered by later
 * client navigations are covered without rebinding, and it cannot
 * double-bind. Google's SDK loads in manual mode and is only invoked from the
 * click, so nothing depends on async script timing. */
type PreferredSourceApi = { init: (o: { theme?: string; lang?: string }) => void; addPreferredSource: () => void };

let sdkApi: PreferredSourceApi | null = null;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const w = window as any;
  const target = preferredSourceTarget(window.location.hostname);
  const href = preferredSourceDeeplink(target.source);

  document.addEventListener("click", (event) => {
    const el = (event.target as Element | null)?.closest?.("[data-pbe-preferred-source]") as HTMLAnchorElement | null;
    if (!el) return;
    // Previews and localhost follow this host's policy, not the production href.
    if (el.href !== href) el.href = href;

    let method = "deeplink_fallback";
    const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (!modified && sdkApi && target.sdk) {
      try {
        sdkApi.addPreferredSource();
        method = "sdk";
        event.preventDefault();
      } catch { /* fall through to the deeplink href */ }
    }
    w.gtag?.("event", "preferred_source_click", {
      surface: el.dataset.surface || "footer",
      sport: el.dataset.sport || "ufc",
      method,
    });
  });

  if (!target.sdk) return;
  (w.PREFERRED_SOURCE = w.PREFERRED_SOURCE || []).push((api: PreferredSourceApi) => {
    api.init({ theme: "dark", lang: "en" });
    sdkApi = api;
  });
  if (!document.querySelector(`script[src="${PREFERRED_SOURCE_SDK}"]`)) {
    const s = document.createElement("script");
    s.async = true;
    s.src = PREFERRED_SOURCE_SDK;
    s.setAttribute("preferred-sources-control", "manual");
    document.head.appendChild(s);
  }
}

export function PreferredSourceMount() {
  useEffect(install, []);
  return null;
}
