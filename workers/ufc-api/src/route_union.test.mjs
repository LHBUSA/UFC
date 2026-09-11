/* Route-union regression suite. Run: node --test workers/ufc-api/src/route_union.test.mjs
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-11 the deployed Worker (API 2026-09-06.3, Cloudflare version
 * 5e01f119) turned out to be built from source that existed only as
 * uncommitted files, while main carried a different set of routes. Deploying
 * either side alone would have deleted routes the other served:
 *
 *   production-only  Fight DNA, videos, bout ledger, event intelligence,
 *                    splits/profiles, matchup DNA          (12 routes)
 *   main-only        weigh-ins (3 forms), injuries, fighter status,
 *                    card changes                          (6 routes)
 *
 * The merged Worker must dispatch EVERY one of them. Each case proves the
 * route reaches ITS handler -- the handler reads the table/view it owns -- and
 * answers either 200 with the standard envelope or that handler's own
 * documented refusal (never route_not_found), so a future merge that drops a
 * route fails here instead of in production. The PostgREST stub answers
 * generically; the handlers' data rules have their own suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const EVENT = "11111111-1111-4111-8111-111111111111";
const FIGHTER_A = "22222222-2222-4222-8222-222222222222";
const FIGHTER_B = "33333333-3333-4333-8333-333333333333";
const BOUT = "44444444-4444-4444-8444-444444444444";

const ROWS = {
  ufc_events: [{ id: EVENT, name: "UFC Test Night", event_date: "2026-09-12", venue: "Arena", city: "Glendale", region: "AZ", country: "USA", ufcstats_id: null, espn_event_id: null, card_status: "announced", is_ppv: false }],
  ufc_fighters: [
    { id: FIGHTER_A, name: "Alpha Test", nickname: null, espn_athlete_id: "900001", ufcstats_id: null, dob: "1995-01-01", height_in: 70, reach_in: 72, weight_lbs: 155, stance: "ORTHODOX", record_w: 10, record_l: 1, record_d: 0, record_nc: 0, is_active: true },
    { id: FIGHTER_B, name: "Bravo Test", nickname: null, espn_athlete_id: "900002", ufcstats_id: null, dob: "1994-01-01", height_in: 71, reach_in: 73, weight_lbs: 155, stance: "SOUTHPAW", record_w: 9, record_l: 2, record_d: 0, record_nc: 0, is_active: true },
  ],
  ufc_bouts: [{ id: BOUT, event_id: EVENT, fighter_a_id: FIGHTER_A, fighter_b_id: FIGHTER_B, weight_class: "LIGHTWEIGHT", weight_class_raw: "Lightweight", is_womens: false, is_title: false, scheduled_rounds: 3, card_position: "main", bout_order: 1, status: "announced", ufcstats_id: null, espn_competition_id: null }],
};

function installStub() {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (init.method && init.method !== "GET" && init.method !== "HEAD") {
      throw new Error(`stub: the read API must never write (${init.method} ${url.pathname})`);
    }
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return new Response(JSON.stringify({ statusCode: "404" }), { status: 404 });
    seen.push(m[1]);
    let rows = ROWS[m[1]] || [];
    const idf = url.searchParams.get("id");
    if (idf?.startsWith("eq.")) rows = rows.filter((r) => r.id === idf.slice(3));
    else if (idf?.startsWith("in.(")) { const ids = idf.slice(4, -1).split(","); rows = rows.filter((r) => ids.includes(r.id)); }
    const headers = { "Content-Type": "application/json", "Content-Range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
    return new Response(JSON.stringify(rows), { status: 200, headers });
  };
  return seen;
}

const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", UFC_IMAGE_BASE_URL: "https://cdn.example/ufc-media", API_VERSION: "route-union-test" };
const call = async (path, method = "GET") => {
  const res = await worker.fetch(new Request(`https://ufc-api.test${path}`, { method }), env);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, headers: res.headers };
};

/* Every route production served before this merge that main did not.
 * [path, table the handler must read, handler-owned codes that also prove
 * dispatch when the stub has no rows for it]. The DNA routes refuse to
 * synthesise without a snapshot ("dna_not_available"); their content rules
 * are covered by the DNA cases in index.test.mjs. */
const DNA_EMPTY = ["dna_not_available"];
const LOST_BY_MAIN = [
  ["/v1/ufc/dna/metrics", "ufc_dna_metric_definitions"],
  ["/v1/ufc/dna/query?metric=sig_landed_per_min&min_confidence=insufficient", "ufc_fighter_dna_snapshots", ["unknown_metric", "dna_not_available"]],
  ["/v1/ufc/videos", "ufc_videos"],
  [`/v1/ufc/bouts/${BOUT}/ledger`, "ufc_fight_state_ledger"],
  [`/v1/ufc/bouts/${BOUT}/videos`, "ufc_videos"],
  [`/v1/ufc/events/${EVENT}/intelligence`, "ufc_fight_state_ledger"],
  [`/v1/ufc/events/${EVENT}/videos`, "ufc_videos"],
  [`/v1/ufc/fighters/${FIGHTER_A}/dna`, "ufc_fighter_dna_snapshots", DNA_EMPTY],
  [`/v1/ufc/fighters/${FIGHTER_A}/splits`, "ufc_fighter_stance_splits", DNA_EMPTY],
  [`/v1/ufc/fighters/${FIGHTER_A}/videos`, "ufc_videos"],
  [`/v1/ufc/fighters/${FIGHTER_A}/round-profile`, "ufc_fighter_dna_snapshots", DNA_EMPTY],
  [`/v1/ufc/fighters/${FIGHTER_A}/finish-profile`, "ufc_fighter_dna_snapshots", DNA_EMPTY],
  [`/v1/ufc/fighters/${FIGHTER_A}/position-profile`, "ufc_fighter_dna_snapshots", DNA_EMPTY],
  [`/v1/ufc/matchups/${FIGHTER_A}/${FIGHTER_B}/dna`, "ufc_fighter_dna_snapshots", DNA_EMPTY],
];

