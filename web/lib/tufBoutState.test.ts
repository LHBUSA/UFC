/**
 *   node --experimental-strip-types --test lib/tufBoutState.test.ts
 *
 * Result and classification are two axes. These tests hold them apart, and
 * hold TUF 34 to the shape repair batch 1 was approved to produce.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classState, displayDate, recapWinners, resultState, summarizeBouts, summaryPhrases } from "./tufBoutState.ts";

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
type B = Parameters<typeof resultState>[0] & { stage?: string; episode?: number | null; sources?: Array<{ family: string; fields: string[]; states_winner?: boolean }> };
const bouts = (d: { bracket?: Array<{ stages: Array<{ stage: string; bouts: B[] }> }> }) =>
  (d.bracket ?? []).flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ ...b, stage: st.stage }))));

const base: B = { a: "A One", b: "B Two", winner: "A One", classification: "unverified", classification_source: null };

test("a draft-only winner is reported, not verified", () => {
  assert.equal(resultState(base), "reported");
});

test("corroboration that does not state the result never verifies it", () => {
  const listing = { ...base, sources: [{ family: "paramount_plus_episode_metadata", fields: ["episode"] }] };
  assert.equal(resultState(listing), "reported", "a broadcaster naming the pairing is not a result");
});

test("an official source for the winner, an agreeing recap, or a result row verifies", () => {
  assert.equal(resultState({ ...base, sources: [{ family: "ufc_com_recap", fields: ["winner", "method"] }] }), "verified");
  const eps = { episodes: [{ bouts: [{ bracket: { a: "B Two", b: "A One" }, result: { winner: "A One" } }] }] };
  assert.equal(resultState(base, recapWinners(eps)), "verified");
  const contradicted = { episodes: [{ bouts: [{ bracket: { a: "A One", b: "B Two" }, result: { winner: "A One", contradiction: "names both" } }] }] };
  assert.equal(resultState(base, recapWinners(contradicted)), "reported", "a recap that contradicts itself verifies nothing");
  const disagrees = { episodes: [{ bouts: [{ bracket: { a: "A One", b: "B Two" }, result: { winner: "B Two" } }] }] };
  assert.equal(resultState(base, recapWinners(disagrees)), "reported");
  assert.equal(resultState({ ...base, classification: "professional", classification_source: "verified against ufc_bouts + ufc_bout_results" }), "verified");
});

test("a winner printed as neither corner is not verified", () => {
  assert.equal(resultState({ ...base, winner: "Someone Else", classification: "professional", classification_source: "verified against ufc_bout_results" }), "reported");
});

test("scheduled needs no winner; a missing winner otherwise is unknown", () => {
  assert.equal(resultState({ ...base, winner: null, result_state: "scheduled" }), "scheduled");
  assert.equal(resultState({ ...base, winner: null }), "unknown");
  assert.equal(resultState({ ...base, result_state: "scheduled" }), "reported", "a recorded winner outranks a stale scheduled flag");
});

test("classification is its own axis and needs a source", () => {
  assert.equal(classState(base), "unresolved");
  assert.equal(classState({ classification: "exhibition", classification_source: "aired in episode 3; absent from our fight records" }), "exhibition");
  assert.equal(classState({ classification: "professional", classification_source: null }), "unresolved");
});

test("dates display without a time zone shifting the day", () => {
  assert.equal(displayDate("2026-09-26"), "Sep 26, 2026");
  assert.equal(displayDate("2026-01-01"), "Jan 1, 2026");
});

/* ---- TUF 34, repair batch 1 ------------------------------------------------ */

const t34 = json("../data/tuf/seasons/tuf-34.json");
const t34Bouts = bouts(t34);

test("TUF 34 separates two scheduled professional finals from twelve reported, unclassified house bouts", () => {
  const s = summarizeBouts(t34Bouts);
  assert.deepEqual(s, {
    professional: 2, professional_scheduled: 2,
    house: 12, house_reported: 12, house_verified: 0, house_unknown: 0, house_exhibition: 0, house_unresolved: 12,
  });
  assert.deepEqual(summaryPhrases(s), ["Professional scheduled: 2", "House results reported: 12", "House classifications unresolved: 12"]);
  const states = t34Bouts.map((b) => resultState(b));
  assert.equal(states.filter((x) => x === "verified").length, 0);
  assert.equal(states.filter((x) => x === "reported").length, 12);
  assert.equal(states.filter((x) => x === "scheduled").length, 2);
  assert.equal(states.filter((x) => x === "unknown").length, 0);
});

test("the broadcaster's listing attaches episodes and verifies no house result", () => {
  const listed = t34Bouts.filter((b) => (b.sources ?? []).some((s) => s.family === "paramount_plus_episode_metadata"));
  assert.equal(listed.length, 10);
  for (const b of listed) {
    assert.ok(b.episode, `${b.a} vs ${b.b}: an attached listing carries its episode`);
    for (const s of b.sources!.filter((x) => x.family === "paramount_plus_episode_metadata")) {
      assert.ok(!s.fields.includes("winner"), "the listing never states a winner");
      assert.equal((s as { states_winner?: boolean }).states_winner, false);
    }
    assert.equal(resultState(b), "reported", `${b.a} vs ${b.b}: still reported`);
  }
});

test("a season whose every house result is verified says so plainly", () => {
  assert.deepEqual(summaryPhrases({ professional: 2, professional_scheduled: 0, house: 12, house_reported: 12, house_verified: 12, house_unknown: 0, house_exhibition: 12, house_unresolved: 0 }), ["Professional: 2", "House results verified: 12", "House exhibitions: 12"]);
  assert.deepEqual(summaryPhrases({ professional: 1, professional_scheduled: 0, house: 14, house_reported: 14, house_verified: 3, house_unknown: 0, house_exhibition: 14, house_unresolved: 0 })[1], "House results reported: 14 (3 verified)");
});
