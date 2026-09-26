import assert from "node:assert/strict";
import test from "node:test";
import { eventSnapshot, resolveSchedule, watchForNote, clockLabel, PARAMOUNT_UFC_URL } from "./fightWeekSnapshot.ts";

const ROSAS = { id: "1f2531bd-70d4-494f-84c0-9587f9496796", event_date: "2026-09-26", venue: "Meta APEX", city: "Las Vegas", region: "NV", country: "USA" };
const OTHER = { id: "00000000-0000-0000-0000-000000000000", event_date: "2026-10-03", venue: "Some Arena", city: "Las Vegas", region: "NV", country: "USA" };

test("the Rosas card with no stored row reads exactly as briefed", () => {
  const { rows, watch } = eventSnapshot({ event: ROSAS, stored: null, bouts: 11, updated: "2026-09-20T09:15:00Z", done: false });
  assert.deepEqual(rows, [
    { label: "Date", value: "Sat, Sep 26" },
    { label: "Venue", value: "Meta APEX · Las Vegas, NV" },
    { label: "Local Time", value: "5:00 PM PT" },
    { label: "Prelims", value: "5:00 PM ET" },
    { label: "Main Card", value: "8:00 PM ET" },
    { label: "Broadcast", value: "Paramount+" },
    { label: "Watch", value: "Stream live on Paramount+" },
    { label: "Card", value: "11 announced bouts" },
    { label: "Updated", value: "Sep 20 · 09:15 UTC" },
  ]);
  assert.deepEqual(watch, { label: "Watch on Paramount+", href: PARAMOUNT_UFC_URL, external: true });
});

test("a stored broadcast row wins over the owner-supplied schedule", () => {
  const stored = { main_card_start_utc: "2026-09-27T01:00:00Z", broadcasts: [{ provider: "Paramount+", region: "US", type: "streaming" as const, watch_url: "https://www.paramountplus.com/shows/ufc/", segments: ["main_card" as const] }] };
  assert.equal(resolveSchedule(ROSAS.id, stored)?.main_card_start_utc, "2026-09-27T01:00:00Z");
  const { rows, watch } = eventSnapshot({ event: ROSAS, stored, bouts: 11, updated: null, done: false });
  assert.equal(rows.find((r) => r.label === "Main Card")?.value, "9:00 PM ET");
  assert.equal(watch?.href, PARAMOUNT_UFC_URL, "every Paramount+ reader lands on the one UFC hub");
});

test("an event with no schedule anywhere shows no invented rows", () => {
  const { rows, watch } = eventSnapshot({ event: OTHER, stored: null, bouts: 1, updated: null, done: false });
  assert.deepEqual(rows.map((r) => r.label), ["Date", "Venue", "Card"]);
  assert.equal(rows[2].value, "1 announced bout");
  assert.equal(watch, null);
  assert.equal(watchForNote(OTHER.id), null);
});

test("a finished card keeps its times and drops the live-stream line", () => {
  const { rows, watch } = eventSnapshot({ event: ROSAS, stored: null, bouts: 11, updated: null, done: true });
  assert.ok(!rows.some((r) => r.label === "Watch"));
  assert.ok(rows.some((r) => r.label === "Main Card"));
  assert.equal(watch, null);
});

test("an unknown venue city gets no Local Time row; a non-Paramount carrier keeps its own link", () => {
  const stored = { main_card_start_utc: "2026-10-04T02:00:00Z", broadcasts: [{ provider: "CBS", region: "US", type: "tv" as const, watch_url: "https://example.test/cbs", segments: ["main_card" as const] }] };
  const { rows, watch } = eventSnapshot({ event: { ...OTHER, city: "Atlantis" }, stored, bouts: 12, updated: null, done: false });
  assert.ok(!rows.some((r) => r.label === "Local Time"));
  assert.equal(rows.find((r) => r.label === "Watch")?.value, "Watch live on CBS");
  assert.equal(watch?.href, "https://example.test/cbs");
});

test("clock labels: US zones read PT/ET in summer and winter, others keep Intl's label", () => {
  assert.equal(clockLabel("2026-09-27T00:00:00Z", "America/Los_Angeles"), "5:00 PM PT");
  assert.equal(clockLabel("2026-12-13T03:00:00Z", "America/New_York"), "10:00 PM ET");
  assert.match(clockLabel("2026-09-27T00:00:00Z", "Europe/London"), /^1:00 AM /);
});

test("the Rosas desk note is keyed to that event only", () => {
  assert.match(watchForNote(ROSAS.id) || "", /^The clearest edge is Raul’s grappling pressure/);
});
