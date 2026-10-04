"use client";
/* Kalshi prediction-market card and compact line (contract market-intel/1).
 *
 * PUBLIC: rendered for every reader, never behind the Pro gate that wraps the
 * sportsbook Market section. The vendored module returns escaped HTML strings;
 * this component only places them and keeps them fresh. The browser polls our
 * propsports-markets Worker (never Kalshi): live 20 s, pregame 45 s, idle 2 min,
 * closed 5 min until settled, settled never. Once the market closes or settles the
 * card becomes "How the market closed" (shared marketHistoryCard) in the same place.
 * No entry -> nothing rendered; a single empty or failed refresh keeps the last good card. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { __resetKalshiFlashes, venueChip, venueLines, wireKalshi, type DeskEvent } from "@/vendor/kalshi/kalshi-market-ui.js";
import { createKalshiClient, type KalshiClient } from "@/vendor/kalshi/kalshi-market-client.js";
import { KALSHI_MARKETS_BASE, KALSHI_SPORT, kalshiCents, kalshiMoveCents, kalshiPollMs, kalshiPollState, sideMove, ufcFreshnessText, ufcKalshiCardHtml, ufcQuote, type KalshiEntry, type UfcClosedQuote, type UfcMove, type UfcRole } from "@/lib/kalshi";

/* One shared client (canonical, vendored unchanged at ad6187a) for every
 * browser read: its loaders keep completed entries (closed / settled market
 * with history), one in-flight request per resource, a 15 s board cache
 * shared by every bout row, and a failed read is never cached as "no market"
 * (it returns the last good value the client itself read). */
let shared: KalshiClient | null = null;
const client = () => (shared ??= createKalshiClient({ base: KALSHI_MARKETS_BASE, sport: KALSHI_SPORT }));
const loadEvent = (boutId: string) => client().loadEvent(boutId, { force: true });

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
  /* One empty answer keeps the current card; two in a row remove it. Still
   * needed with ad6187a: the first card comes from the server, so the browser
   * client has no last good value of its own until its first successful read,
   * and a failed first read resolves to null. */
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

/* Other venues: the multi-venue desk is read in the browser after mount (never blocks the server render), then on
 * the card's own cadence; a failed read keeps the last good desk (shared client). A settled market stops it. */
function useDesk(id: string, entry: KalshiEntry | null, set: (d: DeskEvent | null) => void) {
  const state = kalshiPollState(entry);
  useEffect(() => {
    if (state === "settled") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || !document.hidden) { const d = await client().loadDesk(id); if (alive) set(d); }
      const ms = kalshiPollMs(state, (s) => client().pollMsFor(s));
      if (alive && ms != null) timer = setTimeout(tick, ms);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, state]);
}

/** MARKET PULSE for one bout, directly under the faceoff. VENUE-NEUTRAL: the canonical bout is the parent, never
 * Kalshi. The Kalshi card (lifecycle label + shared card) and the other venues (shared venueLines: Polymarket as a
 * qualifying quote, a labelled related market, or the only listing) are computed INDEPENDENTLY; the section renders
 * when either exists — Kalshi only, Polymarket only, both — and is absent when neither does. `initial` / `initialDesk`
 * come from the server so they are in the first paint. `final`: the bout has a result. */
export function KalshiMarketCard({ boutId, initial, initialDesk = null, completed = false, final = false }: { boutId: string; initial: KalshiEntry | null; initialDesk?: DeskEvent | null; completed?: boolean; final?: boolean }) {
  const [entry, setEntry] = useState<KalshiEntry | null>(initial);
  const [desk, setDesk] = useState<DeskEvent | null>(initialDesk);
  const ref = useRef<HTMLDivElement>(null);
  usePoll(entry, () => loadEvent(boutId), setEntry, { once: completed && !initialDesk });
  useDesk(boutId, entry, setDesk);
  const html = useMemo(() => serverSafe(() => ufcKalshiCardHtml(entry, "fight-page", { final })), [entry, final]);
  const venues = useMemo(() => venueLines(desk, { placement: "fight-page-venues", standalone: !html }), [html, desk]);
  useEffect(() => { if ((html || venues) && ref.current) wireKalshi(ref.current); }, [html, venues]);
  if (!html && !venues) return null;
  return (
    <section className="ufc-kx ufc-kx--top" id="kalshi" data-market-pulse="" aria-label="Market Pulse: prediction markets">
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html + venues }} />
    </section>
  );
}

