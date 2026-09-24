/* Card truth, replacement class. Run: npm run test:card-truth
 *
 * UFC Vegas 121, 2026-09-24: newsroom reported "Luis Hernandez replaces Mickey Gall against Sedriques Dumas" while
 * the event page, Fight Week and the simulator still listed Gall vs Dumas. The rule was right and the evidence was
 * stale (the card had not been re-read since 06:00Z; fixed in ufc-stats-ingest v0.9.3, fight-week card watch).
 *
 * These tests pin the replacement lifecycle on ONE function, markCardTruth, which lib/db applyCardTruth wraps for
 * every consumer (getEventBouts). Each surface then applies its own one-line filter; this file holds those filters
 * to the same answer and checks, at source level, that the surfaces still read bouts through getEventBouts. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markCardTruth, type CardObservation, type CardStatusEvent, type MarkableBout } from "./cardTruth.ts";
import { isSimulatableBout } from "./simulatorView.ts";

const EVENT = { eventId: "ev-vegas121", eventName: "UFC Fight Night: Rosas Jr. vs. Barcelos" };
const GALL = { id: "f-gall" }, DUMAS = { id: "f-dumas" }, HERNANDEZ = { id: "f-hernandez" };
type B = MarkableBout & { fighter_a: { id: string }; fighter_b: { id: string }; result: null };
const bout = (id: string, comp: string, a: { id: string }, b: { id: string }, order: number): B =>
  ({ id, espn_competition_id: comp, status: "announced", card_position: "prelim", bout_order: order, weight_class: "WELTERWEIGHT", fighter_a: a, fighter_b: b, result: null });
const MAIN = bout("b-main", "401923400", { id: "f-rosas" }, { id: "f-barcelos" }, 12);
const GALL_DUMAS = bout("b-gall-dumas", "401923433", GALL, DUMAS, 3);
const DUMAS_HERNANDEZ = bout("b-dumas-hernandez", "401923999", DUMAS, HERNANDEZ, 3);
const obs = (competitions: string[], at: string, complete = true): CardObservation => ({ observed_at: at, source: "espn", complete, placeholder_ids: [], competition_ids: competitions });
const report = (over: Partial<CardStatusEvent> = {}): CardStatusEvent => ({
  id: "s-1", fighter_id: GALL.id, fighter_name: "Mickey Gall", status_type: "withdrawal", state: "active", event_id: EVENT.eventId, bout_id: GALL_DUMAS.id,
  replacement_fighter_name: "Luis Hernandez", source_url: "https://example.invalid/report", source_name: "Outlet", source_kind: "news", source_published_at: null,
  confidence: 0.9, occurred_at: "2026-09-24T19:36:00Z", ...over,
});

/* The consumers, as they are written today (one line each). */
const eventPage = <T extends { status: string }>(bouts: T[]) => bouts.filter((b) => b.status !== "cancelled");
const fightWeek = <T extends { status: string }>(bouts: T[]) => bouts.filter((b) => b.status !== "cancelled");
const simulator = <T extends Parameters<typeof isSimulatableBout>[0]>(bouts: T[]) => bouts.filter(isSimulatableBout);
const ids = (xs: Array<{ id?: string }>) => xs.map((x) => x.id).sort();
const surfaces = (bouts: ReturnType<typeof markCardTruth<B>>) => ({ event: ids(eventPage(bouts)), week: ids(fightWeek(bouts)), sim: ids(simulator(bouts)) });

test("1. the original bout: on the official card, on every surface", () => {
  const out = markCardTruth([MAIN, GALL_DUMAS], [obs([MAIN.espn_competition_id!, GALL_DUMAS.espn_competition_id!], "2026-09-24T06:01:47Z")], [], EVENT);
  const s = surfaces(out);
  assert.deepEqual(s.event, ["b-gall-dumas", "b-main"]);
  assert.deepEqual(s.week, s.event); assert.deepEqual(s.sim, s.event);
});

test("2. a sourced withdrawal / replacement report arrives while the official card is unchanged: still active everywhere, with a warning", () => {
  const out = markCardTruth([MAIN, GALL_DUMAS], [obs([MAIN.espn_competition_id!, GALL_DUMAS.espn_competition_id!], "2026-09-24T22:05:00Z")], [report()], EVENT);
  const gd = out.find((b) => b.id === GALL_DUMAS.id)!;
  assert.equal(gd.status, "announced", "a report is not a removal");
  assert.equal(gd.card_change?.confirmed, false);
  const s = surfaces(out);
  assert.deepEqual(s.sim, ["b-gall-dumas", "b-main"]);
  assert.deepEqual(s.event, s.sim); assert.deepEqual(s.week, s.sim);
});

test("3-5. the official card drops the bout: it leaves the event page, Fight Week and the simulator together; the Gall record is kept", () => {
  const observations = [obs([MAIN.espn_competition_id!], "2026-09-24T23:24:58Z"), obs([MAIN.espn_competition_id!, GALL_DUMAS.espn_competition_id!], "2026-09-24T06:01:47Z")];
  const out = markCardTruth([MAIN, GALL_DUMAS], observations, [report()], EVENT);
  const gd = out.find((b) => b.id === GALL_DUMAS.id)!;
  assert.ok(gd, "the bout is never deleted");
  assert.equal(gd.status, "cancelled");
  assert.equal(gd.stored_status, "announced", "the stored row is untouched");
  assert.equal(gd.card_change?.confirmed, true);
  assert.deepEqual(gd.card_change?.basis, ["card_observation", "withdrawal"]);
  assert.equal(gd.card_change?.off_card_since, "2026-09-24T23:24:58Z");
  assert.equal(gd.card_change?.replacement_fighter_name, "Luis Hernandez", "the sourced story keeps provenance");
  const s = surfaces(out);
  assert.deepEqual(s.event, ["b-main"]); assert.deepEqual(s.week, ["b-main"]); assert.deepEqual(s.sim, ["b-main"]);
});

