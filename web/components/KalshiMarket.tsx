"use client";
/* Kalshi prediction-market card and compact line (contract market-intel/1).
 *
 * PUBLIC: rendered for every reader, never behind the Pro gate that wraps the
 * sportsbook Market section. The vendored module returns escaped HTML strings;
 * this component only places them and keeps them fresh. The browser polls our
 * propsports-markets Worker (never Kalshi): live 20 s, pregame 45 s, idle 2 min.
 * No entry -> nothing rendered; a single empty or failed refresh keeps the last good card. */
import { useEffect, useMemo, useRef, useState } from "react";
import { __resetKalshiFlashes, wireKalshi } from "@/vendor/kalshi/kalshi-market-ui.js";
import { createKalshiClient, type KalshiClient } from "@/vendor/kalshi/kalshi-market-client.js";
import { KALSHI_MARKETS_BASE, KALSHI_SPORT, kalshiPollState, ufcKalshiCardHtml, ufcKalshiLineHtml, type KalshiEntry } from "@/lib/kalshi";

let shared: KalshiClient | null = null;
const client = () => (shared ??= createKalshiClient({ base: KALSHI_MARKETS_BASE, sport: KALSHI_SPORT }));

/* The module remembers the last price each placement showed (for its change
 * flash). On the server that memory would outlive the request and make the
 * HTML disagree with the client's first render, so it is cleared per render. */
const serverSafe = <T,>(render: () => T): T => {
  if (typeof window === "undefined") __resetKalshiFlashes();
  return render();
};

function usePoll(entry: KalshiEntry | null, load: () => Promise<KalshiEntry | null | undefined>, set: (e: KalshiEntry | null) => void) {
  const state = kalshiPollState(entry);
  /* The shared client cannot tell "no entry" from "request failed" on its very
   * first read, so one empty answer keeps the current card; two in a row remove it. */
  const misses = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || !document.hidden) {
        const next = await load();
        if (!alive) return;
        if (next) { misses.current = 0; set(next); }
        else if (++misses.current >= 2) set(null);
      }
      if (alive) timer = setTimeout(tick, client().pollMsFor(state));
    };
    /* First refresh right away: the server copy can be up to a page-revalidate old. */
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

/** Full card for one bout. `initial` comes from the server so it is in the first paint. */
export function KalshiMarketCard({ boutId, initial }: { boutId: string; initial: KalshiEntry | null }) {
  const [entry, setEntry] = useState<KalshiEntry | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  usePoll(entry, () => client().loadEvent(boutId, { force: true }), setEntry);
  const html = useMemo(() => serverSafe(() => ufcKalshiCardHtml(entry, "fight-page")), [entry]);
  useEffect(() => { if (html && ref.current) wireKalshi(ref.current); }, [html]);
  if (!html) return null;
  return (
    <section className="segment ufc-kx" id="kalshi" aria-label="Kalshi prediction market">
      <h3>Prediction market <small>Kalshi · public</small></h3>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

/** Restrained line inside a bout row. Every row shares one board request. */
export function KalshiBoutLine({ boutId, initial }: { boutId: string; initial: KalshiEntry | null }) {
  const [entry, setEntry] = useState<KalshiEntry | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  usePoll(entry, async () => {
    const c = client();
    await c.loadBoard();
    return c.forEvent(boutId);
  }, setEntry);
  const html = useMemo(() => ufcKalshiLineHtml(entry), [entry]);
  useEffect(() => { if (html && ref.current) wireKalshi(ref.current); }, [html]);
  if (!html) return null;
  return <div ref={ref} className="ufc-kx-line" dangerouslySetInnerHTML={{ __html: html }} />;
}
