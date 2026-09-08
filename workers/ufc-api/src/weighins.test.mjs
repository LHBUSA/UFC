/* The weigh-in read endpoints. Run: node --test src/weighins.test.mjs
 *
 * The contract these protect is that a null limit crosses the API as a null.
 * The moment an API substitutes a division default for "the contracted figure
 * was not published", every consumer downstream is asserting a limit nobody
 * agreed to — wrong on every title fight and every catchweight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "./index.js";

const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", API_VERSION: "test" };

const EVENT = { id: "e-1", ufcstats_id: null, espn_event_id: "e-1", name: "UFC 331", event_date: "2026-09-19", venue: null, city: null, region: null, country: null, card_status: "scheduled", is_ppv: true };

const base = {
  event_id: "e-1", event_name: "UFC 331", event_date: "2026-09-19",
  bout_id: "b-1", fighter_id: "f-1", fighter_name: "Jane Doe",
  fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
  weight_class: "LIGHTWEIGHT", weight_class_raw: "Lightweight Bout",
  is_womens: false, is_title: false, card_position: "main", bout_order: 13, bout_status: "confirmed",
  attempt_number: 1, catchweight_lbs: null, weighed_at: "2026-09-18T09:12:00Z",
  source_url: "https://www.ufc.com/event/ufc-331", source_name: "UFC.com", source_kind: "official",
  source_published_at: "2026-09-18T09:14:00Z", detected_at: "2026-09-18T09:15:00Z",
  first_seen_at: "2026-09-18T09:15:00Z", last_seen_at: "2026-09-18T09:45:00Z",
  raw_text: "Jane Doe (155.5)", supersedes_id: null, is_correction: false,
};

/** Made weight, limit fully supported. */
const MADE = {
  ...base, id: "w-1",
  contracted_limit_lbs: 155, allowance_lbs: 1, limit_basis: "division_rule", applicable_limit_lbs: 156,
  official_weight_lbs: 155.5, result: "made", over_by_lbs: null,
};
/** Missed, with a supported limit and a real delta. */
const MISSED = {
  ...base, id: "w-2", fighter_id: "f-2", fighter_name: "John Roe",
  contracted_limit_lbs: 155, allowance_lbs: 1, limit_basis: "division_rule", applicable_limit_lbs: 156,
  official_weight_lbs: 158.5, result: "missed", over_by_lbs: 2.5,
};
/** A catchweight whose agreed figure was never published. THE key row. */
const UNSUPPORTED = {
  ...base, id: "w-3", fighter_id: "f-3", fighter_name: "Alex Poe",
  weight_class: "CATCHWEIGHT", weight_class_raw: "Catchweight Bout",
  contracted_limit_lbs: null, allowance_lbs: null, limit_basis: "unsupported", applicable_limit_lbs: null,
  official_weight_lbs: 165.5, result: "made", over_by_lbs: null,
};
/** Not yet on the scale. */
const PENDING = {
  ...base, id: "w-4", fighter_id: "f-4", fighter_name: "Sam Vega",
  contracted_limit_lbs: 135, allowance_lbs: 1, limit_basis: "division_rule", applicable_limit_lbs: 136,
  official_weight_lbs: null, result: "pending", over_by_lbs: null, weighed_at: null,
  detected_at: "2026-09-18T08:00:00Z",
};

const SUMMARY = {
  event_id: "e-1", event_name: "UFC 331", event_date: "2026-09-19",
  expected: 4, weighed: 3, made: 2, missed: 1, pending: 1, withdrawn: 0, cancelled: 0,
  catchweights: 0, corrections: 0, limit_unsupported: 1,
  last_source_update: "2026-09-18T09:45:00Z", newest_source_published_at: "2026-09-18T09:14:00Z", first_seen_at: "2026-09-18T08:00:00Z",
};

