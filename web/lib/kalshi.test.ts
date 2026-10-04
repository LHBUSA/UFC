/* Kalshi Market Intelligence on UFC: rendering contract, public placement,
 * no direct Kalshi API calls, vendored files byte-identical to the canonical source.
 *
 *   npm --prefix web run test:kalshi */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAlgoVsMarket, getAlgoVsMarketEvent, ufcAvmEventHtml, ufcAvmRecordHtml, getKalshiBoard, getKalshiEvent, kalshiPollMs, kalshiPollState, ufcKalshiCardHtml, ufcKalshiLineHtml, ufcMarketPhase, UFC_KALSHI_NOTE, KALSHI_MARKETS_BASE, KALSHI_CLOSED_POLL_MS, avmByBout, getKalshiMoves, kalshiCents, kalshiMoveCents, sideMove, slimEntry, tapeMoves, ufcAvmChip, ufcFreshnessText, ufcQuote } from "./kalshi.ts";
import type { KalshiEntry } from "./kalshi.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUT = "b8503792-7950-445b-8f3a-2afb5cb5ad6d";

/* Shape captured from GET /v1/market-intelligence/sport/ufc (UFC 332 card, 2026-10-03). */
function entry(over: Partial<KalshiEntry["kalshi"] & object> = {}): KalshiEntry {
  const outcome = (role: string, abbr: string, name: string, bid: number, ask: number, ticker: string) => ({
    role, abbr, kalshi_name: name, contract: `${name} wins`, market_ticker: ticker, state: "open", result: null,
    best_yes_bid_bp: bid, best_yes_ask_bp: ask, last_price_bp: ask, mid_bp: (bid + ask) / 2,
    volume: 30979.81, open_interest: 28129.16, spread_bp: ask - bid, displayable: true,
  });
  return {
    event: { sport: "ufc", competition: "ufc", canonical_event_id: BOUT, start_at: null, state: "pre" },
    kalshi: {
      source: "kalshi", market_url: "https://kalshi.com/markets/kxufcfight/ufc-fight/kxufcfight-26oct03rodcor",
      event_ticker: "KXUFCFIGHT-26OCT03RODCOR", proposition: "fighter_wins_bout_nc_draw_half",
      state: "open", freshness: "live", age_seconds: 36,
      outcomes: [
        outcome("a", "Imanol Rodriguez", "Imanol Rodriguez Pillado", 5500, 5600, "KXUFCFIGHT-26OCT03RODCOR-ROD"),
        outcome("b", "Alden Coria", "Alden Coria", 4300, 4400, "KXUFCFIGHT-26OCT03RODCOR-COR"),
      ],
      ...over,
    },
    sportsbooks: null, pbe: null, comparisons: [],
  };
}

test("no entry renders nothing", () => {
  assert.equal(ufcKalshiCardHtml(null), "");
  assert.equal(ufcKalshiCardHtml(undefined), "");
  assert.equal(ufcKalshiLineHtml(null), "");
  assert.equal(ufcKalshiCardHtml({ ...entry(), kalshi: null }), "");
  /* no link, no card */
  assert.equal(ufcKalshiCardHtml(entry({ market_url: "" } as never)), "");
  /* a stale market is not shown as a compact line */
  assert.equal(ufcKalshiLineHtml(entry({ freshness: "stale" } as never)), "");
});

test("UFC card renders both fighters, the Kalshi labels and the draw / no-contest note", () => {
  const html = ufcKalshiCardHtml(entry());
  assert.match(html, /Imanol Rodriguez/);
  assert.match(html, /Alden Coria/);
  assert.match(html, /55\.5¢/);
  assert.match(html, /43\.5¢/);
  assert.match(html, /Mid-market/);
  assert.match(html, /not sportsbook odds and not a PropBetEdge model/);
  assert.ok(html.includes(UFC_KALSHI_NOTE), "UFC note beside the card");
  assert.equal(UFC_KALSHI_NOTE, "A draw or no contest pays 50¢ per contract.");
  /* the note follows the card, never replaces it */
  assert.ok(html.indexOf(UFC_KALSHI_NOTE) > html.indexOf("Market Pulse"));
  assert.match(html, /no sportsbook line required/);
});

test("every Kalshi link opens the verified market with rel sponsored", () => {
  for (const html of [ufcKalshiCardHtml(entry())]) {
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length >= 3, "two prices + CTA");
    for (const a of anchors) {
      assert.match(a, /href="https:\/\/kalshi\.com\/markets\/kxufcfight\//);
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener noreferrer sponsored"/);
    }
  }
});

test("compact line shows both fighters' Mid-market and no anchor (it sits inside the bout-row link)", () => {
  const line = ufcKalshiLineHtml(entry());
  assert.match(line, /KALSHI/);
  assert.match(line, /Imanol Rodriguez 55\.5¢ · Alden Coria 43\.5¢/);
  assert.doesNotMatch(line, /<a\b/);
});