/* ── ONE BOARD PER PAGE ───────────────────────────────────────────────────────
 * The page's server component reads the UFC board ONCE (lib/kalshi.ts) and
 * hands it to <KalshiBoard>. Every compact placement under it (hero, bout rows,
 * matchup cards, schedule rows, Fight Week) reads its bout from this context,
 * so the browser refresh is ONE loop and ONE board request per cycle through
 * the shared client (client().loadBoard(): 15 s cache, one in-flight request).
 * Cadence follows the most active entry: live 20 s, pregame 45 s, idle 2 min,
 * closed 5 min, all settled -> no polling. Nothing is inserted after first
 * paint: a bout without a server entry never grows a chip (zero layout shift).
 * A bout missing from two successful refreshes in a row is removed; one empty
 * or failed refresh keeps the last good entry. */
type Board = Record<string, KalshiEntry>;
const BoardContext = createContext<Board | null>(null);
/* Desk board (venue-neutral): every bout with a market on any venue, for compact venue cues (<VenueCue>). */
type DeskBoard = Record<string, DeskEvent>;
const DeskContext = createContext<DeskBoard | null>(null);

export function KalshiBoard({ initial, desk: initialDesk = {}, children }: { initial: Board; desk?: DeskBoard; children: React.ReactNode }) {
  const [desk, setDesk] = useState<DeskBoard>(initialDesk);
  /* The desk board refreshes on the idle cadence (2 min): venue cues change slowly; a failed read keeps the last one. */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || !document.hidden) {
        const map = await client().loadDeskBoard();
        if (!alive) return;
        if (map.size || !Object.keys(initialDesk).length) setDesk(Object.fromEntries(map));
      }
      if (alive) timer = setTimeout(tick, client().pollMsFor("idle"));
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <DeskContext.Provider value={desk}><KalshiBoardInner initial={initial}>{children}</KalshiBoardInner></DeskContext.Provider>;
}

function KalshiBoardInner({ initial, children }: { initial: Board; children: React.ReactNode }) {
  const [board, setBoard] = useState<Board>(initial);
  const misses = useRef<Record<string, number>>({});
  const pollMs = useMemo(() => {
    let ms: number | null = null;
    for (const e of Object.values(board)) {
      const m = kalshiPollMs(kalshiPollState(e), (s) => client().pollMsFor(s));
      if (m != null && (ms == null || m < ms)) ms = m;
    }
    return ms;
  }, [board]);
  useEffect(() => {
    if (pollMs == null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || !document.hidden) {
        const map = await client().loadBoard();
        if (!alive) return;
        setBoard((prev) => {
          const next: Board = {};
          let changed = false;
          for (const id of Object.keys(prev)) {
            const fresh = map.get(id);
            if (fresh) { misses.current[id] = 0; next[id] = fresh; if (fresh !== prev[id]) changed = true; }
            else if ((misses.current[id] = (misses.current[id] || 0) + 1) < 2) next[id] = prev[id];
            else changed = true;
          }
          return changed ? next : prev;
        });
      }
      if (alive) timer = setTimeout(tick, pollMs);
    };
    /* Refresh right away (the server copy can be a page-revalidate old), then on cadence. */
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [pollMs]);
  return <BoardContext.Provider value={board}>{children}</BoardContext.Provider>;
}

/** Compact venue cue for list / card surfaces ("MARKET · POLYMARKET  Allen 61.5¢ · Duncan 38.5¢"): every venue other
 * than Kalshi with a current market on this bout (Kalshi keeps its own chip). Independent of Kalshi: shown whether or not
 * Kalshi lists the bout. `result`: a finished bout shows no live venue price. */
export function VenueCue({ boutId, initial = null, result = false, wrapClass = null }: { boutId: string; initial?: DeskEvent | null; result?: boolean; wrapClass?: string | null }) {
  const desk = useContext(DeskContext);
  const d = desk ? desk[boutId] ?? initial : initial;
  const html = useMemo(() => (result ? "" : venueChip(d)), [d, result]);
  if (!html) return null;
  const cue = <span className="ufc-vc" data-ufc-vc={boutId} dangerouslySetInnerHTML={{ __html: html }} />;
  return wrapClass ? <span className={wrapClass}>{cue}</span> : cue;
}

