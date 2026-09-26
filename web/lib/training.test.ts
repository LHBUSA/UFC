/* Training & Corner assembly + wording rules. Run: npm run test:training */
import test from "node:test";
import assert from "node:assert/strict";
import { trainingPayload, newCampSinceLastBout, changeLabel, startLabel, monthYear, placeLabel, yearSpan, type StintRow, type ChangeRow, type CurrentRow } from "./training.ts";

const ev = (over: Partial<StintRow["evidence"][number]> = {}) => ({
  observation_id: "o1", source_key: "espn_athlete_association", source_url: "https://src.example/a", certainty: "OBSERVED" as const,
  relationship_type: "AFFILIATION", value_raw: "Camp", external_ref: "1", captured_at: "2026-09-26T22:00:00Z",
  last_confirmed_at: "2026-09-26T22:00:00Z", effective_from: null, source_published_at: null, ...over,
});

function stint(no: number, over: Partial<StintRow>): StintRow {
  return {
    fighter_id: "f", stint_no: no, camp_id: `c${no}`, camp_name: `Camp ${no}`, camp_slug: `camp-${no}`,
    stint_start_at: "2026-09-26T22:00:00Z", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-26T22:00:00Z",
    joined_on: null, certainty: "OBSERVED", next_stint_start_at: null, next_first_observed_at: null, left_on: null,
    is_current: false, evidence: [ev()], ...over,
  };
}
const change = (over: Partial<ChangeRow>): ChangeRow => ({
  id: "e1", kind: "AFFILIATION_CHANGED_OBSERVED", previous_value: "Camp 1", new_value: "Camp 2", previous_camp_id: "c1", new_camp_id: "c2",
  supersedes_event_id: null, effective_on: null, observed_at: "2027-03-01T06:00:00Z", source_url: "https://src.example/a", ...over,
});

test("an observed-only camp is 'First observed', never 'Joined'", () => {
  assert.equal(startLabel({ joined_on: null, first_observed_at: "2026-09-26T22:00:00Z", certainty: "OBSERVED" }), "First observed Sep 2026");
  assert.equal(startLabel({ joined_on: "2025-03-10", first_observed_at: "2026-09-26T22:00:00Z", certainty: "STATED" }), "Joined Mar 2025");
});

test("an observed change is 'Camp affiliation changed'; only a confirmed event is a switch", () => {
  assert.equal(changeLabel(change({})), "Camp affiliation changed: Camp 1 → Camp 2");
  assert.doesNotMatch(changeLabel(change({})), /switch/i);
  assert.equal(changeLabel(change({ kind: "CAMP_CHANGED_CONFIRMED" })), "Switched camps: Camp 1 → Camp 2");
  assert.equal(changeLabel(change({ kind: "COACH_REMOVED", previous_value: "A · STRIKING", new_value: null })), "Coach no longer listed: A · Striking");
  assert.equal(changeLabel(change({ kind: "COACH_ADDED", previous_value: null, new_value: "B · OTHER" })), "Coach added: B");
});