test("values are escaped", () => {
  const e = entry();
  e.kalshi!.outcomes[0].abbr = '<img src=x onerror="alert(1)">';
  const html = ufcKalshiCardHtml(e);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("poll state maps the API event state", () => {
  assert.equal(kalshiPollState(entry()), "pregame");
  assert.equal(kalshiPollState({ ...entry(), event: { ...entry().event, state: "in" } }), "live");
  assert.equal(kalshiPollState({ ...entry(), event: { ...entry().event, state: "post" } }), "idle");
  assert.equal(kalshiPollState(null), "idle");
  /* market lifecycle wins: closed -> 5 min until settled; settled -> never */
  const shared = (s: string) => (s === "live" ? 20_000 : s === "pregame" ? 45_000 : 120_000);
  assert.equal(kalshiPollMs(kalshiPollState(entry()), shared), 45_000);
  assert.equal(kalshiPollMs(kalshiPollState({ ...entry(), event: { ...entry().event, state: "in" } }), shared), 20_000);
  assert.equal(kalshiPollState(closedEntry()), "closed");
  assert.equal(kalshiPollMs("closed", shared), KALSHI_CLOSED_POLL_MS);
  assert.equal(KALSHI_CLOSED_POLL_MS, 300_000);
  assert.equal(kalshiPollState(settledEntry()), "settled");
  assert.equal(kalshiPollMs("settled", shared), null);
});

/* ── market history: the REAL settled tennis event (Rybakina vs Charaeva, captured
 * from GET /v1/market-intelligence/event/tennis/00a0f4e8-…) reshaped ONLY for sport
 * and ids — every price, timestamp and settlement is the stored value. ── */
const REAL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kalshi-settled-tennis-real.json"), "utf8"));
function settledEntry(): KalshiEntry {
  const e = structuredClone(REAL.event);
  e.event.sport = "ufc";
  e.event.competition = "ufc";
  e.event.canonical_event_id = BOUT;
  return e;
}
function closedEntry(): KalshiEntry {
  const e = settledEntry() as any;
  e.market.lifecycle = "CLOSED";
  e.market.close.lifecycle = "CLOSED";
  for (const o of e.market.close.outcomes) o.result = null;
  e.market_history.lifecycle = "CLOSED";
  e.market_history.status_label = "Market closed";
  for (const o of e.market_history.outcomes) o.settlement = null;
  e.kalshi.state = "closed";
  return e;
}

test("SETTLED: real history renders 'How the market closed' with stored values, venue settlement and the UFC note", () => {
  const html = ufcKalshiCardHtml(settledEntry());
  assert.match(html, /How the market closed/);
  assert.doesNotMatch(html, /Market Pulse/, "history replaces the live card");
  assert.match(html, /Alina Charaeva/);
  assert.match(html, /Elena Rybakina/);
  assert.match(html, /First observed/);
  assert.doesNotMatch(html, /<small>Open|opened at/i, "first observed is never labelled an opening price");
  assert.match(html, /5\.5¢/, "Charaeva first observed 5.5¢");
  assert.match(html, /Final trade/);
  assert.match(html, /Settled YES/);
  assert.match(html, /Kalshi settlement: <b>Alina Charaeva<\/b> — YES/);
  assert.match(html, /Settlement is the market venue's, not our result/);
  assert.match(html, /not the opening price/, "partial history is stated");
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /style="/, "no inline styles (strict CSP)");
  assert.ok(html.includes(UFC_KALSHI_NOTE), "draw / NC note stays with the history");
  assert.doesNotMatch(html, /earlier|more accurate|stale/i);
});

test("CLOSED: shows 'Market closed · awaiting settlement' and no settlement claim", () => {
  const html = ufcKalshiCardHtml(closedEntry());
  assert.match(html, /How the market closed/);
  assert.match(html, /Market closed · awaiting settlement/);
  assert.match(html, /Awaiting settlement/);
  assert.doesNotMatch(html, /Settled YES|Settled NO/);
  const line = ufcKalshiLineHtml(closedEntry(), { result: true });
  assert.match(line, /awaiting settlement/);
});

test("history links: every anchor is the verified market with rel sponsored", () => {
  for (const html of [ufcKalshiCardHtml(settledEntry()), ufcKalshiCardHtml(closedEntry())]) {
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length >= 1);
    for (const a of anchors) {
      assert.match(a, /href="https:\/\/kalshi\.com\/markets\//);
      assert.match(a, /rel="noopener noreferrer sponsored"/);
    }
  }
});

test("result row: market close line from the board summary, never live prices", () => {
  const line = ufcKalshiLineHtml(settledEntry(), { result: true });
  assert.match(line, /MARKET/);
  assert.match(line, /Alina Charaeva/);
  assert.match(line, /settled YES/);
  assert.doesNotMatch(line, /<a\b/);
  /* a result row whose market still trades shows nothing (not live prices) */
  assert.equal(ufcKalshiLineHtml(entry(), { result: true }), "");
  /* no close summary recorded -> nothing */
  const bare = settledEntry() as any;
  bare.market.close = null;
  assert.equal(ufcKalshiLineHtml(bare, { result: true }), "");
  assert.equal(ufcKalshiLineHtml(null, { result: true }), "");
});

test("server reads keep a settled entry whose live block is gone", async () => {
  const gone = settledEntry() as any;
  gone.kalshi = null;
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as never;
  const ev = await getKalshiEvent(BOUT, { fetchImpl: ok({ enabled: true, event: gone }) });
  assert.equal(ev?.market_history?.lifecycle, "SETTLED");
  assert.match(ufcKalshiCardHtml(ev), /How the market closed/);
  const board = await getKalshiBoard({ fetchImpl: ok({ enabled: true, events: [gone] }) });
  assert.deepEqual(Object.keys(board), [BOUT]);
});

test("server reads use our markets Worker, key the board by bout uuid and fail to nothing", async () => {
  const seen: string[] = [];
  const ok = (body: unknown) => (async (url: string) => { seen.push(url); return new Response(JSON.stringify(body), { status: 200 }); }) as never;
  const board = await getKalshiBoard({ fetchImpl: ok({ enabled: true, events: [entry(), { event: { canonical_event_id: "x" }, kalshi: null }] }) });
  assert.deepEqual(Object.keys(board), [BOUT]);
  const ev = await getKalshiEvent(BOUT, { fetchImpl: ok({ enabled: true, event: entry() }) });
  assert.equal(ev?.event.canonical_event_id, BOUT);
  assert.deepEqual(seen, [`${KALSHI_MARKETS_BASE}/v1/market-intelligence/sport/ufc`, `${KALSHI_MARKETS_BASE}/v1/market-intelligence/event/ufc/${BOUT}`]);
  assert.equal(await getKalshiEvent(BOUT, { fetchImpl: ok({ enabled: false, event: entry() }) }), null);
  assert.equal(await getKalshiEvent(BOUT, { fetchImpl: (async () => { throw new Error("down"); }) as never }), null);
  assert.equal(await getKalshiEvent(BOUT, { fetchImpl: (async () => new Response("", { status: 500 })) as never }), null);
  assert.deepEqual(await getKalshiBoard({ fetchImpl: (async () => { throw new Error("down"); }) as never }), {});
});

/* ── placement: public, never inside the Pro gate ── */
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

test("fight page: Kalshi card is public and separate from the Pro sportsbook Market section", () => {
  const src = read("app/fights/[slug]/page.tsx");
  const fetchLine = src.split("\n").find((l) => l.includes("getKalshiEvent(b.id)"));
  assert.ok(fetchLine, "server reads the bout entry");
  assert.doesNotMatch(fetchLine!, /access|\.pro/, "the read is not conditioned on entitlement");
  const cardLine = src.split("\n").find((l) => l.includes("<KalshiMarketCard"));
  assert.ok(cardLine, "card is mounted");
  assert.doesNotMatch(cardLine!, /access|\.pro|ProPreview/);
  /* not nested in the access.pro ternary that wraps MarketSection: it sits
   * directly under the faceoff, above every Pro gate (MLB PBEcast standard) */
  const card = src.indexOf("<KalshiMarketCard");
  assert.ok(card > src.indexOf("<BoutStatusAlert") && card > src.indexOf('className="faceoff"'), "card is under the faceoff");
  assert.ok(card < src.indexOf("<MarketSection") && card < src.indexOf('<div className="card mt-5">'), "card is above the event card and the Pro market gate");
  const comp = read("components/KalshiMarket.tsx");
  assert.doesNotMatch(comp, /getUfcAccess|ProPreview|access\.pro/);
  /* the sportsbook market block is untouched by this layer */
  assert.doesNotMatch(read("components/Market.tsx"), /kalshi/i);
  assert.doesNotMatch(read("lib/market.ts"), /kalshi/i);
});

test("fight page: the market module is mounted for completed bouts too", () => {
  const src = read("app/fights/[slug]/page.tsx");
  const cardLine = src.split("\n").find((l) => l.includes("<KalshiMarketCard"))!;
  assert.doesNotMatch(cardLine, /!r\b/, "not limited to unsettled bouts");
  assert.match(cardLine, /completed=\{Boolean\(r\)\} final=\{Boolean\(r\)\}/);
  const fetchLine = src.split("\n").find((l) => l.includes("getKalshiEvent(b.id)"))!;
  assert.doesNotMatch(fetchLine, /b\.result|kalshiAge/, "completed bouts are read");
  const ui = read("components/ui.tsx");
  assert.match(ui, /<KalshiBoutLine boutId=\{b\.id\} initial=\{kalshi \?\? null\} result=\{Boolean\(r\)\} names=\{\{ a: b\.fighter_a\.name, b: b\.fighter_b\.name \}\} \/>/);
  assert.doesNotMatch(ui.split("\n").find((l) => l.includes("<KalshiBoutLine"))!, /!r\b/);
});

test("event page: board read is public and passed to the card rows", () => {
  const src = read("app/events/[slug]/page.tsx");
  const line = src.split("\n").find((l) => l.includes("getKalshiBoard("));
  assert.ok(line);
  assert.doesNotMatch(line!, /access|\.pro/);
  assert.match(src, /kalshi=\{kalshiBoard\}/);
});

test("methodology documents Kalshi as a prediction market with the draw / NC rule", () => {
  const src = read("app/methodology/page.tsx");
  assert.match(src, /id="kalshi"/);
  assert.match(src, /not sportsbook odds/);
  assert.match(src, /Mid-market/);
  assert.match(src, /50\/50/);
  assert.match(src, /rel="noopener noreferrer sponsored"/);
});

/* ── no direct Kalshi API calls anywhere in web code ── */
const KALSHI_API = /api\.elections\.kalshi\.com|trading-api\.kalshi\.com|external-api\.kalshi\.com|demo-api\.kalshi\.co|api\.kalshi\.com|kalshi\.com\/trade-api/i;
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|css|json)$/.test(n) && !p.endsWith("kalshi.test.ts")) out.push(p);
  }
  return out;
}
test("no Kalshi API host in web code", () => {
  const hits = ["app", "components", "lib", "vendor", "middleware.ts", "next.config.ts"]
    .flatMap((p) => (statSync(join(WEB, p)).isDirectory() ? walk(join(WEB, p)) : [join(WEB, p)]))
    .filter((f) => KALSHI_API.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

/* ── vendored files unchanged (canonical client propbetedge-workers 64ca257: one-sided book keeps the card) ── */
const VENDORED: Record<string, string> = {
  "kalshi-market-ui.js": "639f834c27bffed519d37eea4066d3b31e5699f7215d6ea5c07e23c2591ccc48",
  "kalshi-market-ui.css": "df81df5650cc66d0bcea37c2808eaf783522ad9f921449e954f590d4ad9a2c60",
  "kalshi-market-client.js": "bbab54f78382f336a149b18f332bc54abe0b9c471ada3dd8ef0d67e5e5706301",
  "README.md": "a80e4ac5d8733bde8afc0c13c281242babff8b1acd083974741f677b7af5a480",
};
const CANONICAL = process.env.KALSHI_CLIENT_SRC || "D:/Workers/propbetedge-workers/workers/propsports-markets/client";
test("vendored Kalshi files are byte-identical to the canonical client", () => {
  for (const [name, sha] of Object.entries(VENDORED)) {
    const mine = readFileSync(join(WEB, "vendor", "kalshi", name));
    assert.equal(createHash("sha256").update(mine).digest("hex"), sha, `${name} changed: re-vendor from the canonical source, never edit`);
    const src = join(CANONICAL, name);
    if (existsSync(src)) assert.ok(mine.equals(readFileSync(src)), `${name} differs from ${src} (canonical moved: re-vendor and update the pin)`);
  }
});

/* ── MLB-standard prominence: lifecycle label + full card (8b73545) ── */
test("lifecycle label: pre / live / fight final still trading / stale / closed / settled", () => {
  assert.equal(ufcMarketPhase(null), null);
  assert.deepEqual(ufcMarketPhase(entry()), ["pre", "MARKET OPEN · PRE-FIGHT"]);
  assert.deepEqual(ufcMarketPhase({ ...entry(), event: { ...entry().event, state: "in" } }), ["live", "LIVE MARKET"]);
  assert.deepEqual(ufcMarketPhase({ ...entry(), event: { ...entry().event, state: "in" } }, { final: true }), ["final-open", "FIGHT FINAL · MARKET STILL TRADING"]);
  assert.deepEqual(ufcMarketPhase({ ...entry({ freshness: "stale" } as never), event: { ...entry().event, state: "in" } }), ["stale", "MARKET OPEN · LAST QUOTE STALE"], "a stale quote is never labelled live");
  assert.deepEqual(ufcMarketPhase({ ...entry(), market: { lifecycle: "CLOSED" } }, { final: true }), ["closed", "MARKET CLOSED · AWAITING SETTLEMENT"]);
  assert.deepEqual(ufcMarketPhase({ ...entry(), kalshi: null, market_history: { lifecycle: "SETTLED" } }), ["settled", "MARKET SETTLED"]);
});

test("fight-page module: full Market Pulse card (not compact, not a strip) with label, link and UFC note", () => {
  const html = ufcKalshiCardHtml(entry());
  assert.match(html, /^<div class="ufc-mkt" data-phase="pre"><div class="ufc-mkt-phase">/);
  assert.match(html, /MARKET OPEN · PRE-FIGHT/);
  assert.match(html, /Market Pulse/);
  assert.match(html, /Updated 36s ago/);
  assert.match(html, /<dt>Bid<\/dt>/);
  assert.match(html, /View market on Kalshi ↗/);
  assert.doesNotMatch(html, /kx--compact|kx-strip/);
  for (const a of html.match(/<a [^>]*>/g) || []) assert.match(a, /rel="noopener noreferrer sponsored"/);
  assert.ok(html.endsWith(`<p class="ufc-kx__rule">${UFC_KALSHI_NOTE}</p></div>`));
  const fin = ufcKalshiCardHtml(entry(), "fight-page", { final: true });
  assert.match(fin, /data-phase="final-open"/);
  assert.match(fin, /FIGHT FINAL · MARKET STILL TRADING/);
});

test("shared client loaders (8b73545+) keep completed entries (the product-side workaround is gone)", async () => {
  const { createKalshiClient } = await import("../vendor/kalshi/kalshi-market-client.js");
  const done = { event: { sport: "ufc", canonical_event_id: BOUT, state: "post" }, kalshi: null, market: { lifecycle: "SETTLED" }, market_history: { lifecycle: "SETTLED" } };
  const fetchImpl = (async (url: string) => new Response(JSON.stringify(url.includes("/event/") ? { enabled: true, event: done } : { enabled: true, events: [done] }))) as never;
  const c = createKalshiClient({ base: KALSHI_MARKETS_BASE, sport: "ufc", fetchImpl });
  assert.equal((await c.loadBoard()).get(BOUT)?.market?.lifecycle, "SETTLED");
  assert.equal((await c.loadEvent(BOUT))?.market_history?.lifecycle, "SETTLED");
  const comp = read("components/KalshiMarket.tsx");
  assert.doesNotMatch(comp, /getKalshiEvent|getKalshiBoard|BROWSER_WAIT_MS/, "browser reads use the shared client loaders");
  assert.match(comp, /client\(\)\.loadEvent\(boutId, \{ force: true \}\)/);
  assert.match(comp, /client\(\)\.loadBoard\(\)/);
});

/* ── shared client ad6187a ── */
test("ad6187a: subtitle says Live prediction market only for a live-fresh quote; stale says quote not current", () => {
  assert.match(ufcKalshiCardHtml(entry()), /Live prediction market · Kalshi/);
  const stale = ufcKalshiCardHtml(entry({ freshness: "stale" } as never));
  assert.match(stale, /Prediction market · quote not current · Kalshi/);
  assert.doesNotMatch(stale, /Live prediction market ·/);
  assert.match(ufcKalshiCardHtml(entry({ freshness: "delayed" } as never)), /<span class="kx__sub">Prediction market · Kalshi/);
});

test("ad6187a: a failed browser read is never cached as no market; the last good entry is kept and the next poll retries", async () => {
  const { createKalshiClient } = await import("../vendor/kalshi/kalshi-market-client.js");
  let down = false; let calls = 0;
  const fetchImpl = (async () => { calls++; return down ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ enabled: true, event: entry() })); }) as never;
  const c = createKalshiClient({ base: KALSHI_MARKETS_BASE, sport: "ufc", fetchImpl });
  const good = await c.loadEvent(BOUT);
  assert.equal(good?.event.canonical_event_id, BOUT);
  down = true;
  assert.equal(await c.loadEvent(BOUT, { force: true }), good, "a 503 keeps the last good entry");
  down = false;
  const n = calls;
  assert.equal((await c.loadEvent(BOUT))?.event.canonical_event_id, BOUT);
  assert.equal(calls, n + 1, "the failure was not cached: the next call reads again");
});

