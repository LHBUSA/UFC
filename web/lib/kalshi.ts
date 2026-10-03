/* Kalshi Market Intelligence for UFC (contract market-intel/1).
 *
 * Public prediction-market data, read from our shared propsports-markets
 * Worker — never from Kalshi itself. It is a separate layer from the
 * sportsbook Market section (lib/market.ts), which stays Pro-only and
 * untouched: Kalshi prices are shown to every reader.
 *
 * The canonical event id is ufc_bouts.id (uuid). Outcome roles `a` / `b` are
 * our fighter_a / fighter_b. The UFC proposition is
 * `fighter_wins_bout_nc_draw_half`: a draw or no contest resolves 50/50, so
 * the card always carries UFC_KALSHI_NOTE beside it.
 *
 * No `server-only` / `@/` imports: node's test runner loads this file directly. */
import { ageLabel, algoVsMarketCard, algoVsMarketEvent, kalshiCard, kalshiLine, marketCloseLine, marketHistoryCard } from "../vendor/kalshi/kalshi-market-ui.js";
import type { AvmAlgo, AvmComparison, KalshiEntry } from "../vendor/kalshi/kalshi-market-ui.js";

export type { AvmAlgo, AvmComparison, KalshiEntry };

export const KALSHI_MARKETS_BASE = "https://propsports-markets.sales-fd3.workers.dev";
export const KALSHI_SPORT = "ufc";
export const UFC_KALSHI_NOTE = "A draw or no contest pays 50¢ per contract.";
/* First paint waits at most this long for the markets API; a slow or failed
 * read renders the page without the card and the client fills it in. */
export const KALSHI_SERVER_WAIT_MS = 1200;
export const KALSHI_REVALIDATE_S = 15;

