import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  APPROVED_SCHEDULES, APPROVED_SOURCE, PARAMOUNT_UFC_URL,
  mergeApprovedSchedules, resolveEventSchedule, resolveScheduleFields, scheduleSourceLabel,
} from "./eventSchedule.ts";
import { startLines, localTime, linkableBroadcasts, watchState, isFinished, type EventBroadcast } from "./broadcast-display.ts";

const ET = "America/New_York";
const ROSAS = { id: "1f2531bd-70d4-494f-84c0-9587f9496796", name: "UFC Fight Night: Rosas Jr. vs. Barcelos", event_date: "2026-09-26", venue: "Meta APEX", city: "Las Vegas", region: "NV", country: "USA" };
const UNKNOWN = { id: "00000000-0000-0000-0000-000000000000", name: "UFC Fight Night: Nobody vs. Anybody", event_date: "2026-10-10", venue: null, city: null, region: null, country: null };

function storedRow(over: Partial<EventBroadcast> = {}): EventBroadcast {
  return {
    ufc_slug: "ufc-fight-night-september-26-2026", event_id: ROSAS.id, match_status: "matched",
    event_name: "UFC Fight Night: Rosas Jr. vs. Barcelos", event_headline: null, event_date: "2026-09-26",
    venue: "Meta APEX", city: "Las Vegas", region: "NV", country: "USA", location_raw: "Las Vegas, NV",
    early_prelims_start_utc: null, prelims_start_utc: "2026-09-26T21:00:00Z", main_card_start_utc: "2026-09-27T00:00:00Z",
    broadcasts: [{ provider: "Paramount+", region: "US", type: "streaming", watch_url: "https://www.paramountplus.com/shows/ufc/", segments: ["prelims", "main_card"] }],
    ufc_event_url: "https://www.ufc.com/event/ufc-fight-night-september-26-2026", tickets_url: null,
    source: "ufc.com", source_url: "https://www.ufc.com/events", parser: "ufc-events-listing-v1",
    verified_at: "2026-09-26T15:00:00Z", last_changed_at: "2026-09-26T15:00:00Z",
    ...over,
  };
}
const clock = (lines: ReturnType<typeof startLines>) => lines.map((l) => `${l.label} ${localTime(l.utc, ET)}`);

test("1. a verified stored row renders both segment times", () => {
  const b = resolveEventSchedule(ROSAS, storedRow())!;
  assert.deepEqual(clock(startLines(b)), ["Prelims 5:00 PM", "Main Card 8:00 PM"]);
  assert.equal(b.source, "ufc.com", "a fully stored row keeps its UFC.com source");
  assert.equal(scheduleSourceLabel(b), "UFC.com");
});

test("2. the stored row beats the approved entry field by field", () => {
  /* Stored main card moved to 9 PM ET and no prelims time, no carriers:
   * main card from stored, prelims + carrier filled from the approved entry. */
  const b = resolveEventSchedule(ROSAS, storedRow({ prelims_start_utc: null, main_card_start_utc: "2026-09-27T01:00:00Z", broadcasts: [] }))!;
  assert.deepEqual(clock(startLines(b)), ["Prelims 5:00 PM", "Main Card 9:00 PM"]);
  assert.equal(b.broadcasts[0].provider, "Paramount+");
  assert.equal(b.source, APPROVED_SOURCE, "a row with any approved value never claims UFC.com");
  assert.equal(b.ufc_slug, "ufc-fight-night-september-26-2026", "row identity stays the stored row's");
  /* And a stored carrier list wins whole over the approved one. */
  const cbs = resolveEventSchedule(ROSAS, storedRow({ broadcasts: [{ provider: "CBS", region: "US", type: "tv", watch_url: "https://example.test/cbs", segments: ["main_card"] }] }))!;
  assert.deepEqual(cbs.broadcasts.map((x) => x.provider), ["CBS"]);
});

test("3. the approved fallback renders when the stored row is absent", () => {
  const b = resolveEventSchedule(ROSAS, null);
  assert.ok(b, "a missing stored row must not remove the schedule");
  assert.equal(b!.event_id, ROSAS.id);
  assert.equal(b!.event_name, ROSAS.name);
  assert.equal(b!.source, APPROVED_SOURCE);
  assert.equal(scheduleSourceLabel(b!), "Confirmed schedule");
  assert.equal(watchState(b!, Date.parse("2026-09-26T12:00:00Z"), ET), "today");
});

test("4. Rosas fallback is 5:00 PM ET prelims / 8:00 PM ET main card", () => {
  const b = resolveEventSchedule(ROSAS, null)!;
  assert.equal(b.prelims_start_utc, "2026-09-26T21:00:00Z");
  assert.equal(b.main_card_start_utc, "2026-09-27T00:00:00Z");
  assert.deepEqual(clock(startLines(b)), ["Prelims 5:00 PM", "Main Card 8:00 PM"]);
});