/** This bout's entry: the page board when mounted under <KalshiBoard>, else the server copy. */
function useBoardEntry(boutId: string, initial: KalshiEntry | null): KalshiEntry | null {
  const board = useContext(BoardContext);
  if (!board) return initial;
  return board[boutId] ?? null;
}

/* ── COMPACT CHIP ─────────────────────────────────────────────────────────────
 * Cool-blue prediction-market chip (kalshi-ufc.css), visually apart from the
 * gold sportsbook ML chip and the gold PBE intelligence treatment.
 *   hero  — one fighter's price under the hero name plate: "KALSHI 66.5¢"
 *           (+ "MARKET FAVORITE" when no sportsbook line is shown).
 *   pair  — bout / schedule rows: "KALSHI 66.5¢ / 33.5¢ · Updated 2 min ago".
 *   named — matchup cards / Fight Week: "KALSHI · Silva 66.5¢ | Wang 33.5¢",
 *           optional stored movement, linked to the market on Kalshi.
 * Closed / settled markets: only stored evidence (first observed, final trade,
 * venue settlement). `result`: our bout has a result, so open prices are never
 * shown on that row (a finished fight is not a live quote). */
type Names = { a?: string | null; b?: string | null };
type ChipProps = {
  boutId: string;
  initial: KalshiEntry | null;
  names?: Names;
  variant: "hero" | "pair" | "named";
  side?: UfcRole;
  favLabel?: boolean;
  result?: boolean;
  move?: UfcMove | null;
  link?: boolean;
  placement: string;
};

function Arrow({ d }: { d: number | null }) {
  if (d == null) return null;
  return <span className={`ufc-kc__mv ${d > 0 ? "up" : "down"}`}>{d > 0 ? "▲" : "▼"}{kalshiMoveCents(d)}</span>;
}

function ClosedBody({ q }: { q: UfcClosedQuote }) {
  const w = q.winner ? q[q.winner] : null;
  /* The side the line follows: the venue's YES side, else the higher final trade. */
  const focus = w || (q.a.finalBp != null && q.b.finalBp != null ? (q.a.finalBp >= q.b.finalBp ? q.a : q.b) : null);
  const path = focus ? [focus.firstBp != null ? `${kalshiCents(focus.firstBp)} first observed` : null, focus.finalBp != null ? `${kalshiCents(focus.finalBp)} final trade` : null].filter(Boolean).join(" → ") : "";
  return (
    <>
      <span className="ufc-kc__b">{q.kind === "settled" ? "MARKET SETTLED" : "MARKET CLOSED"}</span>
      {w ? <span className="ufc-kc__who">{w.name} · YES</span> : q.kind === "closed" ? <span className="ufc-kc__fr">Awaiting settlement</span> : null}
      {focus && path ? <span className="ufc-kc__fr">{w ? "" : `${focus.name} `}{path}</span> : null}
    </>
  );
}