/* Every route main added that production did not serve. */
const MISSING_FROM_PRODUCTION = [
  ["/v1/weigh-ins", "ufc_weigh_in_current"],
  ["/v1/ufc/weigh-ins", "ufc_weigh_in_current"],
  [`/v1/ufc/weigh-ins?event_id=${EVENT}`, "ufc_weigh_in_current"],
  [`/v1/ufc/events/${EVENT}/weigh-ins`, "ufc_weigh_in_event_summary"],
  [`/v1/ufc/events/${EVENT}/weigh-ins?include=history`, "ufc_weigh_in_history"],
  [`/v1/events/${EVENT}/weigh-ins`, "ufc_weigh_in_current"],
  ["/v1/ufc/injuries", "ufc_fighter_status_feed"],
  [`/v1/ufc/fighters/${FIGHTER_A}/status`, "ufc_fighter_status_feed"],
  [`/v1/ufc/events/${EVENT}/card-changes`, "ufc_event_card_changes"],
];

/* Routes both sides already served: they must still dispatch after the merge. */
const SHARED = [
  ["/v1/ufc"], ["/v1/ufc/events", "ufc_events"], [`/v1/ufc/events/${EVENT}`, "ufc_events"], [`/v1/ufc/events/${EVENT}/card`, "ufc_bouts"],
  [`/v1/ufc/events/${EVENT}/articles`, "ufc_articles"], ["/v1/ufc/fighters", "ufc_fighters"], [`/v1/ufc/fighters/media?ids=${FIGHTER_A}`, "ufc_images"],
  [`/v1/ufc/fighters/${FIGHTER_A}`, "ufc_fighters"], [`/v1/ufc/fighters/${FIGHTER_A}/history`, "ufc_bouts"], [`/v1/ufc/fighters/${FIGHTER_A}/stats`, "ufc_bout_round_stats"],
  [`/v1/ufc/fighters/${FIGHTER_A}/articles`, "ufc_articles"], [`/v1/ufc/bouts/${BOUT}`, "ufc_bouts"], [`/v1/ufc/bouts/${BOUT}/stats`, "ufc_bout_round_stats"],
  ["/v1/ufc/results", "ufc_bout_results"], ["/v1/ufc/rankings", "ufc_rankings", ["rankings_not_available"]], ["/v1/ufc/news", "ufc_articles"],
  ["/v1/ufc/wire", "ufc_news_items"], ["/v1/ufc/search?q=alpha", "ufc_fighters"], ["/v1/ufc/counts", "ufc_fighters"],
];

for (const [group, cases] of [["production route kept", LOST_BY_MAIN], ["main route added", MISSING_FROM_PRODUCTION], ["shared route kept", SHARED]]) {
  for (const [path, table, handlerCodes = []] of cases) {
    test(`${group}: GET ${path}`, async () => {
      const seen = installStub();
      const r = await call(path);
      assert.notEqual(r.body?.error?.code, "route_not_found", `${path} is not routed`);
      if (table) assert.ok(seen.includes(table), `${path} did not reach its handler (never read ${table}; read ${JSON.stringify([...new Set(seen)])})`);
      if (r.status === 200) {
        assert.equal(r.body?.ok, true, `${path} envelope`);
        assert.ok("data" in r.body && "meta" in r.body, `${path} envelope shape`);
        assert.equal(r.body.meta.version, "route-union-test", `${path} reports API_VERSION`);
      } else {
        assert.ok(handlerCodes.includes(r.body?.error?.code), `${path} -> ${r.status} ${JSON.stringify(r.body?.error || null)}`);
        assert.equal(r.body.ok, false);
      }
    });
  }
}

test("the discovery index lists both sides' routes", async () => {
  installStub();
  const r = await call("/v1/ufc");
  const listed = JSON.stringify(r.body.data);
  for (const needle of ["/v1/ufc/dna/metrics", "/v1/ufc/videos", "ledger", "intelligence", "weigh-ins", "/v1/ufc/injuries", "/status", "card-changes"]) {
    assert.ok(listed.includes(needle), `apiIndex is missing ${needle}`);
  }
});

test("an unknown route is still refused with route_not_found", async () => {
  installStub();
  const r = await call("/v1/ufc/definitely-not-a-route");
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "route_not_found");
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  for (const path of ["/v1/ufc/weigh-ins", `/v1/ufc/events/${EVENT}/weigh-ins`, "/v1/ufc/dna/query", `/v1/ufc/bouts/${BOUT}/ledger`]) {
    test(`${method} ${path} is refused and writes nothing`, async () => {
      const seen = installStub();
      const r = await call(path, method);
      assert.notEqual(r.status, 200, `${method} must not succeed`);
      assert.ok(r.status === 405 || r.status === 404 || r.status === 400, `${method} ${path} -> ${r.status}`);
      assert.equal(seen.length, 0, "a refused method must not reach the database");
    });
  }
}