const TABLES = {
  ufc_events: [EVENT],
  ufc_weigh_in_current: [MADE, MISSED, UNSUPPORTED, PENDING],
  ufc_weigh_in_event_summary: [SUMMARY],
  ufc_weigh_in_history: [{ ...MISSED, occurred_at: "2026-09-18T09:12:00Z", superseded_at: null, correction_reason: null }],
};

function install({ tables = TABLES, missing = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(url.pathname + url.search);
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return new Response("nope", { status: 404 });
    const table = m[1];
    if (missing.includes(table) || !(table in tables)) {
      return new Response(JSON.stringify({ code: "42P01" }), { status: 404 });
    }
    let rows = tables[table];
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      const op = v.slice(0, v.indexOf("."));
      const val = v.slice(v.indexOf(".") + 1);
      if (op === "eq") rows = rows.filter((r) => String(r[k]) === val);
      if (op === "gte") rows = rows.filter((r) => String(r[k]) >= val);
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const call = async (path) => {
  const res = await worker.fetch(new Request(`https://ufc-api.test${path}`), env);
  return { res, body: await res.json() };
};

/* ================= the contract ================= */

test("an unpublished contracted limit crosses the API as null, never a division default", async () => {
  install();
  const { body } = await call("/v1/ufc/weigh-ins?event_id=e-1");
  const row = body.data.find((r) => r.id === "w-3");
  assert.equal(row.contracted_limit_lbs, null);
  assert.equal(row.applicable_limit_lbs, null);
  assert.equal(row.over_by_lbs, null);
  assert.equal(row.limit_basis, "unsupported", "and the reason is machine-readable");
  /* Keys present with nulls, not omitted: an absent key reads as "this API
   * does not model limits", which is a different and wronger thing. */
  for (const k of ["contracted_limit_lbs", "applicable_limit_lbs", "over_by_lbs", "limit_basis"]) {
    assert.ok(k in row, `${k} must be present`);
  }
});

test("the response states the contract so a consumer cannot infer the wrong thing", async () => {
  install();
  const { body } = await call("/v1/ufc/weigh-ins");
  assert.match(body.meta.contract, /not that a division default applies/);
});

test("a supported limit carries its delta and its basis", async () => {
  install();
  const { body } = await call("/v1/ufc/weigh-ins?status=missed");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].over_by_lbs, 2.5);
  assert.equal(body.data[0].applicable_limit_lbs, 156);
  assert.equal(body.data[0].limit_basis, "division_rule");
});

/* ================= filters ================= */

test("?event_id, ?fighter_id and ?status all reach PostgREST", async () => {
  const calls = install();
  await call("/v1/ufc/weigh-ins?event_id=e-1&fighter_id=f-2&status=missed");
  assert.ok(calls.some((c) => c.includes("event_id=eq.e-1")));
  assert.ok(calls.some((c) => c.includes("fighter_id=eq.f-2")));
  assert.ok(calls.some((c) => c.includes("result=eq.missed")), "status maps to the result column");
});

test("?since filters on OUR detection clock, not the publisher's", async () => {
  /* A poller asking "what is new to you" wants our clock; a source that
   * back-dates its timestamps must not be able to hide a change from it. */
  const calls = install();
  await call("/v1/ufc/weigh-ins?since=2026-09-18T09:00:00Z");
  assert.ok(calls.some((c) => c.includes("detected_at=gte.")), "since must filter detected_at");
  assert.ok(!calls.some((c) => c.includes("source_published_at=gte.")));

  install();
  const { body } = await call("/v1/ufc/weigh-ins?since=2026-09-18T09:00:00Z");
  assert.ok(!body.data.some((r) => r.id === "w-4"), "the row detected at 08:00 is excluded");
});

test("an invalid status or since is a 400, not a silent full scan", async () => {
  install();
  const bad = await call("/v1/ufc/weigh-ins?status=chunky");
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error.code, "invalid_status");

  install();
  const badSince = await call("/v1/ufc/weigh-ins?since=yesterday");
  assert.equal(badSince.res.status, 400);
  assert.equal(badSince.body.error.code, "invalid_since");
});

