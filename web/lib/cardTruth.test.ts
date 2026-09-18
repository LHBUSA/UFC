/* Card truth: removed bouts tell the story instead of silently disappearing. Run: npm run test:card-truth
 *
 * UFC 331, 2026-09-18: Moicano vs Ortega had been off the card for three days. ufc_bouts still said
 * `announced` (by design, migration 029), the ESPN card observation no longer listed it, four outlets
 * had reported Ortega's withdrawal - and the weigh-in desk read "26 expected", with both men pending. */
import test from "node:test";
import assert from "node:assert/strict";
import { cardTruth, splitCard, expectedFighterIds, type CardBout, type CardObservation, type CardStatusEvent } from "./cardTruth.ts";
import { bookedCoverage, shouldPoll } from "./weighins-display.ts";
// @ts-expect-error -- plain JS shared with the ufc-algo Worker
import { cardTruth as algoCardTruth } from "../../workers/ufc-algo/src/cardTruth.js";

const EVENT = { eventId: "ev-331", eventName: "UFC 331: Van vs. Pantoja 2" };
const REMOVED = "b-10";
/* Thirteen announced bouts. b-10 is Moicano (f-10a) vs Ortega (f-10b). */
const card = (over: Partial<Record<string, Partial<CardBout>>> = {}): CardBout[] =>
  Array.from({ length: 13 }, (_, i) => {
    const n = i + 1;
    return { id: `b-${n}`, espn_competition_id: `4019${n}`, status: "announced", fighter_a_id: `f-${n}a`, fighter_b_id: `f-${n}b`, card_position: n >= 8 ? "main" : "prelim", bout_order: n, weight_class: "LIGHTWEIGHT", has_result: false, ...(over[`b-${n}`] || {}) };
  });
const obs = (missing: string[], at = "2026-09-18T06:03:14Z", complete = true): CardObservation =>
  ({ observed_at: at, source: "espn", complete, placeholder_ids: [], competition_ids: card().map((b) => b.espn_competition_id!).filter((id) => !missing.includes(id)) });
let seq = 0;
const evt = (over: Partial<CardStatusEvent> = {}): CardStatusEvent => {
  seq += 1;
  return { id: `s${seq}`, fighter_id: "f-10b", fighter_name: "Brian Ortega", status_type: "withdrawal", state: "active", event_id: "ev-331", bout_id: REMOVED, replacement_fighter_name: null, source_url: `https://example.invalid/${seq}`, source_name: `Outlet ${seq}`, source_kind: "news", source_published_at: null, confidence: 0.85, occurred_at: "2026-09-15T01:00:00Z", ...over };
};
const readings = (ids: string[]) => ids.map((fighter_id) => ({ fighter_id, result: "made" as const }));

test("13-bout card, one bout removed: 12 active bouts, 24 expected, and the historical bout is still there", () => {
  const bouts = card();
  const { active, changes } = splitCard(bouts, [obs(["401910"])], [evt(), evt({ status_type: "injury", bout_id: null })], EVENT);
  assert.equal(bouts.length, 13, "the stored card is untouched: nothing is deleted");
  assert.equal(active.length, 12);
  assert.equal(expectedFighterIds(active).length, 24);
  assert.deepEqual(changes.map((c) => c.bout.id), [REMOVED], "and the removed bout is reported, not dropped");
  assert.equal(active.length + changes.length, 13);
  assert.equal(bouts.find((b) => b.id === REMOVED)!.status, "announced", "the input row is not mutated");
});

test("24 readings complete the desk: 24 / 24, 0 pending, polling stops; the removed fighters are never pending", () => {
  const { active } = splitCard(card(), [obs(["401910"])], [evt()], EVENT);
  const expected = expectedFighterIds(active);
  assert.ok(!expected.includes("f-10a") && !expected.includes("f-10b"), "neither corner of the removed bout is expected");
  const none = bookedCoverage(expected, []);
  assert.deepEqual([none.expected, none.pendingIds.length], [24, 24]);
  assert.ok(!none.pendingIds.includes("f-10a") && !none.pendingIds.includes("f-10b"));
  const full = bookedCoverage(expected, readings(expected));
  assert.deepEqual([full.expected, full.sourced, full.pendingIds.length], [24, 24, 0]);
  assert.equal(shouldPoll({ open: true, sessionLive: false, sessionFinished: true }, full, 0), false, "a complete desk stops polling");
  /* Before the fix: both men counted, and the desk could never complete. */
  const before = bookedCoverage(expectedFighterIds(card()), readings(expected));
  assert.deepEqual([before.expected, before.pendingIds.sort()], [26, ["f-10a", "f-10b"]]);
  assert.equal(shouldPoll({ open: true, sessionLive: false, sessionFinished: true }, before, 0), true);
});