test("5. the Paramount+ watch CTA is linkable to the official UFC hub", () => {
  const b = resolveEventSchedule(ROSAS, null)!;
  const cta = linkableBroadcasts(b);
  assert.equal(cta.length, 1);
  assert.equal(cta[0].provider, "Paramount+");
  assert.equal(cta[0].watch_url, PARAMOUNT_UFC_URL);
  assert.deepEqual(cta[0].segments, ["prelims", "main_card"]);
  assert.match(b.ufc_event_url, /^https:\/\/www\.ufc\.com\/event\//);
});

test("6. no Early Prelims row is invented", () => {
  assert.equal(APPROVED_SCHEDULES[ROSAS.id].early_prelims_start_utc, undefined);
  for (const b of [resolveEventSchedule(ROSAS, null)!, resolveEventSchedule(ROSAS, storedRow())!]) {
    assert.equal(b.early_prelims_start_utc, null);
    assert.ok(!startLines(b).some((l) => l.key === "early_prelims"));
  }
});

test("7. an unknown card with no data stays honest: nothing resolved, nothing invented", () => {
  assert.equal(resolveEventSchedule(UNKNOWN, null), null);
  assert.equal(resolveScheduleFields(UNKNOWN.id, null), null);
  /* A stored row for another event passes through untouched — the approved
   * entry is keyed by id, never by name or date. */
  const other = storedRow({ event_id: UNKNOWN.id, ufc_slug: "other", event_date: "2026-09-26", prelims_start_utc: null, broadcasts: [] });
  assert.deepEqual(resolveEventSchedule(UNKNOWN, other), other);
  /* Same date, same words in the name, different id: inherits nothing. */
  const lookalike = { ...ROSAS, id: "11111111-1111-1111-1111-111111111111" };
  assert.equal(resolveEventSchedule(lookalike, null), null);
});

test("list merge: approved event added once, linked or single-unlinked stored row merged, never duplicated", () => {
  const finished = storedRow({ ufc_slug: "ufc-331", event_id: "221ca353-f623-4b66-98aa-3a504a418236", event_date: "2026-09-19", prelims_start_utc: "2026-09-19T23:00:00Z", main_card_start_utc: "2026-09-20T01:00:00Z" });
  const fromEmpty = mergeApprovedSchedules([finished], [ROSAS]);
  assert.deepEqual(fromEmpty.map((r) => r.event_id), [finished.event_id, ROSAS.id]);
  const now = Date.parse("2026-09-26T18:00:00Z");
  assert.equal(fromEmpty.find((r) => !isFinished(r, now))?.event_id, ROSAS.id, "next-event and the homepage pick Rosas");

  const linked = mergeApprovedSchedules([storedRow()], [ROSAS]);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].source, "ufc.com");

  const unlinked = mergeApprovedSchedules([storedRow({ event_id: null, match_status: "unmatched", broadcasts: [] })], [ROSAS]);
  assert.equal(unlinked.length, 1, "a freshly written unlinked row is not shown next to the fallback");
  assert.equal(unlinked[0].broadcasts[0].provider, "Paramount+");
});

/* 8. The homepage, the event page, Fight Week and the APIs share ONE path:
 * every page reads a schedule through lib/broadcast.ts, and every reader in
 * lib/broadcast.ts returns resolved rows. Source-level guards, because the
 * failure this prevents is a new surface quietly reading the table directly. */
const WEB = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");

test("8. homepage and event page resolve the schedule identically", () => {
  for (const page of ["app/page.tsx", "app/events/[slug]/page.tsx", "lib/fightweek.ts"]) {
    const s = src(page);
    assert.match(s, /import \{[^}]*\bgetBroadcastForEvent\b[^}]*\} from "@\/lib\/broadcast"/, `${page} reads the resolved schedule`);
  }
  const lib = src("lib/broadcast.ts");
  assert.match(lib, /export async function getBroadcastForEvent\([^)]*\)[^{]*\{\s*return resolveEventSchedule\(/);
  assert.equal((lib.match(/mergeApprovedSchedules\(/g) || []).length, 2, "both list readers merge approved schedules");
  assert.match(src("lib/currentEvent.ts"), /getNextBroadcast/, "homepage's next event and /api/ufc/next-event pick through the same list");
  assert.match(src("app/api/ufc/next-event/route.ts"), /getNextBroadcast/);
  assert.match(src("lib/fightWeekSnapshot.ts"), /resolveScheduleFields/);
  assert.doesNotMatch(src("lib/fightWeekSnapshot.ts"), /_start_utc:\s*"/, "Fight Week carries no times of its own");
});

test("8b. nothing outside lib/broadcast.ts queries ufc_event_broadcasts", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
        const rel = p.slice(WEB.length + 1).replace(/\\/g, "/");
        if (rel !== "lib/broadcast.ts" && /ufc_event_broadcasts\?/.test(readFileSync(p, "utf8"))) offenders.push(rel);
      }
    }
  };
  for (const d of ["app", "components", "lib"]) walk(join(WEB, d));
  assert.deepEqual(offenders, []);
});