/* ── ALGO vs MARKET ──
 * REAL responses captured 2026-10-03: GET /v1/algo-vs-market/ufc (algos[] empty: the UFC 332 calls locked before the
 * market tape, so they are excluded) and GET /v1/algo-vs-market/soccer (one AGREEMENT, Augsburg v Bayern München). */
const AVM_UFC_REAL = {"contract":"algo-vs-market/1","sport":"ufc","generated_at":"2026-10-03T19:46:50.168Z","rules":"Both opinions frozen at the algorithm lock (market = latest read at or before the lock, <= 15 min old). Market pick = highest Mid-market. Agreements do not score; disagreements are head-to-head; a third outcome winning is Neither.","algos":[]} as const;
const AVM_SOCCER_REAL = {"contract":"algo-vs-market/1","sport":"soccer","generated_at":"2026-10-03T19:46:49.971Z","rules":"Both opinions frozen at the algorithm lock (market = latest read at or before the lock, <= 15 min old). Market pick = highest Mid-market. Agreements do not score; disagreements are head-to-head; a third outcome winning is Neither.","algos":[{"algo_id":"soccer:soccer-algo-v1","algo_label":"PBE Soccer Algo V1","proposition":"match_result_90min","venue":"kalshi","scoreboard":{"algo_wins":0,"market_wins":0,"neither":0,"void":0,"agreements":1,"agreed_correct":0,"agreed_wrong":0,"disagreements":0,"pending":1,"not_scored":0,"decided":0,"algo_win_rate":null,"agreement_rate":100},"excluded":{"NO_HISTORICAL_MARKET_SNAPSHOT":1},"ledger":[{"algo_id":"soccer:soccer-algo-v1","algo_label":"PBE Soccer Algo V1","sport":"soccer","canonical_event_id":"c25c4136-f800-5f3a-a5de-b91c1f981bd7","proposition":"match_result_90min","algo_lock_at":"2026-10-03T14:05:57+00:00","event_start_at":"2026-10-10T13:30:00+00:00","status":"AGREEMENT","algo_selection":"away","algo_selection_label":"away","algo_probability":0.713535830714774,"market":{"venue":"kalshi","venue_type":"prediction_market","market_url":"https://kalshi.com/markets/kxbundesligagame/bundesliga-game/kxbundesligagame-26oct10fcabmu","observed_at":"2026-10-03T14:03:56.875+00:00","snapshot_age_s":120,"selection":"away","selection_label":"Bayern München","selection_price_bp":8050,"prices":{"away":{"label":"Bayern München","state":"open","ask_bp":8100,"bid_bp":8000,"mid_bp":8050,"last_bp":8100},"draw":{"label":"Draw","state":"open","ask_bp":1100,"bid_bp":1000,"mid_bp":1050,"last_bp":1100},"home":{"label":"Augsburg","state":"open","ask_bp":1000,"bid_bp":900,"mid_bp":950,"last_bp":1000}}},"result":null,"frozen_at":"2026-10-03T15:58:21.103597+00:00"}]}]};
const SHORT = AVM_SOCCER_REAL.algos[0].ledger[0];
const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as never;

