/* The three availability endpoints. Run: node --test src/status.test.mjs
 *
 * The contract these protect is not the JSON shape. It is that a null
 * injury_type crosses the API boundary as a null and arrives at a consumer as
 * a null — because the moment an API substitutes "unspecified" for "the source
 * did not say", every client downstream is repeating a medical claim about a
 * named person that nobody made.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "./index.js";

const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", API_VERSION: "test" };

const EVENT = { id: "e-1", ufcstats_id: null, espn_event_id: "e-1", name: "UFC 320", event_date: "2026-11-14", venue: null, city: null, region: null, country: null, card_status: "scheduled", is_ppv: true };
const FIGHTER = { id: "f-1", ufcstats_id: null, espn_athlete_id: "f-1", name: "Jane Doe", nickname: null, dob: null, height_in: null, reach_in: null, weight_lbs: null, stance: null, record_w: 10, record_l: 2, record_d: 0, record_nc: 0, is_active: true };

/** An unspecified injury: the row this whole system is shaped around. */
const UNSPECIFIED = {
  id: "s-1", fighter_id: "f-1", fighter_name: "Jane Doe", fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
  record_w: 10, record_l: 2, record_d: 0,
  status_type: "withdrawal", status_detail: null, state: "active",
  event_id: "e-1", event_name: "UFC 320", event_date: "2026-11-14", bout_id: "b-1",
  replacement_fighter_id: null, replacement_fighter_name: null, replaced_fighter_id: null, replaced_fighter_name: null,
  injury_type: null, body_part: null, injury_side: null, clinical_quote: null,
  expected_return_at: null, expected_return_note: null,
  source_url: "https://www.ufc.com/news/card-update", source_name: "UFC.com", source_kind: "official",
  source_published_at: "2026-10-01T12:00:00Z", detected_at: "2026-10-01T12:05:00Z", effective_at: null,
  confidence: 0.9, resolved_by_event_id: null, supersedes_event_id: null, occurred_at: "2026-10-01T12:00:00Z",
};
/** A named injury, with the sentence that licensed it. */
const NAMED = {
  ...UNSPECIFIED, id: "s-2", status_type: "injury", state: "resolved",
  injury_type: "torn acl", body_part: "knee", injury_side: "left",
  clinical_quote: "Doe tore her left ACL in training, her coach said.",
  source_kind: "news", source_name: "MMA Fighting", occurred_at: "2026-09-01T12:00:00Z",
};

const CARD_CHANGE = {
  event_id: "e-1", id: "s-1", fighter_id: "f-1", fighter_name: "Jane Doe",
  fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
  status_type: "withdrawal", state: "active", bout_id: "b-1",
  replacement_fighter_id: null, replacement_fighter_name: null,
  replaced_fighter_id: null, replaced_fighter_name: null,
  status_detail: null, injury_type: null, body_part: null,
  source_url: "https://www.ufc.com/news/card-update", source_name: "UFC.com", source_kind: "official",
  confidence: 0.9, occurred_at: "2026-10-01T12:00:00Z",
};

const TABLES = {
  ufc_events: [EVENT],
  ufc_fighters: [FIGHTER],
  ufc_fighter_status_feed: [UNSPECIFIED, NAMED],
  ufc_event_card_changes: [CARD_CHANGE],
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
      return new Response(JSON.stringify({ code: "42P01", message: `relation "public.${table}" does not exist` }), { status: 404 });
    }
    /* Honour the filters the reader sets, so a test can assert that ?active
     * actually reached PostgREST rather than being dropped. */
    let rows = tables[table];
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      const [op, val] = [v.slice(0, v.indexOf(".")), v.slice(v.indexOf(".") + 1)];
      if (op === "eq") rows = rows.filter((r) => String(r[k]) === val);
      if (op === "neq") rows = rows.filter((r) => String(r[k]) !== val);
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

test("a null diagnosis crosses the API as null — never a placeholder", async () => {
  install();
  const { body } = await call("/v1/ufc/injuries?state=all");
  const row = body.data.find((r) => r.id === "s-1");
  assert.equal(row.injury_type, null, "the API must not invent what the source did not say");
  assert.equal(row.body_part, null);
  assert.equal(row.injury_side, null);
  assert.equal(row.clinical_quote, null, "and no quote, because there is nothing to quote");
  /* The serialized JSON must carry the key with a null, not omit it: an absent
   * key reads as "this API does not model diagnoses", which is a different and
   * wronger thing than "no diagnosis was stated". */
  assert.ok("injury_type" in row);
});

test("a named diagnosis always travels with the sentence that licensed it", async () => {
  install();
  const { body } = await call("/v1/ufc/injuries?state=all");
  const row = body.data.find((r) => r.id === "s-2");
  assert.equal(row.injury_type, "torn acl");
  assert.equal(row.injury_side, "left");
  assert.ok(row.clinical_quote && row.clinical_quote.length > 10, "a clinical claim without its quote is unusable");
});

