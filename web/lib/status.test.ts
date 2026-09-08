/* Status display rules. Run: node --test --experimental-strip-types web/lib/status.test.ts
 *
 * These are the last place the "never infer a diagnosis" rule can be broken.
 * The extractor can be perfect and the schema can hold, and a display helper
 * that renders null as "Undisclosed injury" still puts a claim on the page
 * that no source made. So the null case is asserted here, in words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { diagnosisLine, hasDiagnosis, statusHeadline, UNAVAILABLE, STATUS_LABEL, type StatusEvent } from "./status-display.ts";

const evt = (over: Partial<StatusEvent> = {}): StatusEvent => ({
  id: "s1", fighter_id: "f1", fighter_name: "Jane Doe",
  fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
  record_w: 10, record_l: 2, record_d: 0,
  status_type: "injury", status_detail: null, state: "active",
  event_id: null, event_name: null, event_date: null, bout_id: null,
  replacement_fighter_id: null, replacement_fighter_name: null,
  replaced_fighter_id: null, replaced_fighter_name: null,
  injury_type: null, body_part: null, injury_side: null, clinical_quote: null,
  expected_return_at: null, expected_return_note: null,
  source_url: "https://example.invalid/a", source_name: "Example", source_kind: "news",
  source_published_at: null, detected_at: "2026-09-08T12:00:00Z", effective_at: null,
  confidence: 0.8, occurred_at: "2026-09-08T12:00:00Z",
  ...over,
});

test("an unstated diagnosis renders as a sentence saying so, never as a value", () => {
  const line = diagnosisLine(evt());
  assert.equal(line, "No diagnosis stated by the source");
  /* The specific words that must never appear: each of them reads as a fact
   * we hold about a named person's body. */
  for (const forbidden of ["undisclosed", "unspecified", "unknown injury", "n/a", "—"]) {
    assert.ok(!line.toLowerCase().includes(forbidden), `"${forbidden}" would read as a claim`);
  }
  assert.equal(hasDiagnosis(evt()), false);
});

test("a body part without a diagnosis says what is missing", () => {
  const line = diagnosisLine(evt({ body_part: "knee" }));
  assert.match(line, /^Knee/);
  assert.match(line, /does not say what the injury is/, "where is not what, and the line has to say so");
  assert.equal(hasDiagnosis(evt({ body_part: "knee" })), false, "a body part is not a diagnosis");
});

test("a named diagnosis renders with side and correct acronym casing", () => {
  assert.equal(diagnosisLine(evt({ injury_type: "torn acl", injury_side: "left" })), "Left torn ACL");
  assert.equal(diagnosisLine(evt({ injury_type: "torn mcl" })), "Torn MCL");
  assert.equal(diagnosisLine(evt({ injury_type: "broken hand" })), "Broken hand");
  assert.equal(hasDiagnosis(evt({ injury_type: "torn acl" })), true);
});

test("headlines are built only from fields we hold", () => {
  assert.equal(statusHeadline(evt({ status_type: "withdrawal", event_name: "UFC 332" })), "Jane Doe is off UFC 332");
  assert.equal(statusHeadline(evt({ status_type: "withdrawal" })), "Jane Doe is off the card",
    "no event on file means a generic card, not an invented event name");
  assert.equal(statusHeadline(evt({ status_type: "replacement", replaced_fighter_name: "John Roe" })), "Jane Doe steps in for John Roe");
  assert.equal(statusHeadline(evt({ status_type: "replacement" })), "Jane Doe steps in",
    "an unknown counterpart is omitted, not guessed");
});

test("only genuinely unavailable statuses count as unavailable", () => {
  for (const t of ["injury", "illness", "withdrawal", "suspension", "visa_travel"] as const) {
    assert.ok(UNAVAILABLE.has(t), `${t} makes a fighter unavailable`);
  }
  for (const t of ["replacement", "return", "cleared", "weight_miss"] as const) {
    assert.ok(!UNAVAILABLE.has(t), `${t} does NOT mean a fighter is out — a replacement is someone who IS available`);
  }
});

test("every status type has a label, so none can render as a raw enum", () => {
  for (const t of ["injury", "illness", "withdrawal", "replacement", "suspension", "visa_travel", "weight_miss", "return", "cleared", "other"] as const) {
    assert.ok(STATUS_LABEL[t] && STATUS_LABEL[t] !== t, `${t} needs a human label`);
  }
});
