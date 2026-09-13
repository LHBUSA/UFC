/* Round-for-Round handoff. Run: npm run test:round-rollover
 *
 * The failure this pins (2026-09-13): Noche UFC finished on Saturday with 13
 * stored results and 0 round rows, and on Sunday the deck already showed the
 * following Saturday's card, because it selected "the soonest card whose
 * broadcast window has not finished". The rules under test:
 *   - the live card owns the deck;
 *   - otherwise the most recent FOUGHT card (stored results) does, until a later
 *     card is fought or goes live;
 *   - the next card is carried separately and never becomes the focus;
 *   - results and round coverage are independent counts, and the public line
 *     never claims round data that is not stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRoundForRound, cardCoverage, coverageLine, LATEST_COMPLETED_RETENTION_DAYS } from "./roundRollover.ts";

const NOCHE = {
  ufc_slug: "noche-ufc-2026", event_id: "noche", event_name: "Noche UFC: Silva vs Delgado", event_date: "2026-09-12",
  early_prelims_start_utc: null, prelims_start_utc: "2026-09-12T18:00:00Z", main_card_start_utc: "2026-09-12T21:00:00Z",
};
const U331 = {
  ufc_slug: "ufc-331", event_id: "u331", event_name: "UFC 331: Van vs. Pantoja 2", event_date: "2026-09-19",
  early_prelims_start_utc: null, prelims_start_utc: "2026-09-19T22:00:00Z", main_card_start_utc: "2026-09-20T01:00:00Z",
};
const ev = (id: string, event_date: string, bouts: number, results: number, name = id) => ({ id, name, event_date, card_status: results >= bouts && bouts > 0 ? "complete" : "announced", bouts, results });
const at = (iso: string) => Date.parse(iso);

test("after a card ends, it stays the focus and next week's card is carried separately", () => {
  const events = [ev("noche", "2026-09-12", 13, 13), ev("u331", "2026-09-19", 12, 0)];
  /* the moment the production bug happened: Sunday evening, window long closed */
  const s = selectRoundForRound({ broadcasts: [NOCHE, U331], events, now: at("2026-09-13T23:20:00Z") });
  assert.equal(s.focus, "latest_completed");
  assert.equal(s.latestCompleted?.event?.id, "noche");
  assert.equal(s.live, null);
  assert.equal(s.next?.broadcast?.event_id, "u331");
  assert.notEqual(s.focus, "next" as never, "the next card is never the focus");
  /* still true mid-week, well past any "Sunday midnight" */
  const wed = selectRoundForRound({ broadcasts: [NOCHE, U331], events, now: at("2026-09-16T12:00:00Z") });
  assert.equal(wed.latestCompleted?.event?.id, "noche");
  assert.equal(wed.focus, "latest_completed");
});

test("the next card takes over when its broadcast window opens, and the previous card steps back", () => {
  const events = [ev("noche", "2026-09-12", 13, 13), ev("u331", "2026-09-19", 12, 0)];
  const s = selectRoundForRound({ broadcasts: [NOCHE, U331], events, now: at("2026-09-19T22:30:00Z") });
  assert.equal(s.focus, "live");
  assert.equal(s.live?.broadcast?.event_id, "u331");
  assert.equal(s.latestCompleted?.event?.id, "noche", "still known, no longer the focus");
  assert.equal(s.next, null, "a live card is not also the next card");
  /* once UFC 331 has results and its window closes, it is the latest completed card */
  const after = selectRoundForRound({ broadcasts: [NOCHE, U331], events: [ev("noche", "2026-09-12", 13, 13), ev("u331", "2026-09-19", 12, 12)], now: at("2026-09-20T09:00:00Z") });
  assert.equal(after.focus, "latest_completed");
  assert.equal(after.latestCompleted?.event?.id, "u331");
});

test("a card is 'fought' only from stored results, never from the clock alone", () => {
  /* window closed, but no result stored (postponed, or results not ingested): not the latest completed card */
  const s = selectRoundForRound({ broadcasts: [NOCHE, U331], events: [ev("noche", "2026-09-12", 13, 0), ev("u331", "2026-09-19", 12, 0)], now: at("2026-09-13T23:20:00Z") });
  assert.equal(s.latestCompleted, null);
  assert.equal(s.focus, null, "with nothing live or fought there is no fight-night deck");
  assert.equal(s.next?.broadcast?.event_id, "u331", "the next card is still offered on its own");
  /* an earlier fought card in the retention window keeps the deck */
  const prior = selectRoundForRound({ broadcasts: [NOCHE, U331], events: [ev("hooker", "2026-09-05", 12, 12), ev("noche", "2026-09-12", 13, 0), ev("u331", "2026-09-19", 12, 0)], now: at("2026-09-13T23:20:00Z") });
  assert.equal(prior.latestCompleted?.event?.id, "hooker");
});

test("retention stops a stale card owning the deck, and a card with no broadcast row can still be the latest", () => {
  const old = selectRoundForRound({ broadcasts: [], events: [ev("old", "2026-08-30", 12, 12)], now: at("2026-09-13T12:00:00Z") });
  assert.ok(LATEST_COMPLETED_RETENTION_DAYS < 14);
  assert.equal(old.focus, null);
  const dwcs = selectRoundForRound({ broadcasts: [], events: [ev("dwcs", "2026-09-08", 5, 5, "Dana White's Contender Series: Season 10, Week 5")], now: at("2026-09-09T12:00:00Z") });
  assert.equal(dwcs.latestCompleted?.event?.id, "dwcs");
  assert.equal(dwcs.latestCompleted?.broadcast, null);
});

test("the same card is never both live and latest completed (no duplicate cards)", () => {
  const events = [ev("noche", "2026-09-12", 13, 6)];
  const s = selectRoundForRound({ broadcasts: [NOCHE, U331], events, now: at("2026-09-12T22:00:00Z") });
  assert.equal(s.live?.broadcast?.event_id, "noche");
  assert.notEqual(s.latestCompleted?.event?.id, "noche");
});

test("results and round coverage are independent: 13 results, 0 round rows", () => {
  const c = cardCoverage(13, Array.from({ length: 13 }, () => ({ hasResult: true, roundReady: false, noRoundDetail: false })));
  assert.deepEqual(c, { cardSize: 13, results: 13, roundReady: 0, noRoundDetail: 0, roundPending: 13, phase: "rounds_pending" });
  const line = coverageLine(c);
  assert.equal(line, "13 results recorded · round data pending");
  assert.doesNotMatch(line, /archiv|verified|complete/i, "no claim of round data that is not stored");
});

test("as round rows arrive coverage increases; no-detail answers are counted apart and never as round data", () => {
  const facts = (ready: number, noDetail = 0) => Array.from({ length: 13 }, (_, i) => ({ hasResult: true, roundReady: i < ready, noRoundDetail: i >= ready && i < ready + noDetail }));
  const part = cardCoverage(13, facts(5));
  assert.equal(coverageLine(part), "13 results recorded · 5 with round data · 8 pending");
  assert.equal(part.phase, "rounds_pending");
  const done = cardCoverage(13, facts(12, 1));
  assert.deepEqual([done.roundReady, done.noRoundDetail, done.roundPending, done.phase], [12, 1, 0, "rounds_complete"]);
  assert.equal(coverageLine(done), "13 results recorded · 12 with round data · 1 without published round detail");
  const midCard = cardCoverage(13, Array.from({ length: 4 }, () => ({ hasResult: true, roundReady: false, noRoundDetail: false })));
  assert.equal(midCard.phase, "results_arriving");
});