/* ================= per-event endpoint ================= */

test("the event endpoint returns results, coverage state and the event", async () => {
  install();
  const { res, body } = await call("/v1/ufc/events/e-1/weigh-ins");
  assert.equal(res.status, 200);
  assert.equal(body.data.event.name, "UFC 331");
  assert.equal(body.data.results.length, 4);
  assert.equal(body.data.coverage.state, "live", "one fighter is still pending");
  assert.equal(body.data.coverage.limit_unsupported, 1);
  assert.equal(body.data.history, undefined, "history is opt-in");
});

test("coverage distinguishes an uncovered card from an empty one", async () => {
  /* Both look like an empty array to a consumer; they are not the same thing. */
  install({ tables: { ...TABLES, ufc_weigh_in_event_summary: [] } });
  const { body } = await call("/v1/ufc/events/e-1/weigh-ins");
  assert.equal(body.data.coverage.state, "no_data");
  assert.match(body.data.coverage.note, /no weigh-in readings recorded/);
});

test("a finished card reports final rather than live", async () => {
  install({ tables: { ...TABLES, ufc_weigh_in_event_summary: [{ ...SUMMARY, pending: 0 }] } });
  const { body } = await call("/v1/ufc/events/e-1/weigh-ins");
  assert.equal(body.data.coverage.state, "final");
});

test("?include=history returns the audit trail", async () => {
  install();
  const { body } = await call("/v1/ufc/events/e-1/weigh-ins?include=history");
  assert.equal(Array.isArray(body.data.history), true);
  assert.equal(body.data.history.length, 1);
  assert.match(body.meta.contract, /supersedes_id chains the earlier ones/);
});

test("an unknown event is a 404, not an empty result set", async () => {
  install();
  const { res, body } = await call("/v1/ufc/events/nope/weigh-ins");
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "event_not_found");
});

/* ================= read-only, and cached for a live desk ================= */

test("there is no write route: every method but GET is refused", async () => {
  install();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await worker.fetch(new Request("https://ufc-api.test/v1/ufc/weigh-ins", { method }), env);
    assert.equal(res.status, 405, `${method} must not be accepted on a read API`);
  }
});

test("weigh-in responses carry a short cache, matching the desk", async () => {
  install();
  const res = await worker.fetch(new Request("https://ufc-api.test/v1/ufc/weigh-ins"), env);
  assert.match(res.headers.get("Cache-Control") || "", /max-age=15\b/);
});

test("both the short and namespaced paths work, and are advertised", async () => {
  install();
  assert.equal((await call("/v1/weigh-ins")).res.status, 200);
  assert.equal((await call("/v1/ufc/weigh-ins")).res.status, 200);
  install();
  const { body } = await call("/v1/ufc");
  assert.match(body.data.endpoints.weigh_ins, /weigh-ins/);
  assert.match(body.data.endpoints.event_weigh_ins, /events\/\{id\}\/weigh-ins/);
});

test("before the migration is applied the endpoint fails as upstream, not as data", async () => {
  /* A 200 with an empty array would say "nobody weighed in". */
  install({ missing: ["ufc_weigh_in_current"] });
  const { res, body } = await call("/v1/ufc/weigh-ins");
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "upstream_error");
});

test("the result vocabulary matches the migration's CHECK constraint", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../../../supabase/migrations/20260908000013_ufc_weigh_ins.sql", import.meta.url), "utf8");
  for (const r of __test.WEIGHIN_RESULTS) assert.ok(sql.includes(`'${r}'`), `result ${r} missing from the migration`);
  for (const b of ["sourced", "division_rule", "unsupported"]) assert.ok(sql.includes(`'${b}'`), `limit_basis ${b} missing`);
});