test("a sourced reason renders; it is built only from structured events for that fighter on that card", () => {
  const events = [
    evt({ source_name: "MMA Fighting", confidence: 0.9, occurred_at: "2026-09-17T15:00:00Z" }),
    evt({ source_name: "Sherdog", occurred_at: "2026-09-15T04:20:00Z" }),
    evt({ source_name: "MMA News", occurred_at: "2026-09-14T20:16:00Z" }),
    evt({ status_type: "injury", bout_id: null, source_name: "The Mac Life" }),
    /* Another fighter's injury, and Ortega's injury on a DIFFERENT card, must never become this bout's reason. */
    evt({ status_type: "illness", fighter_id: "f-3a", fighter_name: "Someone Else", bout_id: null }),
    evt({ status_type: "suspension", event_id: "ev-999", bout_id: null }),
  ];
  const [c] = splitCard(card(), [obs(["401910"])], events, EVENT).changes;
  assert.equal(c.story, "Bout removed from UFC 331: Van vs. Pantoja 2 after Brian Ortega withdrew due to injury.");
  assert.deepEqual([c.withdrew?.fighter_name, c.reasonWords], ["Brian Ortega", "due to injury"]);
  assert.deepEqual([c.source?.name, c.receipts], ["MMA Fighting", 4], "best receipt leads; every receipt is counted");
  assert.equal(c.reported_at, "2026-09-14T20:16:00Z", "first reported = the earliest withdrawal");
  assert.deepEqual(c.basis, ["card_observation", "withdrawal"]);
  assert.deepEqual([c.bout.card_position, c.bout.bout_order], ["main", 10], "the original card position is kept");
  assert.doesNotMatch(c.story, /knee|torn|surgery|acl|undisclosed/i, "`injury` licenses the word injury and nothing else");
  /* An official receipt outranks reporting. */
  const official = splitCard(card(), [obs(["401910"])], [...events, evt({ source_kind: "official", source_name: "UFC.com", confidence: 0.7 })], EVENT).changes[0];
  assert.deepEqual([official.source?.name, official.source?.kind], ["UFC.com", "official"]);
});

test("an unknown reason is never invented", () => {
  /* Off the official card, and no report at all. */
  const bare = splitCard(card(), [obs(["401910"])], [], EVENT).changes[0];
  assert.equal(bare.story, "Bout removed from UFC 331: Van vs. Pantoja 2. A specific reason is not recorded in our verified sources.");
  assert.deepEqual([bare.withdrew, bare.reasonWords, bare.source, bare.receipts], [null, null, null, 0]);
  /* A withdrawal with no cause event: who, but not why. */
  const who = splitCard(card(), [obs(["401910"])], [evt()], EVENT).changes[0];
  assert.equal(who.story, "Bout removed from UFC 331: Van vs. Pantoja 2 after Brian Ortega withdrew. The sources do not state a reason.");
  /* Sources that disagree on the kind of cause: say less. */
  const split = splitCard(card(), [obs(["401910"])], [evt(), evt({ status_type: "injury", bout_id: null }), evt({ status_type: "illness", bout_id: null })], EVENT).changes[0];
  assert.equal(split.reasonWords, null);
  assert.match(split.story, /withdrew\. The sources do not state a reason\.$/);
  /* Withdrawals naming BOTH corners: no single "who". */
  const both = splitCard(card(), [obs(["401910"])], [evt(), evt({ fighter_id: "f-10a", fighter_name: "Renato Moicano" })], EVENT).changes[0];
  assert.equal(both.withdrew, null);
  assert.match(both.story, /A specific reason is not recorded/);
  for (const c of [bare, who, split, both]) assert.doesNotMatch(c.story, /injur|illness|visa|suspen/i);
});

