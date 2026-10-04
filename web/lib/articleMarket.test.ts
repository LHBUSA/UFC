/* article-market/1 on UFC stories: eligibility (prospective only, one bout uuid), the same-origin read,
 * the slot after the first section, and the vendored client byte-identical to the canonical source.
 * Fixture = the real GET /v1/article-market/ufc/aabde22a-… (Brendan Allen v Christian Leroy Duncan,
 * UFC Fight Night 2026-10-10) read 2026-10-04T15:49Z: Polymarket only, no Kalshi market, no PBE call. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTICLE_MARKET_ACTIVATED_AT, ARTICLE_MARKET_BASE, articleMarketEvent, articleMarketHtml, articleMarketPath, firstSectionEnd, getArticleMarket } from "./articleMarket.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const REAL = JSON.parse(readFileSync(join(HERE, "fixtures", "article-market-ufc-allen-duncan-real.json"), "utf8"));
const BOUT = "aabde22a-cbc0-467f-bffa-830f8eadfadb";
const after = { bout_id: BOUT, published_at: "2026-10-04T15:49:17Z", status: "published" };

test("activation time is the shared, never-moved value", () => {
  assert.equal(ARTICLE_MARKET_ACTIVATED_AT, "2026-10-04T14:31:40Z");
});

test("eligibility: one bout uuid, first published at/after activation, published only", () => {
  assert.equal(articleMarketEvent(after), BOUT);
  assert.equal(articleMarketEvent({ ...after, published_at: "2026-10-04T14:31:40Z" }), BOUT);
  assert.equal(articleMarketEvent({ ...after, published_at: "2026-10-04T14:31:39Z" }), null, "pre-activation: never");
  assert.equal(articleMarketEvent({ ...after, published_at: "2026-09-27T00:16:09.153+00:00" }), null, "the real Sep 27 preview of this bout stays without a module");
  assert.equal(articleMarketEvent({ ...after, bout_id: null }), null, "no bout link, no module (never a name match)");
  assert.equal(articleMarketEvent({ ...after, bout_id: "Allen vs Duncan" }), null);
  assert.equal(articleMarketEvent({ ...after, published_at: null }), null);
  assert.equal(articleMarketEvent({ ...after, status: "review" }), null);
});

test("server read: the original published_at goes to the shared route; ineligible / failed -> null", async () => {
  const seen: string[] = [];
  const ok = (body: unknown) => async (url: string) => { seen.push(url); return new Response(JSON.stringify(body), { status: 200 }); };
  assert.ok(await getArticleMarket(after, { fetchImpl: ok(REAL) }));
  assert.match(seen[0], /\/v1\/article-market\/ufc\/aabde22a-cbc0-467f-bffa-830f8eadfadb\?published_at=2026-10-04T15%3A49%3A17Z$/);
  assert.equal(await getArticleMarket(after, { fetchImpl: ok({ ...REAL, eligible: false, reason: "PRE_ACTIVATION_ARTICLE", packet: null, live: null }) }), null);
  assert.equal(await getArticleMarket(after, { fetchImpl: async () => new Response("x", { status: 502 }) }), null);
  assert.equal(await getArticleMarket(after, { fetchImpl: async () => { throw new Error("timeout"); } }), null);
  seen.length = 0;
  assert.equal(await getArticleMarket({ ...after, published_at: "2026-10-03T00:00:00Z" }, { fetchImpl: ok(REAL) }), null);
  assert.equal(seen.length, 0, "a pre-activation story never even asks");
});

test("real Allen v Duncan payload renders LIVE MARKET WATCH, Polymarket only, labelled, no PBE call", () => {
  const html = articleMarketHtml(REAL);
  assert.match(html, /Live market watch/);
  assert.match(html, /Polymarket/);
  assert.match(html, /RULES NOT VERIFIED/);
  assert.match(html, /No official call/);
  assert.match(html, /Brendan Allen/);
  assert.doesNotMatch(html, /Kalshi/, "one venue observed -> one venue shown");
  assert.match(html, /data-am-placement="ufc-article"/);
  assert.equal(articleMarketHtml(null), "");
  assert.equal(articleMarketHtml({ ...REAL, packet: { ...REAL.packet, packet_state: "NO_MARKET_OBSERVED" } }), "", "nothing observed -> nothing rendered");
});

test("slot: after the first section (second heading), else after two blocks", () => {
  assert.equal(firstSectionEnd(["<h2>The setup</h2>", "<p>a</p>", "<p>b</p>", "<h2>Next</h2>", "<p>c</p>"]), 3);
  assert.equal(firstSectionEnd(["<p>a</p>", "<p>b</p>", "<h3>Next</h3>"]), 2);
  assert.equal(firstSectionEnd(["<p>a</p>", "<p>b</p>", "<p>c</p>"]), 2);
  assert.equal(firstSectionEnd(["<p>a</p>"]), 1);
});

test("browser code reads same-origin only; the route is exact", () => {
  assert.equal(ARTICLE_MARKET_BASE, "/api/markets");
  assert.equal(articleMarketPath(BOUT, "2026-10-04T15:49:17Z"), `/v1/article-market/ufc/${BOUT}?published_at=2026-10-04T15%3A49%3A17Z`);
  const comp = readFileSync(join(WEB, "components", "ArticleMarket.tsx"), "utf8");
  assert.doesNotMatch(comp, /workers\.dev|kalshi\.com|polymarket\.com|ARTICLE_MARKET_UPSTREAM/);
  assert.ok(existsSync(join(WEB, "app", "api", "markets", "v1", "article-market", "ufc", "[id]", "route.ts")));
});

/* vendored unchanged: propbetedge-workers 3f7345e (workers/propsports-markets/client) */
const VENDORED: Record<string, string> = {
  "article-market-ui.js": "2149e2854142657a554ef119533680c77657f0d2b1ea8406fe4de711e4fbe635",
  "article-market-ui.css": "582c879d9a634caa467f31896c928bf854fc16579a1565091bb5b0093ee0505c",
};
test("vendored article-market files are byte-identical to the pinned canonical client", () => {
  for (const [name, sha] of Object.entries(VENDORED)) {
    const mine = readFileSync(join(WEB, "vendor", "kalshi", name));
    assert.equal(createHash("sha256").update(mine).digest("hex"), sha, `${name} changed: re-vendor from the canonical source, never edit`);
  }
});