test("6. the replacement bout is active only once the official card lists it; then the simulator sees only the replacement", () => {
  /* Replacement reported but not yet on the card: the new bout is not in ufc_bouts, so no surface can show it. */
  const before = markCardTruth([MAIN, GALL_DUMAS], [obs([MAIN.espn_competition_id!], "2026-09-24T23:24:58Z")], [report()], EVENT);
  assert.ok(!surfaces(before).sim.includes("b-dumas-hernandez"));
  /* ESPN lists Dumas vs Hernandez: the ingest writes the bout, the observation lists its competition. */
  const after = markCardTruth([MAIN, GALL_DUMAS, DUMAS_HERNANDEZ], [obs([MAIN.espn_competition_id!, DUMAS_HERNANDEZ.espn_competition_id!], "2026-09-25T00:05:00Z")], [report()], EVENT);
  const s = surfaces(after);
  assert.deepEqual(s.sim, ["b-dumas-hernandez", "b-main"]);
  assert.deepEqual(s.event, s.sim); assert.deepEqual(s.week, s.sim);
  assert.equal(after.find((b) => b.id === GALL_DUMAS.id)!.status, "cancelled");
  assert.deepEqual(after.find((b) => b.id === GALL_DUMAS.id)!.card_change?.still_on_card, [DUMAS.id], "Dumas stays on the card in the replacement bout");
});

test("confirmed removal without a known replacement: removed everywhere, no replacement invented", () => {
  const out = markCardTruth([MAIN, GALL_DUMAS], [obs([MAIN.espn_competition_id!], "2026-09-24T23:24:58Z")], [], EVENT);
  const gd = out.find((b) => b.id === GALL_DUMAS.id)!;
  assert.equal(gd.status, "cancelled");
  assert.equal(gd.card_change?.replacement_fighter_name, null);
  assert.equal(gd.card_change?.reasonWords, null, "no reason is guessed");
  assert.deepEqual(surfaces(out).sim, ["b-main"]);
});

test("fighter rebooked against a different opponent: the old pairing is off, the new pairing is on, Dumas appears once", () => {
  const out = markCardTruth([MAIN, GALL_DUMAS, DUMAS_HERNANDEZ], [obs([MAIN.espn_competition_id!, DUMAS_HERNANDEZ.espn_competition_id!], "2026-09-25T00:05:00Z")], [], EVENT);
  const active = simulator(out) as B[];
  assert.equal(active.filter((b) => [b.fighter_a.id, b.fighter_b.id].includes(DUMAS.id)).length, 1);
});

test("duplicate reports: one bout, one change entry, receipts counted", () => {
  const out = markCardTruth([MAIN, GALL_DUMAS], [obs([MAIN.espn_competition_id!], "2026-09-24T23:24:58Z")], [report(), report({ id: "s-2", source_url: "https://example.invalid/2", occurred_at: "2026-09-24T22:00:00Z" })], EVENT);
  assert.equal(out.filter((b) => b.id === GALL_DUMAS.id).length, 1);
  assert.equal(out.find((b) => b.id === GALL_DUMAS.id)!.card_change?.receipts, 2);
});

test("stale observation after newer truth: only the NEWEST complete observation decides; an older one listing the bout cannot bring it back", () => {
  const newestFirst = [obs([MAIN.espn_competition_id!], "2026-09-24T23:24:58Z"), obs([MAIN.espn_competition_id!, GALL_DUMAS.espn_competition_id!], "2026-09-24T06:01:47Z")];
  assert.equal(markCardTruth([MAIN, GALL_DUMAS], newestFirst, [], EVENT).find((b) => b.id === GALL_DUMAS.id)!.status, "cancelled");
  /* An incomplete newest read is ambiguous and removes nobody. */
  const incomplete = [obs([MAIN.espn_competition_id!], "2026-09-25T01:00:00Z", false), ...newestFirst];
  assert.equal(markCardTruth([MAIN, GALL_DUMAS], incomplete, [], EVENT).find((b) => b.id === GALL_DUMAS.id)!.status, "announced");
});

test("every surface reads its card through getEventBouts (card truth applied once, in lib/db), never raw ufc_bouts", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  assert.match(src("./db.ts"), /return markCardTruth\(bouts, observations, statusEvents, \{ eventId, eventName: named \}\);/);
  assert.match(src("./db.ts"), /return applyCardTruth\(eventId, rows\.map\(flattenResult\), revalidate\);/);
  for (const [rel, filter] of [["../app/events/[slug]/page.tsx", /bouts\.filter\(\(b\) => b\.status !== "cancelled"\)/], ["./fightweek.ts", /bouts\.filter\(\(b\) => b\.status !== "cancelled"\)/], ["./simulator.ts", /isSimulatableBout\(b\)/]] as const) {
    const s = src(rel);
    assert.match(s, /getEventBouts\(/, `${rel} reads bouts through getEventBouts`);
    assert.match(s, filter, `${rel} filters on the effective status`);
    assert.doesNotMatch(s, /rest\/v1\/ufc_bouts\?|`ufc_bouts\?/, `${rel} does not read raw ufc_bouts`);
  }
  /* /algo's upcoming cards read the SQL twin of the same rule. */
  assert.match(src("./algo.ts"), /ufc_bouts_effective\?select=\$\{BOUT_SELECT\}&is_active=is\.true/);
});
