"use client";

import { useEffect, useRef } from "react";

/* Kalshi PERPETUALS partner offer (contract kalshi-partner/2) in the footer's
 * All Access commercial area. One per page (the footer renders once).
 *
 * Every word of copy and the link come from /kalshi-partner.js, vendored
 * byte-identical from propbetedge-workers (pinned by lib/kalshiPartner.test.ts).
 * Config is read same-origin through the /go/kalshi-perps/config rewrite.
 * Fails closed: a disabled, unverified-path or unreachable config renders
 * nothing, and the slot stays empty (it is the last commercial block of the
 * footer, so nothing above it moves).
 *
 * This is a commercial partner module, never model input: it is not placed
 * near fight cards, picks, PBEcast or any Kalshi market component. */
const CLIENT = "/kalshi-partner.js";
const CONFIG = "/go/kalshi-perps/config";

type PartnerModule = {
  loadPartnerConfig: (url: string) => Promise<unknown>;
  partnerOffer: (cfg: unknown, ctx: Record<string, string>, opts: Record<string, string>) => string;
};

export function KalshiPartnerOffer() {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    (import(/* webpackIgnore: true */ CLIENT) as Promise<PartnerModule>)
      .then((m) => m.loadPartnerConfig(CONFIG).then((cfg) => m.partnerOffer(cfg, { placement: "sport_footer", product: "ufc", sport: "ufc" }, { variant: "footer" })))
      .then((html) => {
        const el = slot.current;
        if (!live || !el || !html) return;
        el.innerHTML = html;
        el.hidden = false;
      })
      .catch(() => { /* fail closed: render nothing */ });
    return () => { live = false; };
  }, []);
  return <div ref={slot} className="kxo-slot" data-ufc-partner-slot="" hidden />;
}
