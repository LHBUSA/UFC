/* /v1/ufc/fighters/{id}/training over a stubbed PostgREST. Run: node --test src/training.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const F = "22222222-2222-4222-8222-222222222222";
const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", API_VERSION: "t" };
const fighter = { id: F, name: "Alpha Test", nickname: null, espn_athlete_id: "900001", ufcstats_id: null, dob: null, height_in: null, reach_in: null, weight_lbs: null, stance: null, record_w: 1, record_l: 0, record_d: 0, record_nc: 0, is_active: true };
const evidence = [{ observation_id: "o1", source_key: "espn_athlete_association", source_url: "https://sports.core.api.espn.com/x", certainty: "OBSERVED", relationship_type: "AFFILIATION", value_raw: "Kill Cliff FC", external_ref: "1", captured_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-26T22:00:00Z", effective_from: null, source_published_at: null }];

function stub(tables, { missing = [] } = {}) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.ok(!init.method || init.method === "GET", "read API never writes");
    const t = url.pathname.replace("/rest/v1/", "");
    seen.push(t);
    if (missing.includes(t)) return new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 });
    const rows = tables[t] || [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
  };
  return seen;
}
const get = async (path) => { const r = await worker.fetch(new Request(`https://ufc-api.test${path}`), env); return { status: r.status, body: await r.json() }; };

test("ESPN-only fighter: current camp + provenance, every other fact null / []", async () => {
  stub({
    ufc_fighters: [fighter],
    ufc_fighter_training_current: [{ fighter_id: F, current_camp: { camp_id: "c1", name: "Kill Cliff FC", slug: "kill-cliff-fc", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-26T22:00:00Z", joined_on: null, certainty: "OBSERVED", evidence }, fighting_out_of: null, training_location: null, coaches: [], other_camps: [], updated_at: "2026-09-26T22:00:00Z" }],
    ufc_fighter_camp_stints: [{ fighter_id: F, stint_no: 1, camp_id: "c1", camp_name: "Kill Cliff FC", camp_slug: "kill-cliff-fc", stint_start_at: "2026-09-26T22:00:00Z", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-26T22:00:00Z", joined_on: null, certainty: "OBSERVED", next_stint_start_at: null, next_first_observed_at: null, left_on: null, is_current: true, evidence }],
  });
  const r = await get(`/v1/ufc/fighters/${F}/training`);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.fighter.id, F);
  assert.deepEqual(d.current_camp.since, { kind: "first_observed", date: "2026-09-26" });
  assert.equal(d.current_camp.name, "Kill Cliff FC");
  for (const k of ["fighting_out_of", "training_location", "new_camp_since_last_bout"]) assert.equal(d[k], null, k);
  for (const k of ["coaches", "other_camps", "changes"]) assert.deepEqual(d[k], [], k);
  assert.equal(d.camp_history.length, 1);
  assert.equal(d.provenance[0].source_key, "espn_athlete_association", "upstream provenance stays in the API");
  assert.match(r.body.meta.contract, /first_observed/);
});

test("fighter with nothing on file, and 032 objects missing: empty contract, not an error", async () => {
  stub({ ufc_fighters: [fighter] }, { missing: ["ufc_fighter_training_current", "ufc_fighter_camp_stints", "ufc_training_change_events"] });
  const r = await get(`/v1/ufc/fighters/${F}/training`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.current_camp, null);
  assert.deepEqual(r.body.data.camp_history, []);
  assert.deepEqual(r.body.data.provenance, []);
});

test("include=training on the fighter composite; unknown fighter is 404", async () => {
  stub({ ufc_fighters: [fighter] });
  const r = await get(`/v1/ufc/fighters/${F}?include=training`);
  assert.equal(r.status, 200);
  assert.ok("training" in r.body.data);
  assert.equal(r.body.data.training.current_camp, null);
  const plain = await get(`/v1/ufc/fighters/${F}`);
  assert.ok(!("training" in plain.body.data), "additive: absent unless requested");
  stub({ ufc_fighters: [] });
  assert.equal((await get(`/v1/ufc/fighters/${F}/training`)).status, 404);
});