test("new camp since last bout: observed chronology that spans the bout", () => {
  const stints = [
    stint(1, { first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-12-20T06:00:00Z" }),
    stint(2, { first_observed_at: "2027-03-01T06:00:00Z", last_confirmed_at: "2027-03-05T06:00:00Z", is_current: true }),
  ];
  const r = newCampSinceLastBout(stints, [change({})], "2026-12-13");
  assert.deepEqual(r, {
    from: { camp_id: "c1", name: "Camp 1", slug: "camp-1" },
    to: { camp_id: "c2", name: "Camp 2", slug: "camp-2", since: { kind: "first_observed", date: "2027-03-01" } },
    last_bout_date: "2026-12-13", basis: "observed",
  });
});

test("new camp since last bout: refused when the previous camp is not proven at the bout", () => {
  // last seen at camp 1 before the bout: the fighter could have moved before fighting
  const gap = [
    stint(1, { first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-10-01T06:00:00Z" }),
    stint(2, { first_observed_at: "2027-03-01T06:00:00Z", is_current: true }),
  ];
  assert.equal(newCampSinceLastBout(gap, [change({})], "2026-12-13"), null);
  // first observed at camp 1 only after the bout: history did not cover it
  const late = [
    stint(1, { first_observed_at: "2027-01-02T06:00:00Z", last_confirmed_at: "2027-02-01T06:00:00Z" }),
    stint(2, { first_observed_at: "2027-03-01T06:00:00Z", is_current: true }),
  ];
  assert.equal(newCampSinceLastBout(late, [], "2026-12-13"), null);
  // the current camp was already there before the bout
  const before = [
    stint(1, { first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-11-01T06:00:00Z" }),
    stint(2, { first_observed_at: "2026-11-02T06:00:00Z", is_current: true }),
  ];
  assert.equal(newCampSinceLastBout(before, [], "2026-12-13"), null);
  // one camp, no previous bout, no current stint
  assert.equal(newCampSinceLastBout([stint(1, { is_current: true })], [], "2026-12-13"), null);
  assert.equal(newCampSinceLastBout(before, [], null), null);
  assert.equal(newCampSinceLastBout([stint(1, {}), stint(2, {})], [], "2026-12-13"), null);
});

test("new camp since last bout: a confirmed switch dated after the bout proves it", () => {
  const stints = [
    stint(1, { first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-10-01T06:00:00Z" }),
    stint(2, { joined_on: "2027-01-15", certainty: "STATED", first_observed_at: "2027-02-01T06:00:00Z", is_current: true }),
  ];
  const r = newCampSinceLastBout(stints, [change({ kind: "CAMP_CHANGED_CONFIRMED", effective_on: "2027-01-15" })], "2026-12-13");
  assert.equal(r?.basis, "confirmed");
  assert.deepEqual(r?.to.since, { kind: "joined", date: "2027-01-15" });
});

test("payload: a fighter with nothing on file is all null / [] (no fabricated completeness)", () => {
  const p = trainingPayload({ current: null, stints: [], changes: [] });
  assert.deepEqual(p, { current_camp: null, fighting_out_of: null, training_location: null, coaches: [], other_camps: [], camp_history: [], changes: [], new_camp_since_last_bout: null, updated_at: null, provenance: [] });
});

test("payload: ESPN-only fighter shows the current camp with provenance, nothing else", () => {
  const current: CurrentRow = {
    fighter_id: "f",
    current_camp: { camp_id: "c1", name: "Kill Cliff FC", slug: "kill-cliff-fc", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-27T06:00:00Z", joined_on: null, certainty: "OBSERVED", evidence: [ev({ value_raw: "Kill Cliff FC" })] },
    fighting_out_of: null, training_location: null, coaches: [], other_camps: [], updated_at: "2026-09-27T06:00:00Z",
  };
  const p = trainingPayload({ current, stints: [stint(1, { camp_name: "Kill Cliff FC", camp_slug: "kill-cliff-fc", is_current: true })], changes: [] });
  assert.equal(p.current_camp?.name, "Kill Cliff FC");
  assert.deepEqual(p.current_camp?.since, { kind: "first_observed", date: "2026-09-26" });
  assert.equal(p.fighting_out_of, null);
  assert.equal(p.training_location, null);
  assert.deepEqual(p.coaches, []);
  assert.equal(p.camp_history.length, 1);
  assert.equal(p.camp_history[0].to, null);
  assert.deepEqual(p.provenance.map((x) => [x.fact, x.source_key]), [["current_camp", "espn_athlete_association"]]);
});

test("payload: history newest first; a closed observed stint ends at its last observation; superseded events flagged", () => {
  const stints = [
    stint(1, { first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2027-02-20T06:00:00Z" }),
    stint(2, { first_observed_at: "2027-03-01T06:00:00Z", is_current: true }),
  ];
  const changes = [change({ id: "obs" }), change({ id: "conf", kind: "CAMP_CHANGED_CONFIRMED", supersedes_event_id: "obs", observed_at: "2027-03-10T00:00:00Z" })];
  const p = trainingPayload({ current: null, stints, changes });
  assert.deepEqual(p.camp_history.map((h) => [h.name, h.from.kind, h.to?.kind ?? null, h.to?.date ?? null]), [["Camp 2", "first_observed", null, null], ["Camp 1", "first_observed", "last_observed", "2027-02-20"]]);
  assert.deepEqual(p.changes.map((c) => [c.id, c.superseded_by_confirmation]), [["conf", false], ["obs", true]]);
});

test("formatting helpers", () => {
  assert.equal(monthYear("2026-09-26T22:00:00Z"), "Sep 2026");
  assert.equal(monthYear(null), null);
  assert.equal(placeLabel({ city: "Miami", region: "Florida", country: null }), "Miami, Florida");
  assert.equal(placeLabel({ city: null, region: null, country: null }), null);
  assert.equal(yearSpan({ date: "2026-09-26" }, null), "2026 – present");
  assert.equal(yearSpan({ date: "2023-01-01" }, { date: "2026-02-01" }), "2023 – 2026");
  assert.equal(yearSpan({ date: "2026-01-01" }, { date: "2026-02-01" }), "2026");
});

test("no raw role code ever reaches customer copy; the raw role is kept", () => {
  const current: CurrentRow = { fighter_id: "f", current_camp: null, fighting_out_of: null, training_location: null, other_camps: [], updated_at: null,
    coaches: [{ coach_id: "k", name: "Carlos B", slug: "carlos-b", role: "OTHER", since: null, certainty: "STATED", source_key: "ufc_training_manual", source_url: "https://x.example", captured_at: "2026-09-26T00:00:00Z" },
      { coach_id: "k2", name: "Dee S", slug: "dee-s", role: "STRENGTH_CONDITIONING", since: null, certainty: "STATED", source_key: "ufc_training_manual", source_url: "https://x.example", captured_at: "2026-09-26T00:00:00Z" }] };
  const p = trainingPayload({ current, stints: [], changes: [change({ kind: "COACH_ADDED", previous_value: null, new_value: "Carlos B · OTHER" }), change({ id: "e2", kind: "COACH_REMOVED", previous_value: "Dee S · STRENGTH_CONDITIONING", new_value: null })] });
  assert.deepEqual(p.coaches.map((c) => [c.role, c.role_label, c.role_specified]), [["OTHER", "Coach", false], ["STRENGTH_CONDITIONING", "Strength & conditioning", true]]);
  const copy = JSON.stringify({ labels: p.changes.map((c) => [c.label, c.previous_value, c.new_value]), roles: p.coaches.map((c) => c.role_label) });
  assert.doesNotMatch(copy, /OTHER|STRENGTH_CONDITIONING|MUAY_THAI/);
});
