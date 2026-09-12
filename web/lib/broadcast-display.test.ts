/* Timezone conversion, daylight saving, the state machine and the countdown.
 *
 * The canonical instant under test is UFC 331's main card:
 *   2026-09-20T01:00:00Z  = Sat 19 Sep,  9:00 PM EDT
 *                         = Sat 19 Sep,  8:00 PM CDT
 *                         = Sat 19 Sep,  7:00 PM MDT
 *                         = Sat 19 Sep,  6:00 PM PDT
 * and the Noche UFC main card, 2026-09-12T21:00:00Z = 5:00 PM EDT / 4:00 PM CDT
 * — the exact "a Central Time visitor sees 4 PM" case from the brief.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localTime, zoneLabel, localDay, dayKey, sameDay, countdown, watchState,
  startLines, firstStartMs, mainCardMs, isFinished, isStale, verifiedAgo,
  linkableBroadcasts, providerList, segmentSummary,
  type Broadcast,
} from "./broadcast-display.ts";

const NOCHE_MAIN = "2026-09-12T21:00:00.000Z";
const NOCHE_PRELIMS = "2026-09-12T18:00:00.000Z";
const U331_MAIN = "2026-09-20T01:00:00.000Z";

const ZONES = {
  ny: "America/New_York",
  chi: "America/Chicago",
  den: "America/Denver",
  la: "America/Los_Angeles",
};

test("the brief's own example: a 5 PM ET main card renders as 4 PM for a Central visitor", () => {
  assert.equal(localTime(NOCHE_MAIN, ZONES.ny), "5:00 PM");
  assert.equal(localTime(NOCHE_MAIN, ZONES.chi), "4:00 PM");
  assert.equal(localTime(NOCHE_PRELIMS, ZONES.ny), "2:00 PM");
  assert.equal(localTime(NOCHE_PRELIMS, ZONES.chi), "1:00 PM");
});

test("one canonical UTC instant renders correctly in all four US zones", () => {
  assert.equal(localTime(U331_MAIN, ZONES.ny), "9:00 PM");
  assert.equal(localTime(U331_MAIN, ZONES.chi), "8:00 PM");
  assert.equal(localTime(U331_MAIN, ZONES.den), "7:00 PM");
  assert.equal(localTime(U331_MAIN, ZONES.la), "6:00 PM");
});

test("the zone label matches the zone, and moves with daylight saving", () => {
  assert.equal(zoneLabel(U331_MAIN, ZONES.ny), "EDT");
  assert.equal(zoneLabel(U331_MAIN, ZONES.chi), "CDT");
  assert.equal(zoneLabel(U331_MAIN, ZONES.la), "PDT");
  /* Same zones, a January card: standard time. */
  assert.equal(zoneLabel("2027-01-16T01:00:00.000Z", ZONES.ny), "EST");
  assert.equal(zoneLabel("2027-01-16T01:00:00.000Z", ZONES.chi), "CST");
});

test("Arizona proves the conversion is not offset arithmetic", () => {
  /* Phoenix does not observe DST. In September it is on MST (-7) and so shows
   * the same clock time as Los Angeles on PDT — while Denver, on MDT, is an
   * hour ahead of both. Any "-1 hour from Mountain" rule gets this wrong. */
  assert.equal(localTime(U331_MAIN, "America/Phoenix"), "6:00 PM");
  assert.equal(localTime(U331_MAIN, ZONES.la), "6:00 PM");
  assert.equal(localTime(U331_MAIN, ZONES.den), "7:00 PM");
  /* In January the same three zones separate differently. */
  const jan = "2027-01-16T01:00:00.000Z";
  assert.equal(localTime(jan, "America/Phoenix"), "6:00 PM");
  assert.equal(localTime(jan, ZONES.la), "5:00 PM");
  assert.equal(localTime(jan, ZONES.den), "6:00 PM");
});

test("a card on a daylight-saving transition day converts correctly on both sides", () => {
  /* US DST ended 2026-11-01 at 06:00 UTC (2 AM EDT -> 1 AM EST).
   * 01:00 UTC on Nov 1 is 9:00 PM EDT on Oct 31.
   * 07:00 UTC on Nov 1 is 2:00 AM EST on Nov 1. */
  assert.equal(localTime("2026-11-01T01:00:00.000Z", ZONES.ny), "9:00 PM");
  assert.equal(zoneLabel("2026-11-01T01:00:00.000Z", ZONES.ny), "EDT");
  assert.equal(localTime("2026-11-01T07:00:00.000Z", ZONES.ny), "2:00 AM");
  assert.equal(zoneLabel("2026-11-01T07:00:00.000Z", ZONES.ny), "EST");
});

