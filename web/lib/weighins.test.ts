/* Weigh-in display rules. Run: node --test web/lib/weighins.test.ts
 *
 * The rule under test throughout: never show a blank where something matters,
 * and never show 0 for absence. A fighter who has not weighed in has not
 * weighed 0 lb, and an empty cell reads as broken UI rather than as any of the
 * several genuinely different reasons a number might be missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  weightCell, limitCell, deltaCell, classCell, sortForTable, isLive,
  freshness, updateLine, timelineKind, clockTime, RESULT_LABEL, RESULT_TONE,
  type WeighIn, type WeighInSummary,
} from "./weighins-display.ts";

const row = (over: Partial<WeighIn> = {}): WeighIn => ({
  id: "w1", event_id: "e1", event_name: "UFC 331", event_date: "2026-09-19",
  bout_id: "b1", fighter_id: "f1", fighter_name: "Jane Doe",
  fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
  weight_class: "LIGHTWEIGHT", weight_class_raw: "Lightweight Bout",
  is_womens: false, is_title: false, card_position: "main", bout_order: 13, bout_status: "confirmed",
  contracted_limit_lbs: 155, allowance_lbs: 1, limit_basis: "division_rule", applicable_limit_lbs: 156,
  official_weight_lbs: 155.5, attempt_number: 1, result: "made", over_by_lbs: null, catchweight_lbs: null,
  weighed_at: "2026-09-18T09:12:00Z",
  source_url: "https://www.ufc.com/event/ufc-331", source_name: "UFC.com", source_kind: "official",
  source_published_at: "2026-09-18T09:14:00Z", detected_at: "2026-09-18T09:15:00Z",
  first_seen_at: "2026-09-18T09:15:00Z", last_seen_at: "2026-09-18T09:45:00Z",
  raw_text: "Jane Doe (155.5)", supersedes_id: null, is_correction: false,
  ...over,
});

/* ================= never a blank, never a zero ================= */

test("a fighter who has not weighed in shows a sentence, not 0 and not a dash", () => {
  const cell = weightCell(row({ result: "pending", official_weight_lbs: null }));
  assert.equal(cell.text, "Not yet weighed");
  assert.equal(cell.known, false);
  assert.ok(!/^0/.test(cell.text), "0 lb is a reading; absence is not");
  assert.notEqual(cell.text.trim(), "—");
  assert.notEqual(cell.text.trim(), "");
});

test("each reason a weight is missing gets its own words", () => {
  assert.equal(weightCell(row({ result: "pending", official_weight_lbs: null })).text, "Not yet weighed");
  assert.equal(weightCell(row({ result: "withdrawn", official_weight_lbs: null })).text, "Withdrew before the scale");
  assert.equal(weightCell(row({ result: "cancelled", official_weight_lbs: null })).text, "Bout cancelled");
  assert.equal(weightCell(row({ result: "missed", official_weight_lbs: null })).text, "Weight not published");
  /* Four different states of knowledge; a shared blank would collapse them. */
  const texts = new Set([
    weightCell(row({ result: "pending", official_weight_lbs: null })).text,
    weightCell(row({ result: "withdrawn", official_weight_lbs: null })).text,
    weightCell(row({ result: "cancelled", official_weight_lbs: null })).text,
    weightCell(row({ result: "missed", official_weight_lbs: null })).text,
  ]);
  assert.equal(texts.size, 4);
});

test("an unsupported limit says the figure is not published, never a division default", () => {
  const cell = limitCell(row({ applicable_limit_lbs: null, contracted_limit_lbs: null, allowance_lbs: null, limit_basis: "unsupported", weight_class: "CATCHWEIGHT" }));
  assert.equal(cell.known, false);
  assert.equal(cell.text, "Limit not published");
  assert.match(cell.note!, /agreed figure has not been published/);
  assert.ok(!/\d/.test(cell.text), "no number may appear in a cell whose number is unknown");
});

