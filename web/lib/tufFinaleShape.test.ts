import test from "node:test";
import assert from "node:assert/strict";
import { finalsOnOtherCards, shapeBout, shapeFinale, type FinaleBoutRow } from "./tufFinaleShape.ts";

const F = (id: string, name: string) => ({ id, name, espn_athlete_id: null, ufcstats_id: `u${id}` });
const griffinBonnar: FinaleBoutRow = {
  id: "b1", bout_order: 8, weight_class_raw: "Light Heavyweight",
  fighter_a: F("g", "Forrest Griffin"), fighter_b: F("b", "Stephan Bonnar"),
  result: { winner_id: "g", method_raw: "Decision - Unanimous", round: 3, time_sec: 300 },
};

test("judges' cards come from the scorecard rows, read for the winner", () => {
  const cards = [
    { bout_id: "b1", card_index: 2, judge_name: "Tony Weeks", fighter_a_id: "b", fighter_a_score: 28, fighter_b_score: 29 },
    { bout_id: "b1", card_index: 1, judge_name: "Jeff Mullen", fighter_a_id: "g", fighter_a_score: 29, fighter_b_score: 28 },
    { bout_id: "other", card_index: 1, judge_name: "Nobody", fighter_a_id: "x", fighter_a_score: 30, fighter_b_score: 27 },
  ];
  const b = shapeBout(griffinBonnar, cards, [{ bout_id: "b1", round: 1 }, { bout_id: "b1", round: 1 }, { bout_id: "b1", round: 2 }, { bout_id: "b1", round: 3 }]);
  assert.deepEqual(b.scorecards, [{ judge: "Jeff Mullen", score: "29-28" }, { judge: "Tony Weeks", score: "29-28" }]);
  assert.equal(b.rounds_recorded, 3);
  assert.equal(b.time, "5:00");
  assert.equal(b.winner?.name, "Forrest Griffin");
});

test("no scorecard rows means no scorecards, whatever a season file once said", () => {
  assert.deepEqual(shapeBout(griffinBonnar, [], []).scorecards, []);
});

test("finals, castmate bouts, debuts and the coaches' fight are separated", () => {
  const cast = new Set(["g", "b", "h", "s"]);
  const hogerSouthworth: FinaleBoutRow = { id: "b2", bout_order: 6, weight_class_raw: "Light Heavyweight", fighter_a: F("h", "Sam Hoger"), fighter_b: F("s", "Bobby Southworth"), result: { winner_id: "h", method_raw: "Decision - Unanimous", round: 3, time_sec: 300 } };
  const main: FinaleBoutRow = { id: "b3", bout_order: 9, weight_class_raw: "Light Heavyweight", fighter_a: F("rf", "Rich Franklin"), fighter_b: F("ks", "Ken Shamrock"), result: { winner_id: "rf", method_raw: "KO/TKO", round: 1, time_sec: 162 } };
  const coach: FinaleBoutRow = { id: "c1", bout_order: 1, weight_class_raw: "Light Heavyweight", fighter_a: F("cl", "Chuck Liddell"), fighter_b: F("rc", "Randy Couture"), result: { winner_id: "cl", method_raw: "KO/TKO", round: 1, time_sec: 126 } };
  const r = shapeFinale({
    event: { id: "e", name: "Finale", event_date: "2005-04-09" },
    bouts: [griffinBonnar, hogerSouthworth, main], scorecards: [], rounds: [],
    finals: [{ weight_class: "Light Heavyweight", ufc_bout_id: "b1" }],
    contestantIds: cast,
    firstBoutDate: new Map([["g", "2005-04-09"], ["b", "2005-04-09"], ["h", "2005-04-09"], ["s", "2001-03-25"]]),
    coachFight: { row: coach, event: { name: "UFC 52", event_date: "2005-04-16" } },
  });
  assert.deepEqual(r.finals.map((f) => f.id), ["b1"]);
  assert.deepEqual(r.castBouts.map((b) => b.id), ["b2"]);
  assert.deepEqual(r.otherBouts.map((b) => b.id), ["b3"]);
  assert.deepEqual(r.debuts, { contestants: 4, debuted_here: 3 });
  assert.equal(r.coachFight?.winner?.name, "Chuck Liddell");
});

test("a final is listed separately only when it was decided on a different card from the linked finale", async () => {
  const { readFileSync } = await import("node:fs");
  const inv = JSON.parse(readFileSync(new URL("../data/tuf/seasons.json", import.meta.url), "utf8"));
  const rows: Array<{ slug: string; finale_date?: string; final_bouts?: Array<{ weight_class?: string; status?: string; date?: string }> }> = Array.isArray(inv) ? inv : inv.seasons;
  const extra = Object.fromEntries(rows.filter((r) => r.finale_date).map((r) => [r.slug, finalsOnOtherCards(r.final_bouts, r.finale_date!).map((f) => f.weight_class)]).filter(([, v]) => (v as unknown[]).length));
  // Single-division seasons (TUF 6's final carries no bracket weight class) must not repeat the linked final.
  assert.deepEqual(extra, { "tuf-33": ["Welterweight"], "tuf-china-1": ["Featherweight"] });
  assert.deepEqual(finalsOnOtherCards([{ date: "2025-09-13", status: "scheduled" }, { date: undefined }], "2025-08-16"), []);
  assert.deepEqual(finalsOnOtherCards(undefined, "2025-08-16"), []);
});
