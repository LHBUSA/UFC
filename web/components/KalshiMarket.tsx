"use client";
/* Kalshi prediction-market card and compact line (contract market-intel/1).
 *
 * PUBLIC: rendered for every reader, never behind the Pro gate that wraps the
 * sportsbook Market section. The vendored module returns escaped HTML strings;
 * this component only places them and keeps them fresh. The browser polls our
 * propsports-markets Worker (never Kalshi): live 20 s, pregame 45 s, idle 2 min,
 * closed 5 min until settled, settled never. Once the market closes or settles the
 * card becomes "How the market closed" (shared marketModule) with no release.
 * No entry -> nothing rendered; a single empty or failed refresh keeps the last good card. */
import { useEffect, useMemo, useRef, useState } from "react";
import { __resetKalshiFlashes, wireKalshi } from "@/vendor/kalshi/kalshi-market-ui.js";
import { createKalshiClient, type KalshiClient } from "@/vendor/kalshi/kalshi-market-client.js";
import { KALSHI_MARKETS_BASE, KALSHI_SPORT, getKalshiBoard, getKalshiEvent, kalshiPollMs, kalshiPollState, ufcKalshiCardHtml, ufcKalshiLineHtml, type KalshiEntry } from "@/lib/kalshi";

let shared: KalshiClient | null = null;
const client = () => (shared ??= createKalshiClient({ base: KALSHI_MARKETS_BASE, sport: KALSHI_SPORT }));

/* Browser reads go through lib/kalshi (our Worker, never Kalshi) rather than
 * the shared client's loaders, because those drop entries whose live block is
 * gone — a closed or settled market keeps its history and must stay on the page.
 * One board request is shared by every bout row (15 s, like the shared client). */
const BROWSER_WAIT_MS = 8000;
let board: { at: number; value: Promise<Record<string, KalshiEntry>> } | null = null;
const loadBoard = () => {
  if (!board || Date.now() - board.at > 15_000) board = { at: Date.now(), value: getKalshiBoard({ waitMs: BROWSER_WAIT_MS }) };
  return board.value;
};

/* The module remembers the last price each placement showed (for its change
 * flash). On the server that memory would outlive the request and make the
 * HTML disagree with the client's first render, so it is cleared per render. */
const serverSafe = <T,>(render: () => T): T => {
  if (typeof window === "undefined") __resetKalshiFlashes();
  return render();
};

/* Live 20 s / pregame 45 s / idle 2 min (shared client), closed 5 min until it
 * settles, settled never. `once`: a completed bout with no entry is checked a
 * single time (a market cannot open for a fight that is over). */
function usePoll(entry: KalshiEntry | null, load: () => Promise<KalshiEntry | null | undefined>, set: (e: KalshiEntry | null) => void, { once = false }: { once?: boolean } = {}) {
  const state = kalshiPollState(entry);
  /* One empty answer keeps the current card (it may be a failed request);
   * two in a row remove it. */
  const misses = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: KalshiEntry | null | undefined = undefined;
      if (typeof document === "undefined" || !document.hidden) {
        next = await load();
        if (!alive) return;
        if (next) { misses.current = 0; set(next); }
        else if (++misses.current >= 2) set(null);
      }
      /* The new entry re-runs this effect when its state changes; only keep
       * ticking here while the state is unchanged. */
      if (next && kalshiPollState(next) !== state) return;
      if (!entry && !next && once) return;
      const ms = kalshiPollMs(state, (s) => client().pollMsFor(s));
      if (alive && ms != null) timer = setTimeout(tick, ms);
    };
    /* A settled market never changes: no request at all. Otherwise refresh
     * right away (the server copy can be up to a page-revalidate old). */
    if (state !== "settled") tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

/** Full card for one bout. `initial` comes from the server so it is in the first paint. */
export function KalshiMarketCard({ boutId, initial, completed = false }: { boutId: string; initial: KalshiEntry | null; completed?: boolean }) {
  const [entry, setEntry] = useState<KalshiEntry | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  usePoll(entry, () => getKalshiEvent(boutId, { waitMs: BROWSER_WAIT_MS }), setEntry, { once: completed });
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

/** Restrained line inside a bout row. Every row shares one board request.
 * `result`: the bout has a result, so the row is a result card and only the
 * market's close line (marketCloseLine) may appear — never live prices. */
export function KalshiBoutLine({ boutId, initial, result = false }: { boutId: string; initial: KalshiEntry | null; result?: boolean }) {
  const [entry, setEntry] = useState<KalshiEntry | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  usePoll(entry, async () => (await loadBoard())[boutId] ?? null, setEntry);
  const html = useMemo(() => ufcKalshiLineHtml(entry, { result }), [entry, result]);
  useEffect(() => { if (html && ref.current) wireKalshi(ref.current); }, [html]);
  if (!html) return null;
  return <div ref={ref} className="ufc-kx-line" dangerouslySetInnerHTML={{ __html: html }} />;
}