test("AVM: nothing renders for the real (empty) UFC response, a failed read or no comparison", async () => {
  assert.deepEqual(AVM_UFC_REAL.algos, []);
  assert.equal(ufcAvmRecordHtml(AVM_UFC_REAL as never), "");
  assert.equal(ufcAvmRecordHtml(null), "");
  assert.equal(ufcAvmEventHtml({ comparisons: [] }, { a: "A", b: "B" }), "");
  assert.equal(ufcAvmEventHtml(null), "");
  assert.deepEqual(await getAlgoVsMarket({ fetchImpl: json(AVM_UFC_REAL) }), AVM_UFC_REAL);
  assert.equal(await getAlgoVsMarket({ fetchImpl: json({}, 502) }), null);
  assert.equal(await getAlgoVsMarketEvent(BOUT, { fetchImpl: json({ error: "x" }, 500) }), null);
  assert.equal(await getAlgoVsMarketEvent(""), null);
});

test("AVM: the shared card renders score + ledger for the real soccer response (sport-agnostic module)", () => {
  const t = ufcAvmRecordHtml(AVM_SOCCER_REAL as never).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.match(t, /Algo vs Market/);
  assert.match(t, /PropBetEdge 0 — Market 0/);
  assert.match(t, /Agreed 1/); assert.match(t, /Pending 1/);
  assert.match(t, /Bayern München Bayern München · 80\.5¢ Agree Pending/);
  assert.doesNotMatch(t, /beats? the market|outperform/i);
});

