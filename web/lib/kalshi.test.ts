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
import { getKalshiBoard, getKalshiEvent, kalshiPollState, ufcKalshiCardHtml, ufcKalshiLineHtml, UFC_KALSHI_NOTE, KALSHI_MARKETS_BASE } from "./kalshi.ts";
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
  assert.ok(html.indexOf(UFC_KALSHI_NOTE) > html.indexOf("Kalshi market"));
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
  /* not nested in the access.pro ternary that wraps MarketSection */
  const gate = src.indexOf("<MarketSection");
  const gateEnd = src.indexOf("}", src.indexOf("ProPreview feature=\"market\"", gate));
  assert.ok(src.indexOf("<KalshiMarketCard") > gateEnd, "Kalshi card sits after the closed Pro market expression");
  const comp = read("components/KalshiMarket.tsx");
  assert.doesNotMatch(comp, /getUfcAccess|ProPreview|access\.pro/);
  /* the sportsbook market block is untouched by this layer */
  assert.doesNotMatch(read("components/Market.tsx"), /kalshi/i);
  assert.doesNotMatch(read("lib/market.ts"), /kalshi/i);
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

/* ── vendored files unchanged ── */
const VENDORED: Record<string, string> = {
  "kalshi-market-ui.js": "6f1c1244403f078da96182c7658e0f3da3e3777ccffa80b834257245a2aa2d81",
  "kalshi-market-ui.css": "43cbdcc9313a82618c38bd3998e020943e0db2031b95ed34ef566e91883901fd",
  "kalshi-market-client.js": "653cb0fc2673f909552453052560bfd6194e0e4d045c51b1eb73483957d4c049",
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