test("every basis removes a bout, and an ambiguous card removes nobody", () => {
  /* canonical status */
  assert.deepEqual(splitCard(card({ "b-4": { status: "cancelled" } }), [obs([])], [], EVENT).changes.map((c) => [c.bout.id, c.basis]), [["b-4", ["status"]]]);
  assert.deepEqual(splitCard(card({ "b-4": { status: "replaced" } }), [], [], EVENT).changes.map((c) => c.bout.id), ["b-4"]);
  /* sourced withdrawal while the official card still lists the bout (news ahead of the listing) */
  assert.deepEqual(splitCard(card(), [obs([])], [evt()], EVENT).changes.map((c) => [c.bout.id, c.basis]), [[REMOVED, ["withdrawal"]]]);
  /* an event-level withdrawal (no bout_id) still finds its bout through the fighter */
  assert.deepEqual(splitCard(card(), [obs([])], [evt({ bout_id: null })], EVENT).changes.map((c) => c.bout.id), [REMOVED]);
  /* NOT removals: an injury alone, a resolved withdrawal, a withdrawal from another card, a fought bout */
  assert.equal(splitCard(card(), [obs([])], [evt({ status_type: "injury" })], EVENT).changes.length, 0);
  assert.equal(splitCard(card(), [obs([])], [evt({ state: "resolved" })], EVENT).changes.length, 0);
  assert.equal(splitCard(card(), [obs([])], [evt({ bout_id: null, event_id: "ev-999" })], EVENT).changes.length, 0);
  assert.equal(splitCard(card({ [REMOVED]: { has_result: true, status: "complete" } }), [obs(["401910"])], [evt()], EVENT).changes.length, 0, "a fought bout is history");
  /* Ambiguous card reads never make fighters vanish from a public page. */
  assert.equal(splitCard(card(), [obs(["401910"], "2026-09-18T06:03:14Z", false)], [], EVENT).changes.length, 0, "incomplete observation");
  assert.equal(splitCard(card(), [], [], EVENT).changes.length, 0, "no observation yet");
  assert.equal(splitCard(card({ [REMOVED]: { espn_competition_id: null } }), [obs([])], [], EVENT).changes.length, 0, "no source id");
  const placeholder = { ...obs(["401910"]), placeholder_ids: ["401910"] };
  assert.equal(splitCard(card(), [placeholder], [], EVENT).changes.length, 0, "placeholder");
});

test("since when, replacements, and a corner who stays on the card", () => {
  const history = [obs(["401910"], "2026-09-18T06:03:00Z"), obs(["401910"], "2026-09-17T06:02:00Z"), obs(["401910"], "2026-09-15T06:03:00Z"), obs([], "2026-09-14T06:03:00Z")];
  const c = splitCard(card(), history, [evt({ replacement_fighter_name: "Dooho Choi" })], EVENT).changes[0];
  assert.equal(c.off_card_since, "2026-09-15T06:03:00Z", "the start of the unbroken run of observations without it");
  assert.equal(c.replacement_fighter_name, "Dooho Choi");
  /* Moicano re-booked against someone else: he is expected once, through the new bout, and the old bout says so. */
  const rebooked = [...card(), { id: "b-14", espn_competition_id: "401999", status: "announced", fighter_a_id: "f-10a", fighter_b_id: "f-new", card_position: "main", bout_order: 10, weight_class: "LIGHTWEIGHT", has_result: false }];
  const o = { ...obs(["401910"]), competition_ids: [...obs(["401910"]).competition_ids!, "401999"] };
  const split = splitCard(rebooked, [o], [evt()], EVENT);
  assert.deepEqual(split.changes[0].still_on_card, ["f-10a"]);
  const expected = expectedFighterIds(split.active);
  assert.equal(expected.filter((id) => id === "f-10a").length, 1);
  assert.ok(!expected.includes("f-10b"));
  assert.equal(expected.length, 26, "12 untouched bouts + the new pairing");
});

test("the web reads card truth exactly as PBE Algo does", () => {
  const bouts = [{ espn_competition_id: "401910" }, { espn_competition_id: "4011" }, { espn_competition_id: null }];
  const cases: Array<CardObservation | null> = [null, obs(["401910"]), obs([]), obs(["401910"], "x", false), { ...obs(["401910"]), placeholder_ids: ["401910"] }];
  for (const o of cases) for (const b of bouts) {
    const mine = cardTruth(b, o), theirs = algoCardTruth(b, o);
    assert.deepEqual([mine.state, mine.blocking], [theirs.state, theirs.blocking], `${JSON.stringify(b)} / ${o?.observed_at}`);
  }
});

test("a REPORTED withdrawal is never called a removal while the official card still lists the bout", () => {
  /* UFC 333, 2026-09-18: two outlets report Arnold Allen out; ESPN still lists Allen vs Pico. */
  const reported = splitCard(card(), [obs([])], [evt(), evt({ status_type: "injury", bout_id: null })], EVENT).changes[0];
  assert.deepEqual([reported.confirmed, reported.basis], [false, ["withdrawal"]]);
  assert.equal(reported.story, "Brian Ortega is reported to have withdrawn from UFC 331: Van vs. Pantoja 2 due to injury. The official card still lists this bout.");
  assert.doesNotMatch(reported.story, /removed/i);
  assert.equal(reported.off_card_since, null);
  /* It still stops being expected, exactly as PBE Algo stops calling it. */
  assert.equal(expectedFighterIds(splitCard(card(), [obs([])], [evt()], EVENT).active).length, 24);
  /* Once the official card drops it, the same bout reads as removed. */
  const confirmed = splitCard(card(), [obs(["401910"])], [evt()], EVENT).changes[0];
  assert.equal(confirmed.confirmed, true);
  assert.match(confirmed.story, /^Bout removed from/);
  assert.equal(splitCard(card({ [REMOVED]: { status: "cancelled" } }), [obs([])], [], EVENT).changes[0].confirmed, true);
});