test("AVM: a LOCKED (Pro-gated, pending) UFC comparison shows no selection on the record or the fight page", () => {
  const locked = { ...SHORT, algo_id: "ufc:pbe-fight-model", algo_label: "PBE Fight Model", sport: "ufc", canonical_event_id: BOUT, status: "LOCKED",
    algo_selection: null, algo_selection_label: null, algo_probability: null,
    market: { ...SHORT.market, selection: null, selection_label: null, selection_price_bp: null, prices: { a: { label: "Imanol Rodriguez" }, b: { label: "Alden Coria" } } } };
  const algo = { ...AVM_SOCCER_REAL.algos[0], algo_id: "ufc:pbe-fight-model", scoreboard: { ...AVM_SOCCER_REAL.algos[0].scoreboard, agreements: 0, pending: 1 }, ledger: [locked] };
  const rec = ufcAvmRecordHtml({ algos: [algo] } as never).replace(/<[^>]*>/g, " ");
  assert.match(rec, /Locked · pending/);
  assert.doesNotMatch(rec, /Imanol|Coria|80\.5¢|71\.4%/);
  const ev = ufcAvmEventHtml({ comparisons: [locked] } as never, { a: "Imanol Rodriguez", b: "Alden Coria" }).replace(/<[^>]*>/g, " ");
  assert.match(ev, /Locked — revealed after the result/);
  assert.doesNotMatch(ev, /Imanol|Coria|80\.5¢|71\.4%/);
});

test("AVM: fight-page roles a / b resolve to the bout's fighters", () => {
  const row = { ...SHORT, canonical_event_id: BOUT, status: "DISAGREEMENT", algo_selection: "a", algo_selection_label: "a", market: { ...SHORT.market, selection: "b", selection_label: "b", prices: {} } };
  const t = ufcAvmEventHtml({ comparisons: [row] } as never, { a: "Imanol Rodriguez", b: "Alden Coria" }).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.match(t, /Head to head/);
  assert.match(t, /Imanol Rodriguez 71\.4% vs Market at PBE lock Alden Coria 80\.5¢/);
});

