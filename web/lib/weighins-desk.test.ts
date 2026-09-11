/* The weigh-in desk: which card, what "expected" means, when to poll.
 * Run: node --experimental-strip-types --test web/lib/weighins-desk.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deskWindow, bookedCoverage, shouldPoll, pickDesk, supersessionLabel } from "./weighins-display.ts";

const AT = (iso: string) => Date.parse(iso);
const NOCHE = { id: "noche", name: "Noche UFC: Silva vs. Delgado", event_date: "2026-09-12" };
const LAST = { event_id: "ufc330", event_name: "UFC 330", event_date: "2026-09-05" };

test("weigh-in morning: the upcoming card is the desk even with zero readings", () => {
  const d = pickDesk([NOCHE], [LAST], AT("2026-09-11T16:00:00Z"));
  assert.equal(d?.eventId, "noche");
  assert.equal(d?.state, "upcoming");
});

test("before the window the covered archive card stays on the desk", () => {
  const d = pickDesk([NOCHE], [LAST], AT("2026-09-08T12:00:00Z"));
  assert.equal(d?.eventId, "ufc330");
  assert.equal(d?.state, "recent");
});

test("the window opens 40h before and the session closes 2h before the date's midnight", () => {
  assert.equal(deskWindow("2026-09-12", AT("2026-09-10T07:59:00Z")).open, false);
  assert.equal(deskWindow("2026-09-12", AT("2026-09-10T08:01:00Z")).sessionLive, true);
  const after = deskWindow("2026-09-12", AT("2026-09-11T22:30:00Z"));
  assert.equal(after.open, true, "fight night keeps the desk");
  assert.equal(after.sessionLive, false);
  assert.equal(deskWindow("2026-09-12", AT("2026-09-13T13:00:00Z")).open, false, "closes 36h after");
});

const BOOKED = Array.from({ length: 26 }, (_, i) => `f${i}`);

test("zero readings on a 26-fighter card is 0 of 26, all pending, and it polls", () => {
  const c = bookedCoverage(BOOKED, []);
  assert.equal(c.expected, 26);
  assert.equal(c.sourced, 0);
  assert.equal(c.pendingIds.length, 26);
  assert.equal(shouldPoll(deskWindow("2026-09-12", AT("2026-09-11T16:00:00Z")), c), true);
});

test("all sourced and the session over: polling stops", () => {
  const rows = BOOKED.map((id) => ({ fighter_id: id, result: "made" as const }));
  const c = bookedCoverage(BOOKED, rows);
  assert.equal(c.pendingIds.length, 0);
  assert.equal(shouldPoll(deskWindow("2026-09-12", AT("2026-09-11T16:00:00Z")), c), true, "session still live: a correction can land");
  assert.equal(shouldPoll(deskWindow("2026-09-12", AT("2026-09-11T23:00:00Z")), c), false);
});

test("a pending fighter after the session keeps the desk polling", () => {
  const rows = BOOKED.slice(1).map((id) => ({ fighter_id: id, result: "made" as const }));
  assert.equal(shouldPoll(deskWindow("2026-09-12", AT("2026-09-11T23:00:00Z")), bookedCoverage(BOOKED, rows)), true);
});

test("a same-weight official supersession is a confirmation, a different weight is a correction", () => {
  assert.equal(supersessionLabel(145, 145, "official"), "Confirmed · official");
  assert.equal(supersessionLabel(145, 145.5, "official"), "Corrected");
  assert.equal(supersessionLabel(145, undefined, "official"), null);
});