test("a supported limit explains where it came from", () => {
  assert.match(limitCell(row()).note!, /non-title allowance/);
  assert.match(limitCell(row({ is_title: true, allowance_lbs: 0, applicable_limit_lbs: 155 })).note!, /championship limit/);
  assert.match(limitCell(row({ limit_basis: "sourced", allowance_lbs: 0, applicable_limit_lbs: 165 })).note!, /as published/);
});

test("the delta is never computed by the page", () => {
  /* Doing the arithmetic here would let a page produce a figure the database
   * refused to store. */
  const noDelta = deltaCell(row({ result: "missed", official_weight_lbs: 158.5, over_by_lbs: null, applicable_limit_lbs: null }));
  assert.equal(noDelta.text, "Amount over not published");
  assert.ok(!/\d/.test(noDelta.text));
});

test("a real delta renders with its sign and unit", () => {
  assert.equal(deltaCell(row({ result: "missed", over_by_lbs: 2.5 })).text, "+2.5 lb over");
  assert.equal(deltaCell(row({ result: "made", official_weight_lbs: 155.5, applicable_limit_lbs: 156 })).text, "0.5 lb under");
  assert.equal(deltaCell(row({ result: "made", official_weight_lbs: 156, applicable_limit_lbs: 156 })).text, "on the limit");
});

/* ================= presentation ================= */

test("every result has a label and a tone, and the miss is the loud one", () => {
  for (const r of ["pending", "made", "missed", "cancelled", "withdrawn"] as const) {
    assert.ok(RESULT_LABEL[r] && RESULT_LABEL[r] !== r);
    assert.ok(RESULT_TONE[r]);
  }
  assert.equal(RESULT_TONE.missed, "alert");
  assert.equal(RESULT_TONE.withdrawn, "alert");
  assert.equal(RESULT_TONE.made, "ok");
  assert.equal(RESULT_TONE.pending, "neutral");
});

test("a catchweight is named explicitly, never left as a bare class", () => {
  assert.equal(classCell(row({ catchweight_lbs: 165 })), "Catchweight 165.0 lb");
  assert.equal(classCell(row({ weight_class: "CATCHWEIGHT", catchweight_lbs: null })), "Catchweight");
  assert.equal(classCell(row({ weight_class: null })), "Weight class not on file");
  assert.equal(classCell(row({ weight_class: "BANTAMWEIGHT", is_womens: true, is_title: true })), "Women's Bantamweight title");
});

test("confirmation and correction are different timeline kinds", () => {
  /* UFC.com verifying the wire's number is a confirmation, never a correction
   * (Noche UFC 2026-09-12: 26 confirmations, 0 corrections). */
  assert.equal(timelineKind(row({ is_correction: false, is_confirmation: true, supersedes_id: "p" })), "OFFICIAL CONFIRMATION");
  assert.equal(timelineKind(row({ is_correction: true, is_confirmation: false, supersedes_id: "p" })), "OFFICIAL CORRECTION");
  assert.equal(timelineKind(row({ is_correction: true, source_kind: "commission", supersedes_id: "p" })), "COMMISSION CORRECTION");
  assert.equal(timelineKind(row({ is_correction: false, is_confirmation: false })), "WEIGHED IN");
});

test("a correction is visible in the timeline kind", () => {
  assert.equal(timelineKind(row({ is_correction: true })), "OFFICIAL CORRECTION");
  assert.equal(timelineKind(row({ attempt_number: 2, result: "made" })), "SECOND ATTEMPT");
  assert.equal(timelineKind(row({ result: "missed" })), "MISSED WEIGHT");
  assert.equal(timelineKind(row({ result: "withdrawn" })), "WITHDRAWAL");
  assert.equal(timelineKind(row({ catchweight_lbs: 165 })), "CATCHWEIGHT AGREED");
  assert.equal(timelineKind(row({ result: "pending" })), "AWAITING SCALE");
});