export function KalshiChip({ boutId, initial, names, variant, side, favLabel = false, result = false, move = null, link = false, placement }: ChipProps) {
  const entry = useBoardEntry(boutId, initial);
  const ref = useRef<HTMLElement | null>(null);
  const q = useMemo(() => ufcQuote(entry, names), [entry, names?.a, names?.b]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = q ? (q.kind === "open" ? `${q.a.bp}|${q.b.bp}|${q.freshness}` : q.kind) : "";
  useEffect(() => { if (key && ref.current?.parentElement) wireKalshi(ref.current.parentElement); }, [key]);
  if (!q || (q.kind === "open" && result)) return null;
  const stale = q.kind === "open" && q.freshness === "stale";
  const live = q.kind === "open" && q.freshness === "live";
  const data = {
    "data-ufc-kc": placement, "data-kx-impression": "", "data-kx-sport": "ufc", "data-kx-event": q.boutId,
    "data-kx-ticker": q.ticker, "data-kx-placement": `ufc-${placement}`, "data-kx-age": q.kind === "open" ? String(q.ageSeconds ?? "") : "",
    "data-kx-state": q.kind === "open" ? (stale ? "stale" : q.freshness || "open") : q.kind,
  };
  const cls = `ufc-kc ufc-kc--${variant}${q.kind !== "open" ? " is-closed" : ""}${stale ? " is-stale" : ""}`;
  const title = q.kind === "open"
    ? `Kalshi prediction market: Mid-market contract price (a YES contract pays $1 if that fighter wins; a draw or no contest pays 50¢). Not sportsbook odds and not a PropBetEdge model.${stale ? " Quote not current." : ""}`
    : `Kalshi prediction market, ${q.kind === "settled" ? "settled by the venue" : "closed and awaiting the venue's settlement"}. Stored observations only.`;

  let body: React.ReactNode;
  if (variant === "hero" && side) {
    const s = q.kind === "open" ? null : q[side];
    body = q.kind !== "open"
      ? <><span className="ufc-kc__b">KALSHI</span><span className="ufc-kc__fr">{q.kind === "settled" && s?.result ? `SETTLED ${s.result.toUpperCase()}` : "MARKET CLOSED"}</span></>
      : stale
        ? <><span className="ufc-kc__b">KALSHI</span><span className="ufc-kc__fr">Quote not current</span></>
        : <><span className="ufc-kc__b">KALSHI</span><span className="ufc-kc__px">{kalshiCents(q[side].bp)}</span>{favLabel && q.fav === side ? <span className="ufc-kc__tag">MARKET FAVORITE</span> : null}</>;
  } else if (q.kind !== "open") {
    body = <ClosedBody q={q} />;
  } else if (variant === "pair") {
    const fresh = ufcFreshnessText(q);
    body = (
      <>
        <span className="ufc-kc__b">KALSHI</span>
        <span className="ufc-kc__px">{kalshiCents(q.a.bp)}<i aria-hidden="true"> / </i>{kalshiCents(q.b.bp)}</span>
        {live ? <span className="kx__pulse" aria-hidden="true" /> : null}
        {fresh ? <span className="ufc-kc__fr">{fresh}</span> : null}
      </>
    );
  } else {
    const fresh = ufcFreshnessText(q);
    const ma = sideMove(move, q.a), mb = sideMove(move, q.b);
    body = (
      <>
        <span className="ufc-kc__b">KALSHI</span>
        <span className="ufc-kc__side"><span className="ufc-kc__who">{q.a.name}</span> <span className="ufc-kc__px">{kalshiCents(q.a.bp)}</span><Arrow d={ma} /></span>
        <i className="ufc-kc__sep" aria-hidden="true">|</i>
        <span className="ufc-kc__side"><span className="ufc-kc__who">{q.b.name}</span> <span className="ufc-kc__px">{kalshiCents(q.b.bp)}</span><Arrow d={mb} /></span>
        {ma != null || mb != null ? <span className="ufc-kc__fr">since first observed</span> : null}
        {live ? <span className="kx__pulse" aria-hidden="true" /> : null}
        {fresh ? <span className="ufc-kc__fr">{fresh}</span> : null}
      </>
    );
  }
  const setRef = (el: HTMLElement | null) => { ref.current = el; };
  if (link) {
    return <a ref={setRef} className={cls} href={q.marketUrl} target="_blank" rel="noopener noreferrer sponsored" data-kx-click="" title={title} {...data}>{body}</a>;
  }
  return <span ref={setRef} className={cls} title={title} {...data}>{body}</span>;
}

/** Bout-row line (event page, homepage card): the pair chip on its own full-width row.
 * `result`: the bout has a result, so only the market's closed / settled treatment may appear. */
export function KalshiBoutLine({ boutId, initial, result = false, names }: { boutId: string; initial: KalshiEntry | null; result?: boolean; names?: Names }) {
  const entry = useBoardEntry(boutId, initial);
  const q = useMemo(() => ufcQuote(entry, names), [entry, names?.a, names?.b]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q || (q.kind === "open" && result)) return null;
  return <div className="ufc-kx-line"><KalshiChip boutId={boutId} initial={initial} names={names} variant="pair" result={result} placement="bout-row" /></div>;
}