test("an event on a DST-transition night keeps the right calendar day per zone", () => {
  const inst = Date.parse("2026-11-01T01:00:00.000Z");
  assert.equal(dayKey(inst, ZONES.ny), "2026-10-31", "still Saturday night in New York");
  assert.equal(dayKey(inst, "Europe/London"), "2026-11-01", "already Sunday in London");
});

test("Europe and Asia get real local times, not an American fallback", () => {
  /* UFC 331 main card, 01:00 UTC: 2:00 AM in London (BST, +1) on the Sunday,
   * and 10:00 AM in Tokyo. */
  assert.equal(localTime(U331_MAIN, "Europe/London"), "2:00 AM");
  assert.equal(localTime(U331_MAIN, "Asia/Tokyo"), "10:00 AM");
  assert.equal(localDay(U331_MAIN, "Asia/Tokyo"), "Sunday, September 20");
  assert.equal(localDay(U331_MAIN, ZONES.ny), "Saturday, September 19");
});

test("an invalid zone degrades to the runtime default instead of throwing", () => {
  assert.doesNotThrow(() => localTime(U331_MAIN, "Not/AZone"));
  assert.ok(localTime(U331_MAIN, "Not/AZone").length > 0);
  assert.equal(zoneLabel(U331_MAIN, "Not/AZone"), "");
});

test("an unparseable instant renders as empty, never as NaN or 1970", () => {
  assert.equal(localTime("garbage", ZONES.ny), "");
  assert.equal(localDay("garbage", ZONES.ny), "");
  assert.equal(zoneLabel("garbage", ZONES.ny), "");
});

/* ------------------------------------------------------- segments & states */

const noche = {
  early_prelims_start_utc: null,
  prelims_start_utc: NOCHE_PRELIMS,
  main_card_start_utc: NOCHE_MAIN,
};
const u331 = {
  early_prelims_start_utc: "2026-09-19T21:00:00.000Z",
  prelims_start_utc: "2026-09-19T23:00:00.000Z",
  main_card_start_utc: U331_MAIN,
};

test("only published segments appear, and a missing one is omitted not zeroed", () => {
  assert.deepEqual(startLines(noche).map((l) => l.key), ["prelims", "main_card"]);
  assert.deepEqual(startLines(u331).map((l) => l.key), ["early_prelims", "prelims", "main_card"]);
  assert.deepEqual(startLines({ early_prelims_start_utc: null, prelims_start_utc: null, main_card_start_utc: null }), []);
});

test("state 1: an upcoming card with complete information", () => {
  assert.equal(watchState(noche, Date.parse("2026-09-10T12:00:00Z"), ZONES.chi), "upcoming");
});

test("state 2: event today, in the VIEWER's day, not Eastern's", () => {
  const at = Date.parse("2026-09-12T15:00:00Z"); // 10 AM Central, prelims at 1 PM Central
  assert.equal(watchState(noche, at, ZONES.chi), "today");

  /* The same card at an instant that falls on DIFFERENT calendar days for two
   * viewers: 02:00 UTC is still Friday night in New York but already Saturday
   * morning in London. "Today" has to follow the viewer. */
  const lateFriday = Date.parse("2026-09-12T02:00:00Z");
  assert.equal(watchState(noche, lateFriday, ZONES.ny), "upcoming", "still Friday in New York");
  assert.equal(watchState(noche, lateFriday, "Europe/London"), "today", "already Saturday in London");
});

test("state 3: live from the first published segment through the card", () => {
  assert.equal(watchState(noche, Date.parse("2026-09-12T18:00:00Z"), ZONES.chi), "live", "prelims bell");
  assert.equal(watchState(noche, Date.parse("2026-09-12T22:30:00Z"), ZONES.chi), "live", "mid main card");
  assert.equal(watchState(noche, Date.parse("2026-09-13T01:30:00Z"), ZONES.chi), "live", "inside the tail");
});

test("state 4: finished once the broadcast window has passed", () => {
  assert.equal(watchState(noche, Date.parse("2026-09-13T04:00:00Z"), ZONES.chi), "finished");
  assert.equal(isFinished(noche, Date.parse("2026-09-13T04:00:00Z")), true);
  assert.equal(isFinished(noche, Date.parse("2026-09-12T23:00:00Z")), false);
});

test("state 6: time not yet announced is its own state, not a broken upcoming one", () => {
  const tba = { early_prelims_start_utc: null, prelims_start_utc: null, main_card_start_utc: null };
  assert.equal(watchState(tba, Date.now(), ZONES.chi), "time_tba");
  assert.equal(firstStartMs(tba), null);
  assert.equal(mainCardMs(tba), null);
  assert.equal(isFinished(tba, Date.now()), false, "a card with no time has not finished");
});