type FetchLike = (url: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/* An entry is usable while it has a live block, or once it has a recorded
 * market (closed / settled history or a board close summary). A completed
 * bout keeps its market: pricing never disappears when the fight ends. */
const usableEntry = (e: unknown): e is KalshiEntry => {
  const x = e as KalshiEntry | null;
  return Boolean(x && x.event && x.event.canonical_event_id && (x.kalshi || x.market_history || x.market?.close));
};

/** Market lifecycle from the API (DISCOVERED | UPCOMING | ACTIVE | CLOSED | SETTLED), or null. */
export function marketLifecycle(entry: KalshiEntry | null | undefined): string | null {
  return entry?.market?.lifecycle ?? entry?.market_history?.lifecycle ?? null;
}
const closedOrSettled = (entry: KalshiEntry | null | undefined) => {
  const lc = marketLifecycle(entry);
  return lc === "CLOSED" || lc === "SETTLED";
};

async function readJson(url: string, fetchImpl: FetchLike, waitMs: number, revalidate = KALSHI_REVALIDATE_S): Promise<any | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(waitMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** One bout's entry with observed movement, or null (disabled, unmatched, slow, failed). */
export async function getKalshiEvent(boutId: string, { fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<KalshiEntry | null> {
  if (!boutId) return null;
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/market-intelligence/event/${KALSHI_SPORT}/${encodeURIComponent(boutId)}`, fetchImpl, waitMs);
  return body?.enabled && usableEntry(body.event) ? body.event : null;
}

/** The whole UFC board keyed by bout uuid; empty on any failure. */
export async function getKalshiBoard({ fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<Record<string, KalshiEntry>> {
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/market-intelligence/sport/${KALSHI_SPORT}`, fetchImpl, waitMs);
  const out: Record<string, KalshiEntry> = {};
  if (body?.enabled && Array.isArray(body.events)) {
    for (const e of body.events) if (usableEntry(e)) out[String(e.event.canonical_event_id)] = e;
  }
  return out;
}

/** Poll state. A settled market never changes again; a closed one only waits
 * for the venue's settlement; otherwise the API event state decides. */
export function kalshiPollState(entry: KalshiEntry | null | undefined): "live" | "pregame" | "closed" | "settled" | "idle" {
  const lc = marketLifecycle(entry);
  if (lc === "SETTLED") return "settled";
  if (lc === "CLOSED") return "closed";
  const s = entry?.event?.state;
  if (s === "in" || s === "live") return "live";
  if (s === "pre") return "pregame";
  return "idle";
}

/* Live 20 s / pregame 45 s come from the shared client; a closed market is
 * re-read every 5 minutes until it settles; a settled market is never polled. */
export const KALSHI_CLOSED_POLL_MS = 5 * 60_000;
export function kalshiPollMs(state: ReturnType<typeof kalshiPollState>, sharedPollMs: (s: string) => number): number | null {
  if (state === "settled") return null;
  if (state === "closed") return KALSHI_CLOSED_POLL_MS;
  return sharedPollMs(state);
}

/** Lifecycle label for the fight-page module (the MLB PBEcast standard):
 * [phase key, text], or null without an entry. The venue's market lifecycle
 * decides first (a finished fight is not a settled market); then the bout:
 * a result on file -> FIGHT FINAL while the market still trades; the API's
 * live bout state -> LIVE MARKET; otherwise pre-fight. A stale quote is never
 * labelled live. */
export function ufcMarketPhase(entry: KalshiEntry | null | undefined, { final = false }: { final?: boolean } = {}): [string, string] | null {
  if (!entry) return null;
  const lc = marketLifecycle(entry);
  if (lc === "SETTLED") return ["settled", "MARKET SETTLED"];
  if (lc === "CLOSED") return ["closed", "MARKET CLOSED · AWAITING SETTLEMENT"];
  if (final) return ["final-open", "FIGHT FINAL · MARKET STILL TRADING"];
  if (entry.kalshi?.freshness === "stale") return ["stale", "MARKET OPEN · LAST QUOTE STALE"];
  const s = entry.event?.state;
  if (s === "in" || s === "live") return ["live", "LIVE MARKET"];
  return ["pre", "MARKET OPEN · PRE-FIGHT"];
}

/** Fight-page module, directly under the faceoff for the whole bout lifecycle:
 * the full Market Pulse card (Mid-market, Updated Ns ago, movement, bid / ask,
 * View market on Kalshi) while the market trades, "How the market closed" in
 * the SAME place once it has closed or settled, always with the lifecycle
 * label and the UFC draw / no-contest note (the fight-winner contract resolves
 * 50/50 on either). "" without an entry or without anything to show. */
export function ufcKalshiCardHtml(entry: KalshiEntry | null | undefined, placement = "fight-page", { final = false }: { final?: boolean } = {}): string {
  const phase = ufcMarketPhase(entry, { final });
  if (!entry || !phase) return "";
  const body = closedOrSettled(entry)
    ? marketHistoryCard(entry, { placement }) || kalshiCard(entry, { placement })
    : kalshiCard(entry, { placement });
  if (!body) return "";
  return `<div class="ufc-mkt" data-phase="${phase[0]}"><div class="ufc-mkt-phase"><span class="ufc-mkt-dot" aria-hidden="true"></span>${phase[1]}</div>${body}<p class="ufc-kx__rule">${UFC_KALSHI_NOTE}</p></div>`;
}

/** Restrained compact line for a bout row: live prices while trading, the
 * market's close once the bout's market has closed or settled, or "". A result
 * card (`result`) never shows live prices: only the close line, when it has content. */
export function ufcKalshiLineHtml(entry: KalshiEntry | null | undefined, { result = false }: { result?: boolean } = {}): string {
  if (!entry) return "";
  if (closedOrSettled(entry)) return marketCloseLine(entry);
  return result ? "" : kalshiLine(entry);
}

/* ── ALGO vs MARKET ───────────────────────────────────────────────────────────
 * The PBE Fight Model's official call vs the Kalshi market, both frozen at the
 * PBE lock by the shared propsports-markets API (contract algo-vs-market/1).
 * Rendered only through the vendored algoVsMarketCard / algoVsMarketEvent,
 * which state their own rules. The API decides what is public: a pending UFC
 * call is status LOCKED with selections null until graded, and nothing here
 * adds a selection the API did not return. algos[] / comparisons[] empty,
 * slow or failed -> nothing rendered. Frozen data: re-read once a minute. */
export const AVM_REVALIDATE_S = 60;

/** Track-record payload ({ algos }) or null. */
export async function getAlgoVsMarket({ fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<{ algos: AvmAlgo[] } | null> {
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/algo-vs-market/${KALSHI_SPORT}`, fetchImpl, waitMs, AVM_REVALIDATE_S);
  return body && Array.isArray(body.algos) ? body : null;
}

/** One bout's comparisons ({ comparisons }) or null. */
export async function getAlgoVsMarketEvent(boutId: string, { fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<{ comparisons: AvmComparison[] } | null> {
  if (!boutId) return null;
  const body = await readJson(`${KALSHI_MARKETS_BASE}/v1/algo-vs-market/event/${KALSHI_SPORT}/${encodeURIComponent(boutId)}`, fetchImpl, waitMs, AVM_REVALIDATE_S);
  return body && Array.isArray(body.comparisons) ? body : null;
}

/** /algo/record module: one shared card per official algorithm with a comparison; "" while algos[] is empty. */
export function ufcAvmRecordHtml(payload: { algos?: AvmAlgo[] } | null | undefined): string {
  return (payload?.algos || []).map((a) => algoVsMarketCard(a, { recent: 10 })).join("");
}

/** Fight-page layer next to Market Pulse: corner roles a / b resolve to the bout's fighters; "" without a qualifying comparison. */
export function ufcAvmEventHtml(payload: { comparisons?: AvmComparison[] } | null | undefined, names: { a?: string | null; b?: string | null } = {}): string {
  return algoVsMarketEvent(payload, { nameOf: (_r, role) => (role === "a" ? names.a : role === "b" ? names.b : null) || null });
}

/* ── COMPACT CHIPS (presentation pass 2026-10-03) ─────────────────────────────
 * One normalized view of a board entry for every compact placement (homepage
 * hero, bout rows, matchup cards, schedule rows, Fight Week). Pure: values come
 * only from the API entry the page already read (one board read per page), and
 * the headline number is exactly the Market Pulse headline: the Mid-market,
 * fixed to one decimal ("64.5¢"). A side without a Mid-market (wide book) means
 * no compact chip at all: the full card shows the honest bid / ask instead.
 *
 * Labels: KALSHI is a prediction-market contract price, never "odds", never a
 * PBE model number. Open market: freshness from the API (live / delayed /
 * stale; stale is "Quote not current", never live). Closed / settled market:
 * only stored evidence from market.close (first observed, final trade, the
 * venue's settlement). UFC has no trusted start time, so there is no "before
 * start" price here and none is invented. */
export type UfcRole = "a" | "b";
export type UfcOpenSide = { role: UfcRole; bp: number; name: string };
export type UfcCloseSide = { role: UfcRole; name: string; firstBp: number | null; finalBp: number | null; result: "yes" | "no" | null };
export type UfcOpenQuote = { kind: "open"; boutId: string; ticker: string; marketUrl: string; freshness: string; ageSeconds: number | null; a: UfcOpenSide; b: UfcOpenSide; fav: UfcRole | null };
export type UfcClosedQuote = { kind: "closed" | "settled"; boutId: string; ticker: string; marketUrl: string; a: UfcCloseSide; b: UfcCloseSide; winner: UfcRole | null };
export type UfcQuote = UfcOpenQuote | UfcClosedQuote;

const isBp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Contract price in cents, one decimal, exactly as the Market Pulse headline prints it. */
export const kalshiCents = (bp: number): string => `${(bp / 100).toFixed(1)}¢`;
/** Movement in cents (unsigned, one decimal); the arrow carries the direction. */
export const kalshiMoveCents = (bp: number): string => (Math.abs(bp) / 100).toFixed(1);

/** Compact view of one bout's entry, or null when there is nothing honest to show.
 * `names` are our fighter names for roles a / b (the API's names are the fallback). */
export function ufcQuote(entry: KalshiEntry | null | undefined, names: { a?: string | null; b?: string | null } = {}): UfcQuote | null {
  if (!entry?.event?.canonical_event_id) return null;
  const boutId = String(entry.event.canonical_event_id);
  const lc = marketLifecycle(entry);
  const nameOf = (role: UfcRole, fallback: unknown) => (role === "a" ? names.a : names.b) || (typeof fallback === "string" && fallback) || (role === "a" ? "Fighter A" : "Fighter B");
  if (lc === "CLOSED" || lc === "SETTLED") {
    const c = entry.market?.close;
    const url = entry.market?.market_url || entry.kalshi?.market_url;
    const outs = (c?.outcomes || []) as Array<Record<string, unknown>>;
    const side = (role: UfcRole): UfcCloseSide | null => {
      const o = outs.find((x) => x.role === role);
      if (!o) return null;
      const res = o.result === "yes" || o.result === "no" ? o.result : null;
      return { role, name: nameOf(role, o.abbr), firstBp: isBp(o.first_bp) ? o.first_bp : null, finalBp: isBp(o.final_trade_bp) ? o.final_trade_bp : null, result: lc === "SETTLED" ? res : null };
    };
    const a = side("a"), b = side("b");
    if (!url || !a || !b) return null;
    const winner: UfcRole | null = a.result === "yes" ? "a" : b.result === "yes" ? "b" : null;
    const ticker = String(entry.kalshi?.event_ticker || entry.market_history?.event_ticker || "");
    return { kind: lc === "SETTLED" ? "settled" : "closed", boutId, ticker, marketUrl: url, a, b, winner };
  }
  const k = entry.kalshi;
  if (!k || k.state !== "open" || !k.market_url || !Array.isArray(k.outcomes) || k.outcomes.length !== 2) return null;
  if (!k.outcomes.every((o) => o.displayable)) return null;
  const oa = k.outcomes.find((o) => o.role === "a"), ob = k.outcomes.find((o) => o.role === "b");
  if (!oa || !ob || !isBp(oa.mid_bp) || !isBp(ob.mid_bp)) return null;
  const a: UfcOpenSide = { role: "a", bp: oa.mid_bp, name: nameOf("a", oa.abbr || oa.kalshi_name) };
  const b: UfcOpenSide = { role: "b", bp: ob.mid_bp, name: nameOf("b", ob.abbr || ob.kalshi_name) };
  const fav: UfcRole | null = a.bp > b.bp ? "a" : b.bp > a.bp ? "b" : null;
  return { kind: "open", boutId, ticker: String(k.event_ticker || ""), marketUrl: k.market_url, freshness: String(k.freshness || ""), ageSeconds: isBp(k.age_seconds) ? k.age_seconds : null, a, b, fav };
}

/** "Updated 2 min ago" / "Delayed · updated 4 min ago" / "Quote not current": never live on a stale quote. */
export function ufcFreshnessText(q: UfcOpenQuote): string {
  if (q.freshness === "stale") return "Quote not current";
  const age = ageLabel(q.ageSeconds);
  if (q.freshness === "delayed") return age ? `Delayed · updated ${age}` : "Delayed";
  return age ? `Updated ${age}` : "";
}

/* ── market tape: movement since first observed (stored data only) ──
 * GET /v1/market-tape?sport=ufc: each item's outcomes carry first_bp and
 * delta_first_bp, computed by the API from append-only observations. We never
 * compute movement ourselves; a delta is shown only while the tape's price for
 * that side equals the price on screen (the same observation), so a newer
 * board price never carries an older delta. */
export type UfcMoveSide = { priceBp: number; deltaBp: number };
export type UfcMove = { a: UfcMoveSide | null; b: UfcMoveSide | null };
export const TAPE_REVALIDATE_S = 60;

export function tapeMoves(body: unknown): Record<string, UfcMove> {
  const out: Record<string, UfcMove> = {};
  const classes = (body as { classes?: Record<string, unknown> } | null)?.classes;
  if (!classes || typeof classes !== "object") return out;
  for (const list of Object.values(classes)) {
    if (!Array.isArray(list)) continue;
    for (const it of list as Array<Record<string, any>>) {
      if (it?.sport !== KALSHI_SPORT || !it.canonical_event_id || out[it.canonical_event_id]) continue;
      const side = (role: UfcRole): UfcMoveSide | null => {
        const o = (it.outcomes || []).find((x: any) => x?.role === role);
        return o && isBp(o.price_bp) && isBp(o.delta_first_bp) ? { priceBp: o.price_bp, deltaBp: o.delta_first_bp } : null;
      };
      out[String(it.canonical_event_id)] = { a: side("a"), b: side("b") };
    }
  }
  return out;
}

/** Stored movement for one side, or null (no tape row, unchanged, or a different observation than the one shown). */
export function sideMove(move: UfcMove | null | undefined, side: UfcOpenSide): number | null {
  const m = move?.[side.role];
  if (!m || m.priceBp !== side.bp || m.deltaBp === 0) return null;
  return m.deltaBp;
}

/** UFC movement map from the market tape (one read per page); {} on any failure. */
export async function getKalshiMoves({ fetchImpl = fetch as FetchLike, waitMs = KALSHI_SERVER_WAIT_MS } = {}): Promise<Record<string, UfcMove>> {
  return tapeMoves(await readJson(`${KALSHI_MARKETS_BASE}/v1/market-tape?sport=${KALSHI_SPORT}`, fetchImpl, waitMs, TAPE_REVALIDATE_S));
}

/* ── PBE vs KALSHI compact line (Algo surfaces) ──
 * Only from a frozen Algo-vs-Market comparison (status AGREEMENT or
 * DISAGREEMENT) that carries the official PBE probability and the frozen
 * Mid-market of the SAME selection. LOCKED / pending rows reveal nothing. The
 * divergence is the difference of those two frozen numbers, in points. */
export type UfcAvmChip = { pbePct: number; kalshiPct: number; divergencePts: number; selection: string };
export function ufcAvmChip(c: AvmComparison | null | undefined): UfcAvmChip | null {
  if (!c || (c.status !== "AGREEMENT" && c.status !== "DISAGREEMENT")) return null;
  const sel = c.algo_selection;
  const p = c.algo_probability;
  const mid = sel ? (c.market?.prices?.[sel] as { mid_bp?: number | null } | undefined)?.mid_bp : null;
  if (!sel || !isBp(p) || !isBp(mid)) return null;
  const pbePct = Math.round(p * 1000) / 10;
  const kalshiPct = Math.round(mid) / 100;
  return { pbePct, kalshiPct, divergencePts: Math.round((pbePct - kalshiPct) * 10) / 10, selection: sel };
}

/** Comparisons by bout id from the track-record payload (one read). */
export function avmByBout(payload: { algos?: AvmAlgo[] } | null | undefined): Record<string, AvmComparison> {
  const out: Record<string, AvmComparison> = {};
  for (const a of payload?.algos || []) for (const r of a.ledger || []) if (r?.canonical_event_id && !out[r.canonical_event_id]) out[String(r.canonical_event_id)] = r;
  return out;
}

/** The fields the compact chips and the board refresh read, nothing else: what a
 * page hands to its client components (keeps the RSC payload small). The browser
 * refresh replaces these with full entries from the same API. */
export function slimEntry(e: KalshiEntry): KalshiEntry {
  const k = e.kalshi;
  const close = e.market?.close;
  return {
    event: { sport: e.event.sport, canonical_event_id: e.event.canonical_event_id, state: e.event.state ?? null, start_at: e.event.start_at ?? null },
    kalshi: k ? {
      market_url: k.market_url, event_ticker: k.event_ticker, state: k.state, freshness: k.freshness, age_seconds: k.age_seconds ?? null,
      outcomes: (k.outcomes || []).map((o) => ({ role: o.role, abbr: o.abbr ?? null, kalshi_name: o.kalshi_name ?? null, market_ticker: o.market_ticker, mid_bp: o.mid_bp ?? null, displayable: o.displayable, state: o.state, result: o.result ?? null })),
    } : null,
    market: e.market ? {
      lifecycle: e.market.lifecycle, market_url: e.market.market_url,
      close: close ? { lifecycle: close.lifecycle, shape: close.shape, outcomes: (close.outcomes || []).map((o) => ({ role: o.role, abbr: o.abbr, first_bp: o.first_bp ?? null, final_trade_bp: o.final_trade_bp ?? null, result: o.result ?? null })) } : null,
    } : null,
  };
}
export function slimBoard(board: Record<string, KalshiEntry>): Record<string, KalshiEntry> {
  const out: Record<string, KalshiEntry> = {};
  for (const [id, e] of Object.entries(board)) out[id] = slimEntry(e);
  return out;
}

/** One board read (+ optionally one market-tape read) for a page, narrowed to its
 * bouts and slimmed for the client. Failures resolve to empty maps. */
export async function getKalshiForBouts(boutIds: string[], { moves = false }: { moves?: boolean } = {}): Promise<{ board: Record<string, KalshiEntry>; moves: Record<string, UfcMove> }> {
  if (!boutIds.length) return { board: {}, moves: {} };
  const [raw, mv] = await Promise.all([getKalshiBoard(), moves ? getKalshiMoves() : Promise.resolve({} as Record<string, UfcMove>)]);
  const ids = boutIds.filter((id) => raw[id]);
  return {
    board: slimBoard(Object.fromEntries(ids.map((id) => [id, raw[id]]))),
    moves: Object.fromEntries(ids.filter((id) => mv[id]).map((id) => [id, mv[id]])),
  };
}