test("the update line matches the collector's, field for field", () => {
  assert.equal(updateLine(row({ result: "missed", official_weight_lbs: 158.5, over_by_lbs: 2.5 })),
    "Jane Doe — 158.5 lb — MISSED by 2.5 lb");
  assert.equal(updateLine(row({ result: "missed", official_weight_lbs: 158.5, over_by_lbs: null })),
    "Jane Doe — 158.5 lb — MISSED (limit not published)");
  assert.equal(updateLine(row({ result: "missed", official_weight_lbs: null, over_by_lbs: null })),
    "Jane Doe — MISSED WEIGHT (weight not published)");
});

/* ================= ordering and freshness ================= */

test("the table is card order, main event first, with a stable tiebreak", () => {
  const rows = [
    row({ id: "a", bout_order: 1, fighter_name: "Zed" }),
    row({ id: "b", bout_order: 13, fighter_name: "Ann" }),
    row({ id: "c", bout_order: 13, fighter_name: "Bob" }),
  ];
  const sorted = sortForTable(rows);
  assert.deepEqual(sorted.map((r) => r.id), ["b", "c", "a"]);
  /* Stability matters on a page that re-renders every fifteen seconds. */
  assert.deepEqual(sortForTable(sorted).map((r) => r.id), ["b", "c", "a"]);
});

test("rows with no bout order still sort deterministically", () => {
  const rows = [row({ id: "x", bout_order: null, fighter_name: "B" }), row({ id: "y", bout_order: null, fighter_name: "A" })];
  const a = sortForTable(rows).map((r) => r.id);
  const b = sortForTable([...rows].reverse()).map((r) => r.id);
  assert.deepEqual(a, b, "the same set must not reorder between polls");
});

test("freshness is measured from the source, and reads in words", () => {
  const now = Date.parse("2026-09-18T10:00:00Z");
  assert.equal(freshness("2026-09-18T09:59:40Z", now), "seconds ago");
  assert.equal(freshness("2026-09-18T09:59:00Z", now), "1 minute ago");
  assert.equal(freshness("2026-09-18T09:45:00Z", now), "15 minutes ago");
  assert.equal(freshness("2026-09-18T08:00:00Z", now), "2 hours ago");
  assert.equal(freshness(null, now), "no source update yet", "and absence is a sentence, not a blank");
});

test("live means something can still change", () => {
  const s = (over: Partial<WeighInSummary>): WeighInSummary => ({
    event_id: "e1", event_name: "UFC 331", event_date: "2026-09-19",
    expected: 26, weighed: 20, made: 19, missed: 1, pending: 6, withdrawn: 0, cancelled: 0,
    catchweights: 0, corrections: 0, limit_unsupported: 0,
    last_source_update: null, newest_source_published_at: null, first_seen_at: null, ...over,
  });
  assert.equal(isLive(s({ pending: 6 })), true);
  assert.equal(isLive(s({ pending: 0 })), false, "a finished card is final, not live");
  assert.equal(isLive(null), false);
});

test("a reading's timestamp is the real instant, never a placeholder noon", () => {
  /* lib/format.fmtDate truncates to a date and pins 12:00Z — correct for an
   * event date, and silently wrong here: every reading on the desk rendered
   * "12:00 PM" whatever time the fighter actually weighed in. A fabricated
   * timestamp on a live page is worse than none, because it looks like data. */
  assert.equal(clockTime("2026-09-18T09:12:00Z"), "09:12 UTC");
  assert.equal(clockTime("2026-09-18T23:45:30Z"), "23:45 UTC");
  assert.notEqual(clockTime("2026-09-18T09:12:00Z"), "12:00 PM");
});

test("an absent or unparseable timestamp is null, so the page can say so", () => {
  assert.equal(clockTime(null), null);
  assert.equal(clockTime(undefined), null);
  assert.equal(clockTime("not a time"), null, "a bad value must not render as a plausible clock");
});