test("a card with only a main card time still has a usable state and countdown", () => {
  const partial = { early_prelims_start_utc: null, prelims_start_utc: null, main_card_start_utc: NOCHE_MAIN };
  assert.equal(watchState(partial, Date.parse("2026-09-10T00:00:00Z"), ZONES.chi), "upcoming");
  assert.equal(firstStartMs(partial), Date.parse(NOCHE_MAIN));
});

/* ------------------------------------------------------------- broadcasters */

const paramount: Broadcast = { provider: "Paramount+", region: "US", type: "streaming", watch_url: "https://ufc.ac/4v2K4zW", segments: ["prelims", "main_card"] };
const cbs: Broadcast = { provider: "CBS", region: "US", type: "tv", watch_url: "https://www.cbs.com/live-tv/stream/tveverywhere/", segments: ["main_card"] };
const fightPass: Broadcast = { provider: "UFC Fight Pass", region: "US", type: "streaming", watch_url: "https://www.ufcfightpass.com/", segments: ["early_prelims"] };
const noUrl: Broadcast = { provider: "Mystery Network", region: null, type: null, watch_url: null, segments: [] };

test("state 5: broadcaster unknown yields no carriers and no CTA", () => {
  assert.deepEqual(linkableBroadcasts({ broadcasts: [] }), []);
  assert.equal(providerList([]), "");
});

test("state 7: multiple broadcasters read as a sentence, in order", () => {
  assert.equal(providerList([paramount]), "Paramount+");
  assert.equal(providerList([paramount, cbs]), "Paramount+ and CBS");
  assert.equal(providerList([paramount, fightPass, cbs]), "Paramount+, UFC Fight Pass and CBS");
});

test("a carrier with no official destination is named but never linked", () => {
  const linkable = linkableBroadcasts({ broadcasts: [paramount, noUrl] });
  assert.equal(linkable.length, 1);
  assert.equal(linkable[0].provider, "Paramount+");
  assert.equal(providerList([paramount, noUrl]), "Paramount+ and Mystery Network",
    "we still say who carries it — we just do not manufacture a link");
});

test("segment summaries describe coverage without inventing it", () => {
  assert.equal(segmentSummary(cbs), "Main Card");
  assert.equal(segmentSummary(paramount), "Prelims · Main Card");
  assert.equal(segmentSummary({ ...paramount, segments: ["early_prelims", "prelims", "main_card"] }), "Full card");
  assert.equal(segmentSummary(noUrl), "");
});

/* ----------------------------------------------------------- freshness/count */

test("the countdown is computed from the instant, in the shape the brief asked for", () => {
  const t = Date.parse(NOCHE_MAIN);
  assert.equal(countdown(t, t - (5 * 3600e3 + 12 * 60e3)), "5h 12m");
  assert.equal(countdown(t, t - 42 * 60e3), "42m");
  assert.equal(countdown(t, t - (2 * 86400e3 + 3 * 3600e3)), "2d 3h");
  assert.equal(countdown(t, t), "Live now");
  assert.equal(countdown(t, t + 60e3), "Live now");
});

test("states 8 and 9: last-good data stays usable and stale verification is visible", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  assert.equal(verifiedAgo("2026-09-12T11:42:00Z", now), "18 min ago");
  assert.equal(verifiedAgo("2026-09-12T09:00:00Z", now), "3 hours ago");
  assert.equal(verifiedAgo("2026-09-10T12:00:00Z", now), "2 days ago");
  assert.equal(verifiedAgo(null, now), "never verified");

  assert.equal(isStale("2026-09-12T11:42:00Z", now), false);
  assert.equal(isStale("2026-09-10T12:00:00Z", now), true, "two days without a successful verification is stale");
  assert.equal(isStale(null, now), true);
  assert.equal(isStale("garbage", now), true);
});

test("sameDay never uses date arithmetic", () => {
  /* 22:30 and 23:30 UTC are both Sep 12 in New York (18:30 and 19:30 EDT) but
   * straddle midnight in London (23:30 Sep 12 and 00:30 Sep 13 BST). One pair
   * of instants, two different answers, decided by the zone alone. */
  const a = Date.parse("2026-09-12T22:30:00Z");
  const b = Date.parse("2026-09-12T23:30:00Z");
  assert.equal(sameDay(a, b, ZONES.ny), true, "both are Sep 12 in New York");
  assert.equal(sameDay(a, b, "Europe/London"), false, "they straddle midnight in London");
});
