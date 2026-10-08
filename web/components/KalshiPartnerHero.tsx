"use client";

import { useEffect, useRef } from "react";

/* PBE Picks hero commercial block. The offer copy, economics, disclosure and
 * first-party referral URL are rendered only by the canonical kalshi-partner/2
 * client. Sports-market prices stay independent from this perpetuals offer. */
const CLIENT = "/kalshi-partner.js";
const CONFIG = "/go/kalshi-perps/config";

type PartnerModule = {
  loadPartnerConfig: (url: string) => Promise<unknown>;
  partnerOffer: (cfg: unknown, ctx: Record<string, string>, opts: Record<string, string>) => string;
};

export function KalshiPartnerHero() {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    (import(/* webpackIgnore: true */ CLIENT) as Promise<PartnerModule>)
      .then((m) => m.loadPartnerConfig(CONFIG).then((cfg) => m.partnerOffer(
        cfg,
        { placement: "pbe_picks_hero", product: "ufc", sport: "ufc" },
        { variant: "card", cls: "pbe-kalshi-hero" }
      )))
      .then((html) => {
        const el = slot.current;
        if (!live || !el || !html) return;
        el.innerHTML = html;
        el.hidden = false;
      })
      .catch(() => { /* fail closed */ });
    return () => { live = false; };
  }, []);

  return (
    <div ref={slot} className="pbe-kalshi-hero-slot" data-pbe-picks-partner-slot="" hidden>
      <noscript>Kalshi partner offer requires JavaScript.</noscript>
    </div>
  );
}