test("AVM placements: /algo/record after the performance tracker, fight page directly after Market Pulse, server reads only", () => {
  const rec = read("app/algo/record/page.tsx");
  assert.ok(rec.indexOf("<AlgoVsMarketRecord payload={avm} />") > rec.indexOf("<PbePerformanceTracker proof={proof} compact />"));
  assert.ok(rec.indexOf("<AlgoVsMarketRecord payload={avm} />") < rec.indexOf('id="past-picks"'));
  const fight = read("app/fights/[slug]/page.tsx");
  const kx = fight.indexOf("<KalshiMarketCard "), avm = fight.indexOf("<AlgoVsMarketFight ");
  assert.ok(kx > 0 && avm > kx && avm - kx < 200, "directly after the Market Pulse card");
  assert.doesNotMatch(read("components/AlgoVsMarket.tsx"), /use client|fetch\(/);
});

/* ── PRESENTATION PASS (compact chips, 2026-10-03) ──
 * REAL board + tape captured 2026-10-03 ~20:45Z (UFC 332): Silva v Wang open/live, Vettori v Naurdiev
 * open with stored movement, McGee v Nolan SETTLED (Nolan YES). */
const UFC332 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kalshi-ufc-332-real.json"), "utf8"));
const realEntry = (id: string) => structuredClone(UFC332.board.events.find((e: any) => e.event.canonical_event_id === id)) as KalshiEntry;
const SILVA = "5e5d2711-f905-4b69-b8d4-aa17a96ef7ac";
const VETTORI = "335db527-1a7e-4a10-8bcf-a9f7c956a60c";
const MCGEE = "41559b42-0a88-492d-ad14-27dc67dc03b6";

test("compact quote: real open market = the Market Pulse Mid-market, one decimal, favourite = higher Mid", () => {
  const e = realEntry(SILVA);
  const q = ufcQuote(e, { a: "Natalia Silva", b: "Wang Cong" });
  assert.equal(q?.kind, "open");
  if (q?.kind !== "open") return;
  assert.equal(kalshiCents(q.a.bp), "64.5¢");
  assert.equal(kalshiCents(q.b.bp), "35.5¢");
  assert.equal(q.fav, "a");
  assert.equal(q.marketUrl, "https://kalshi.com/markets/kxufcfight/ufc-fight/kxufcfight-26oct03silcon");
  /* every compact price equals the full card's headline for that side */
  const card = ufcKalshiCardHtml(e);
  for (const s of [q.a, q.b]) assert.match(card, new RegExp(`kx__px mono">${kalshiCents(s.bp).replace(".", "\\.")}<`));
  assert.match(ufcFreshnessText(q), /^Updated /);
});

test("compact quote: exact tie names no favourite; stale is 'Quote not current' (never live); delayed says delayed", () => {
  const e = realEntry(SILVA) as any;
  e.kalshi.outcomes[0].mid_bp = 5000; e.kalshi.outcomes[1].mid_bp = 5000;
  assert.equal((ufcQuote(e) as any).fav, null);
  const st = realEntry(SILVA) as any; st.kalshi.freshness = "stale";
  const qs = ufcQuote(st) as any;
  assert.equal(ufcFreshnessText(qs), "Quote not current");
  const dl = realEntry(SILVA) as any; dl.kalshi.freshness = "delayed"; dl.kalshi.age_seconds = 240;
  assert.equal(ufcFreshnessText(ufcQuote(dl) as any), "Delayed · updated 4 min ago");
});

test("compact quote: no Mid-market on a side, a non-displayable book or no entry -> nothing", () => {
  const wide = realEntry(SILVA) as any; wide.kalshi.outcomes[1].mid_bp = null;
  assert.equal(ufcQuote(wide), null);
  const nd = realEntry(SILVA) as any; nd.kalshi.outcomes[0].displayable = false;
  assert.equal(ufcQuote(nd), null);
  assert.equal(ufcQuote(null), null);
});

test("compact quote: real SETTLED McGee v Nolan shows only stored evidence (first observed, final trade, venue YES), no before-start price", () => {
  const q = ufcQuote(realEntry(MCGEE), { a: "Court McGee", b: "Eric Nolan" });
  assert.equal(q?.kind, "settled");
  if (q?.kind !== "settled") return;
  assert.equal(q.winner, "b");
  assert.deepEqual(q.b, { role: "b", name: "Eric Nolan", firstBp: 6750, finalBp: 9900, result: "yes" });
  assert.deepEqual(q.a, { role: "a", name: "Court McGee", firstBp: 3250, finalBp: 100, result: "no" });
  assert.ok(!("beforeBp" in q.b), "UFC has no trusted start: no before-start price is carried");
  /* a CLOSED (not yet settled) market never claims a result */
  const closed = realEntry(MCGEE) as any; closed.market.lifecycle = "CLOSED"; closed.market.close.lifecycle = "CLOSED";
  const qc = ufcQuote(closed) as any;
  assert.equal(qc.kind, "closed");
  assert.equal(qc.winner, null);
  assert.equal(qc.b.result, null);
});

test("movement: only the tape's stored delta_first_bp, and only for the same observation shown", () => {
  const moves = tapeMoves(UFC332.tape);
  assert.deepEqual(moves[VETTORI], { a: { priceBp: 2350, deltaBp: -2100 }, b: { priceBp: 7600, deltaBp: 1950 } });
  const q = ufcQuote(realEntry(VETTORI)) as any;
  assert.equal(sideMove(moves[VETTORI], q.a), -2100);
  assert.equal(sideMove(moves[VETTORI], q.b), 1950);
  assert.equal(kalshiMoveCents(-2100), "21.0");
  /* a newer board price than the tape's -> no delta (never mixes observations) */
  assert.equal(sideMove(moves[VETTORI], { ...q.a, bp: 2450 }), null);
  /* unchanged -> no arrow */
  const silva = ufcQuote(realEntry(SILVA)) as any;
  assert.equal(sideMove(moves[SILVA], silva.a), null);
  assert.deepEqual(tapeMoves(null), {});
});

test("server reads: tape read uses our markets Worker; getKalshiForBouts narrows + slims; failures are empty", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => { seen.push(url); return new Response(JSON.stringify(url.includes("market-tape") ? UFC332.tape : UFC332.board)); }) as never;
  const mv = await getKalshiMoves({ fetchImpl });
  assert.ok(mv[VETTORI]);
  assert.deepEqual(seen, [`${KALSHI_MARKETS_BASE}/v1/market-tape?sport=ufc`]);
  assert.deepEqual(await getKalshiMoves({ fetchImpl: (async () => { throw new Error("down"); }) as never }), {});
  const slim = slimEntry(realEntry(SILVA));
  assert.deepEqual(ufcQuote(slim), ufcQuote(realEntry(SILVA)), "slimmed entry renders the same chip");
  assert.equal(kalshiPollState(slim), kalshiPollState(realEntry(SILVA)));
  assert.deepEqual(ufcQuote(slimEntry(realEntry(MCGEE))), ufcQuote(realEntry(MCGEE)));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(realEntry(SILVA)).length / 2);
});

