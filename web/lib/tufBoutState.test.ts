/**
 *   node --experimental-strip-types --test lib/tufBoutState.test.ts
 *
 * Result and classification are two axes. These tests hold them apart, and
 * hold TUF 34 to the shape repair batch 1 was approved to produce.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classState, commissionWeights, displayDate, formatLbs, recapWinners, resultState, summarizeBouts, summaryPhrases } from "./tufBoutState.ts";

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

/* ---- commission weights ------------------------------------------------------ */

test("a commission record with two weights shows both, named by the bout's fighters", () => {
  const w = commissionWeights([{ printed: "LODUNE KI SINCAID", weight_lbs: 202.5 }, { printed: "BOBBY M. SOUTHWORTH", weight_lbs: 206 }], ["Bobby Southworth", "Lodune Sincaid"]);
  assert.deepEqual(w, [
    { name: "Bobby Southworth", lbs: "206", matched: true },
    { name: "Lodune Sincaid", lbs: "202.5", matched: true },
  ], "corner order in the record does not decide who weighed what");
});

test("recorded precision is kept: no rounding, no trailing .0, no invented values", () => {
  assert.equal(formatLbs(202.5), "202.5");
  assert.equal(formatLbs(184.25), "184.25");
  assert.equal(formatLbs(206), "206");
  assert.equal(formatLbs(171.0), "171");
  for (const bad of [0, -1, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "206"]) assert.equal(formatLbs(bad), null, String(bad));
});

test("one recorded weight shows only that weight; none shows no row", () => {
  assert.deepEqual(commissionWeights([{ printed: "MIKE SWICK", weight_lbs: 192 }, { printed: "STEPHAN P. BONNAR", weight_lbs: null }], ["Stephan Bonnar", "Mike Swick"]),
    [{ name: "Mike Swick", lbs: "192", matched: true }]);
  assert.deepEqual(commissionWeights([{ printed: "MIKE SWICK" }, { printed: "STEPHAN P. BONNAR", weight_lbs: 0 }], ["Stephan Bonnar", "Mike Swick"]), []);
});

test("a corner that is not confidently one fighter keeps the printed name, so a weight is never cross-assigned", () => {
  /* misspelled surname: shown as printed, while the other corner still reconciles */
  assert.deepEqual(commissionWeights([{ printed: "JOSHUA R BURKMAN", weight_lbs: 171 }, { printed: "MELVIN PAUL GULLIARD", weight_lbs: 168.5 }], ["Josh Burkman", "Melvin Guillard"]), [
    { name: "Josh Burkman", lbs: "171", matched: true },
    { name: "Melvin Paul Gulliard", lbs: "168.5", matched: false },
  ]);
  /* a printed name that fits both fighters */
  const both = commissionWeights([{ printed: "J. SMITH", weight_lbs: 170 }, { printed: "JANE SMITH", weight_lbs: 135 }], ["John Smith", "Jane Smith"]);
  assert.ok(both.every((x) => !(x.name === "John Smith" && x.lbs === "135")), "never gives one fighter the other's weight");
  assert.equal(both.find((x) => x.lbs === "170")!.matched, false, "the ambiguous corner stays printed");
  /* two corners claiming the same fighter */
  const dup = commissionWeights([{ printed: "DIEGO J. SANCHEZ", weight_lbs: 183 }, { printed: "DIEGO SANCHEZ", weight_lbs: 185 }], ["Diego Sanchez", "Alex Karalexis"]);
  assert.ok(dup.every((x) => !x.matched), "a contested fighter is assigned to neither corner");
});

type Ledger = { records: Array<{ id: string; document_id: string; corners: Array<{ printed: string; weight_lbs?: number }> }> };
const ledger = json("../data/tuf/commission_records.json") as Ledger;
const houseWithRecords = (slug: string) => bouts(json(`../data/tuf/seasons/${slug}.json`)).filter((b) => (b as { commission_record_id?: string }).commission_record_id)
  .map((b) => ({ b, rec: ledger.records.find((r) => r.id === (b as { commission_record_id?: string }).commission_record_id)! }));

test("TUF 1 shows 20/20 official commission weights, each on the right fighter", () => {
  const rows = houseWithRecords("tuf-1");
  assert.equal(rows.length, 10);
  let shown = 0;
  for (const { b, rec } of rows) {
    const w = commissionWeights(rec.corners, [b.a, b.b]);
    assert.equal(w.length, 2, `${b.a} vs ${b.b}`);
    assert.ok(w.every((x) => x.matched), `${b.a} vs ${b.b}: both corners reconcile`);
    assert.deepEqual(w.map((x) => x.name), [b.a, b.b]);
    for (const x of w) {
      const surname = x.name.split(" ").pop()!.toUpperCase();
      const corner = rec.corners.find((c) => c.printed.split(/\s+/).includes(surname))!;
      assert.equal(x.lbs, String(corner.weight_lbs), `${x.name}: the weight printed beside that name`);
    }
    shown += w.length;
  }
  assert.equal(shown, 20);
  const sw = rows.find(({ b }) => b.b === "Lodune Sincaid")!;
  assert.deepEqual(commissionWeights(sw.rec.corners, [sw.b.a, sw.b.b]).map((x) => `${x.name} ${x.lbs} lb`), ["Bobby Southworth 206 lb", "Lodune Sincaid 202.5 lb"]);
});

test("TUF 2 shows its 24 stored commission weights, the misspelled corner under its printed name", () => {
  const rows = houseWithRecords("tuf-2");
  assert.equal(rows.length, 12);
  const all = rows.flatMap(({ b, rec }) => commissionWeights(rec.corners, [b.a, b.b]));
  assert.equal(all.length, 24);
  assert.deepEqual(all.filter((x) => !x.matched).map((x) => `${x.name} ${x.lbs}`), ["Melvin Paul Gulliard 168.5"]);
  assert.equal(all.filter((x) => x.matched).length, 23);
});