/* ================= filtering ================= */

test("?active=true filters to current events, and is the default", async () => {
  const calls = install();
  const { body } = await call("/v1/ufc/injuries?active=true");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].state, "active");
  assert.ok(calls.some((c) => c.includes("state=eq.active")), "the filter must reach PostgREST, not be applied in memory");

  install();
  const dflt = await call("/v1/ufc/injuries");
  assert.equal(dflt.body.data.length, 1, "no query means active: an injuries page defaults to who is out now");

  install();
  const all = await call("/v1/ufc/injuries?state=all");
  assert.equal(all.body.data.length, 2, "state=all includes resolved history");
});

test("?fighter_id and ?event_id scope the feed", async () => {
  const calls = install();
  await call("/v1/ufc/injuries?fighter_id=f-1&event_id=e-1&state=all");
  assert.ok(calls.some((c) => c.includes("fighter_id=eq.f-1")));
  assert.ok(calls.some((c) => c.includes("event_id=eq.e-1")));
});

test("an unknown state or status_type is a 400, not a silent full scan", async () => {
  install();
  const bad = await call("/v1/ufc/injuries?state=maybe");
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error.code, "invalid_state");

  install();
  const badType = await call("/v1/ufc/injuries?status_type=sprained_vibes");
  assert.equal(badType.res.status, 400);
  assert.equal(badType.body.error.code, "invalid_status_type");
});

/* ================= the other two endpoints ================= */

test("event card changes resolve the event and return its changes", async () => {
  install();
  const { res, body } = await call("/v1/ufc/events/e-1/card-changes");
  assert.equal(res.status, 200);
  assert.equal(body.data.event.name, "UFC 320");
  assert.equal(body.data.changes.length, 1);
  assert.equal(body.data.changes[0].source_kind, "official");
});

test("an unknown event is a 404 rather than an empty card-changes list", async () => {
  install();
  const { res, body } = await call("/v1/ufc/events/nope/card-changes");
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "event_not_found");
});

test("fighter status says current, history, and what a null current means", async () => {
  install();
  const { body } = await call("/v1/ufc/fighters/f-1/status");
  assert.equal(body.data.fighter.name, "Jane Doe");
  assert.equal(body.data.current.id, "s-1", "the active unavailable event is the current one");
  assert.equal(body.data.current_note, null, "no note needed when there is a current event");
  assert.equal(body.data.history.length, 2, "history keeps resolved events");
});

test("no status on file is explicitly NOT a clean bill of health", async () => {
  /* The most dangerous possible misreading of this endpoint, so the API says
   * it in words rather than leaving a null to be interpreted. */
  install({ tables: { ...TABLES, ufc_fighter_status_feed: [] } });
  const { body } = await call("/v1/ufc/fighters/f-1/status");
  assert.equal(body.data.current, null);
  assert.match(body.data.current_note, /absence of a report, not a confirmation of fitness/);
});

test("a resolved event is never the current status", async () => {
  install({ tables: { ...TABLES, ufc_fighter_status_feed: [NAMED] } });
  const { body } = await call("/v1/ufc/fighters/f-1/status");
  assert.equal(body.data.current, null, "resolved history must not render as present-tense unavailability");
  assert.equal(body.data.history.length, 1);
});

/* ================= availability of the endpoints themselves ============= */

test("before the migration is applied the endpoints fail as upstream, not as data", async () => {
  /* The tables do not exist yet in any environment. A 502 naming the upstream
   * is honest; a 200 with an empty array would say "nobody is injured". */
  install({ missing: ["ufc_fighter_status_feed"] });
  const { res, body } = await call("/v1/ufc/injuries");
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "upstream_error");
});

test("the endpoints are advertised on the API index", async () => {
  install();
  const { body } = await call("/v1/ufc");
  assert.equal(body.data.endpoints.injuries, "/v1/ufc/injuries?active=true");
  assert.equal(body.data.endpoints.event_card_changes, "/v1/ufc/events/{id}/card-changes");
  assert.equal(body.data.endpoints.fighter_status, "/v1/ufc/fighters/{id}/status");
});

test("the status vocabulary matches the migration's CHECK constraint", async () => {
  /* Two lists of the same enum will drift; this is the cheap guard. */
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../../../supabase/migrations/20260908000011_ufc_fighter_status.sql", import.meta.url), "utf8");
  for (const t of __test.STATUS_TYPES) {
    assert.ok(sql.includes(`'${t}'`), `status_type ${t} is missing from the migration`);
  }
  for (const s of __test.STATUS_STATES) assert.ok(sql.includes(`'${s}'`), `state ${s} is missing from the migration`);
});