test("PBE vs KALSHI chip: only a graded comparison with the frozen probability and the same side's frozen Mid", () => {
  const agree = structuredClone(SHORT) as any;
  const c = ufcAvmChip(agree);
  assert.deepEqual(c, { pbePct: 71.4, kalshiPct: 80.5, divergencePts: -9.1, selection: "away" });
  assert.equal(ufcAvmChip({ ...agree, status: "LOCKED" }), null, "LOCKED reveals nothing");
  assert.equal(ufcAvmChip({ ...agree, status: "NO_HISTORICAL_MARKET_SNAPSHOT" }), null);
  assert.equal(ufcAvmChip({ ...agree, algo_probability: null }), null);
  assert.equal(ufcAvmChip(null), null);
  assert.deepEqual(avmByBout(AVM_UFC_REAL as never), {}, "real UFC response: no comparison, no chip");
  assert.equal(Object.keys(avmByBout(AVM_SOCCER_REAL as never)).length, 1);
});

/* ── placements: public, one board read per page, chips everywhere a matchup shows ── */
test("presentation placements: hero, card rows, matchup cards, schedule, event poster, Fight Week, Algo", () => {
  const home = read("app/page.tsx");
  assert.equal((home.match(/getKalshiBoard\(/g) || []).length, 1, "homepage: one board read");
  assert.doesNotMatch(home.split("\n").find((l) => l.includes("getKalshiBoard("))!, /access|\.pro/);
  assert.match(home, /<KalshiBoard initial=\{kalshi\}( desk=\{[^\n]+\})?>/);
  assert.equal((home.match(/variant="hero" side="[ab]"/g) || []).length, 2, "hero: one chip per fighter");
  assert.match(home, /favLabel=\{!heroBook\}/);
  assert.match(home, /<CardSegments [^>]*kalshi=\{kalshi\}/);
  assert.match(home, /<MatchupCard [^>]*kalshi=\{kalshi\[b\.id\] \?\? null\}/);
  const ev = read("app/events/[slug]/page.tsx");
  assert.equal((ev.match(/getKalshiBoard\(/g) || []).length, 1);
  assert.match(ev, /<KalshiBoard initial=\{kalshiBoard\}( desk=\{[^\n]+\})?>/);
  assert.match(ev, /placement="event-poster"/);
  const sched = read("app/events/page.tsx");
  assert.equal((sched.match(/getKalshiBoard\(/g) || []).length, 1);
  assert.match(sched, /<KalshiBoard initial=\{kalshi\}( desk=\{[^\n]+\})?>/);
  for (const r of ["app/fight-week/page.tsx", "app/pregame/[slug]/page.tsx"]) assert.match(read(r), /getKalshiForBouts\(packet\.live\.map\(\(b\) => b\.id\), \{ moves: true \}\)/);
  const fw = read("components/FightWeek.tsx");
  assert.match(fw, /<KalshiBoard initial=\{kx\?\.board \?\? \{\}\}( desk=\{[^\n]+\})?>/);
  assert.equal((fw.match(/<KxLine /g) || []).length, 3, "main event, matchup card, scan tile");
  const ui = read("components/ui.tsx");
  assert.match(ui, /placement="matchup-card"/);
  assert.match(ui, /placement="schedule-row"/);
  assert.match(ui, /placement="event-card"/);
  /* Algo: Pro branch only, after the pinned picks read */
  const card = read("app/algo/card/page.tsx");
  assert.match(card, /const avm = access\.pro && cards\.length \? avmByBout\(await getAlgoVsMarket\(\)\) : \{\};/);
  assert.match(read("components/AlgoPick.tsx"), /const avmChip = called && locked \? ufcAvmChip\(avm\) : null;/);
  /* the browser refresh is one shared board loop; no other market client */
  const comp = read("components/KalshiMarket.tsx");
  assert.equal((comp.match(/await client\(\)\.loadBoard\(\)/g) || []).length, 1, "one board loop");
  assert.doesNotMatch(comp, /fetch\(/);
  /* never "odds" on a Kalshi chip */
  assert.doesNotMatch(comp.slice(comp.indexOf("COMPACT CHIP")), /"[^"]*\bodds\b(?! and not)[^"]*"/i);
});

test("chip CSS: cool-blue tokens, distinct from the gold ML chip and the gold PBE chip", () => {
  const css = read("app/kalshi-ufc.css");
  assert.match(css, /--ufc-kc-ink: #7fb8ff;/);
  assert.match(css, /\.ufc-kc \{[^}]*border: 1px solid var\(--ufc-kc-line\)/);
  assert.match(css, /\.ufc-avm-chip \{[^}]*border: 1px solid var\(--pbe-gold\)/);
  assert.doesNotMatch(css, /kalshi\.com|url\(/i, "no venue branding or logo images");
});

/* ── other venues under the card (canonical 4e49f5f venueLines; pm-ufc, propsports-markets 0b2c1b7) ── */
test("Market Pulse is VENUE-NEUTRAL: Kalshi and other venues computed independently; renders when either exists", () => {
  const src = readFileSync(join(WEB, "components", "KalshiMarket.tsx"), "utf8");
  assert.match(src, /const venues = useMemo\(\(\) => venueLines\(desk, \{ placement: "fight-page-venues", standalone: !html \}\), \[html, desk\]\);/);
  assert.match(src, /if \(!html && !venues\) return null;/);
  assert.ok(!/if \(!html\) return null;/.test(src.slice(src.indexOf("export function KalshiMarketCard"), src.indexOf("/* ── ONE BOARD PER PAGE"))), "Kalshi is never a prerequisite");
  assert.match(src, /aria-label="Market Pulse: prediction markets"/);
  const page = readFileSync(join(WEB, "app", "fights", "[slug]", "page.tsx"), "utf8");
  assert.match(page, /const deskRead = b\.status !== "cancelled" \? getMarketDesk\(b\.id\)/);
  assert.match(page, /initialDesk=\{desk\}/);
});
test("compact surfaces carry a venue cue independent of the Kalshi chip (home hero, schedule, event card, poster, matchup card, Fight Week)", () => {
  const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
  for (const [f, n] of [[["app", "page.tsx"], 1], [["app", "events", "page.tsx"], 1], [["app", "events", "[slug]", "page.tsx"], 1], [["components", "ui.tsx"], 3], [["components", "KalshiMarket.tsx"], 1], [["components", "FightWeek.tsx"], 1]] as const) {
    const src = read(...f);
    assert.equal((src.match(/<VenueCue /g) || []).length, n, f.join("/"));
  }
  for (const f of [["app", "page.tsx"], ["app", "events", "page.tsx"], ["app", "events", "[slug]", "page.tsx"]]) assert.match(read(...f), /<KalshiBoard initial=\{[^}]+\} desk=\{pickDesk\(/, f.join("/"));
});
test("Polymarket-only bout (real Oct. 10 Allen v Duncan shape): standalone Market Pulse + compact cue, no Kalshi", async () => {
  const { venueLines, venueChip } = await import("../vendor/kalshi/kalshi-market-ui.js");
  const l = (mid: number) => ({ venue: "polymarket", match: "VENUE_ONLY", label: "PREDICTION MARKET", market_url: "https://polymarket.com/event/ufc-bre1-chr20-2026-10-10", mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: "live" });
  const d = { canonical_event_id: "aabde22a-cbc0-467f-bffa-830f8eadfadb", contracts: [{ label: "Brendan Allen", venues: [], related: [], listed: [l(6150)] }, { label: "Christian Leroy Duncan", venues: [], related: [], listed: [l(3850)] }] };
  const html = venueLines(d, { standalone: true });
  assert.match(html, /Market Pulse/); assert.match(html, /Polymarket/); assert.match(html, /61\.5¢/); assert.ok(!/Kalshi/.test(html)); assert.match(html, /class="ic kx kx--venue kx--polymarket"/);
  assert.match(venueChip(d), /MARKET<\/i> · POLYMARKET/);
});
test("UFC related market (pm-ufc gate wording): own price + exact fight reason, never a gap", async () => {
  const { venueLines } = await import("../vendor/kalshi/kalshi-market-ui.js");
  const rel = (mid: number) => ({ venue: "polymarket", match: "RULE_MISMATCH", label: "RELATED MARKET · RULES DIFFER", reason: "Rules differ if the fight is postponed, cancelled or not scored", market_url: "https://polymarket.com/event/ufc-bre1-chr20-2026-10-10", mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: "live" });
  const html = venueLines({ canonical_event_id: "aabde22a-cbc0-467f-bffa-830f8eadfadb", contracts: [{ label: "Brendan Allen", venues: [], related: [rel(6150)] }, { label: "Christian Leroy Duncan", venues: [], related: [rel(3850)] }] });
  assert.match(html, /Brendan Allen/);
  assert.match(html, /61\.5¢/);
  assert.match(html, /Rules differ if the fight is postponed, cancelled or not scored\. Shown at its own price; not compared\./);
  assert.ok(!/gap \d/.test(html));
});
test("bout rows: KalshiBoutLine is venue-neutral and mounted without a Kalshi precondition", () => {
  const src = readFileSync(join(WEB, "components", "KalshiMarket.tsx"), "utf8");
  assert.match(src, /<VenueCue boutId=\{boutId\} result=\{result\} wrapClass="ufc-kx-line" \/>/);
  const ui = readFileSync(join(WEB, "components", "ui.tsx"), "utf8");
  assert.match(ui, /\{!off \? <KalshiBoutLine boutId=\{b\.id\} initial=\{kalshi \?\? null\}/);
});
test("live venue refresh: own 30 s desk cadence (independent of Kalshi), forced re-read, freshness ticks every 10 s, cleaned up", () => {
  const src = readFileSync(join(WEB, "components", "KalshiMarket.tsx"), "utf8");
  assert.match(src, /export const DESK_POLL_MS = 30_000;/);
  assert.match(src, /client\(\)\.loadDesk\(id, \{ force: true \}\)/);
  assert.match(src, /timer = setTimeout\(tick, DESK_POLL_MS\)/);
  assert.match(src, /const t = setInterval\(\(\) => tickVenueAges\(ref\.current\), VENUE_AGE_TICK_MS\);\s+return \(\) => clearInterval\(t\);/);
});

/* ── network P0 2026-10-04: one-sided book at the $0/$1 boundary keeps the full card (vendored 64ca257) ── */
test("99/1 one-sided book: full Kalshi card with truthful Bid/Ask/Last, no Mid-market, link kept; compact line absent", () => {
  const e = entry() as any;
  const side = (o: any, bid: number | null, ask: number | null, last: number) => ({ ...o, best_yes_bid_bp: bid, best_yes_ask_bp: ask, last_price_bp: last, mid_bp: null, spread_bp: null, displayable: false, renderable: true, one_sided: true });
  e.kalshi.outcomes = [side(e.kalshi.outcomes[0], 9900, null, 9900), side(e.kalshi.outcomes[1], null, 100, 100)];
  e.kalshi.mid_available = false; e.kalshi.book = "one_sided";
  const html = ufcKalshiCardHtml(e as KalshiEntry);
  assert.ok(html.includes(e.kalshi.market_url), "Kalshi link kept");
  const panels = html.split('class="kx__panel"').slice(1);
  assert.equal(panels.length, 2);
  assert.match(panels[0], /<dt>Bid<\/dt><dd>99¢<\/dd>[\s\S]*<dt>Ask<\/dt><dd>—<\/dd>[\s\S]*<dt>Last<\/dt><dd>99¢<\/dd>/);
  assert.match(panels[1], /<dt>Bid<\/dt><dd>—<\/dd>[\s\S]*<dt>Ask<\/dt><dd>1¢<\/dd>[\s\S]*<dt>Last<\/dt><dd>1¢<\/dd>/);
  assert.ok(html.includes("Mid-market unavailable at this observation · one-sided book"));
  assert.ok(!/kx__pxl">Mid-market</.test(html) && !/99\.5¢|0\.5¢/.test(html), "no invented midpoint");
  assert.equal(ufcKalshiLineHtml(e as KalshiEntry), "", "compact line needs a valid Mid-market");
  assert.equal(ufcQuote(e as KalshiEntry), null, "compact quote needs a valid Mid-market");
  const old = entry() as any;
  old.kalshi.outcomes = e.kalshi.outcomes.map(({ renderable, ...x }: any) => x);
  assert.equal(ufcKalshiCardHtml(old as KalshiEntry), "", "an older API block without renderable fails closed");
});
