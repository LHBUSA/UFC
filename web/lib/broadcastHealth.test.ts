import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateBroadcastHealth, canonicalNextEvent, selectWatchSurface, matchStoredRow, rowResolver, inFightWeek,
  FIGHT_WEEK_DAYS, STALE_LIMIT_MINUTES, type CanonicalEvent, type HealthInput,
} from "./broadcastHealth.ts";
import type { EventBroadcast } from "./broadcast-display.ts";

/* A generic Saturday card. Deliberately NOT a real event: the invariant must
 * hold for any card, never for one named special case. */
const NOW = Date.parse("2026-11-12T15:00:00Z"); // Thursday of fight week
const EV: CanonicalEvent = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "UFC Fight Night: Alpha vs. Bravo", event_date: "2026-11-14", card_status: "announced", bouts_total: 12, bouts_active: 12 };
const LATER: CanonicalEvent = { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "UFC 999: Charlie vs. Delta", event_date: "2026-12-12", card_status: "announced", bouts_total: 10, bouts_active: 10 };
const ALL_BINDINGS = { supabase_url: true, supabase_service_role_key: true, admin_token: true, broadcast_lock: true };

function row(over: Partial<EventBroadcast> = {}): EventBroadcast {
  return {
    ufc_slug: "ufc-fight-night-november-14-2026", event_id: EV.id, match_status: "matched",
    event_name: "UFC Fight Night: Alpha vs Bravo", event_headline: "Alpha vs Bravo", event_date: "2026-11-14",
    venue: "Meta APEX", city: "Las Vegas", region: "NV", country: "United States", location_raw: "Las Vegas, NV",
    early_prelims_start_utc: null, prelims_start_utc: "2026-11-14T21:00:00Z", main_card_start_utc: "2026-11-15T00:00:00Z",
    broadcasts: [{ provider: "Paramount+", region: "US", type: "streaming", watch_url: "https://example.test/p", segments: ["prelims", "main_card"] }],
    ufc_event_url: "https://www.ufc.com/event/ufc-fight-night-november-14-2026", tickets_url: null,
    source: "UFC.com", source_url: "https://www.ufc.com/events", parser: "ufc-events-listing-v1",
    verified_at: "2026-11-12T14:00:00Z", last_changed_at: "2026-11-10T14:00:00Z",
    ...over,
  };
}
const ok = (minutesAgo: number) => ({ started_at: new Date(NOW - minutesAgo * 60000).toISOString(), status: "success", notes: { trigger: "cron */30 * * * *" } });

function input(over: Partial<HealthInput> & { rows?: EventBroadcast[] } = {}): HealthInput {
  const rows = over.rows ?? [row()];
  return {
    now: NOW,
    events: [EV, LATER],
    resolve: rowResolver(rows),
    lastRun: ok(20),
    lastSuccess: ok(20),
    bindings: ALL_BINDINGS,
    ...over,
  };
}

test("GREEN: fight-week card with an attached row, fresh collector, every secret present", () => {
  const h = evaluateBroadcastHealth(input());
  assert.equal(h.status, "GREEN", JSON.stringify(h.conditions));
  assert.equal(h.incident, false);
  assert.equal(h.canonical_next_event?.id, EV.id);
  assert.equal(h.in_fight_week, true);
  assert.equal(h.broadcast_attached, true);
  assert.equal(h.last_verified_at, "2026-11-12T14:00:00Z");
  assert.equal(h.minutes_since_success, 20);
  assert.equal(h.last_ledger_run?.trigger, "cron */30 * * * *");
});

test("RED: a canonical card inside fight week with no resolved broadcast row", () => {
  const h = evaluateBroadcastHealth(input({ rows: [] }));
  assert.equal(h.status, "RED");
  assert.equal(h.incident, true);
  assert.equal(h.broadcast_attached, false);
  assert.ok(h.conditions.some((c) => c.code === "broadcast_missing"));
});

test("RED: a missing Worker secret is an incident even when the data looks fine", () => {
  for (const key of Object.keys(ALL_BINDINGS)) {
    const h = evaluateBroadcastHealth(input({ bindings: { ...ALL_BINDINGS, [key]: false } }));
    assert.equal(h.status, "RED", key);
    assert.ok(h.conditions.some((c) => c.code === "missing_binding" && c.detail.startsWith(key)), key);
  }
});

test("RED: a collector that never succeeded, or whose last success is older than the cadence allows", () => {
  assert.ok(evaluateBroadcastHealth(input({ lastRun: null, lastSuccess: null })).conditions.some((c) => c.code === "collector_never_succeeded"));
  const stale = evaluateBroadcastHealth(input({ lastSuccess: ok(STALE_LIMIT_MINUTES.week + 5) }));
  assert.equal(stale.status, "RED");
  assert.ok(stale.conditions.some((c) => c.code === "collector_stale"));
  /* Inside 24 hours of the main card the limit tightens. */
  const eve = Date.parse("2026-11-14T12:00:00Z");
  const tight = evaluateBroadcastHealth(input({ now: eve, lastSuccess: { ...ok(0), started_at: new Date(eve - (STALE_LIMIT_MINUTES.near + 1) * 60000).toISOString() } }));
  assert.equal(tight.stale_limit_minutes, STALE_LIMIT_MINUTES.near);
  assert.equal(tight.status, "RED");
});

test("a card outside fight week with no row is not an incident", () => {
  const far = Date.parse("2026-10-20T15:00:00Z");
  const h = evaluateBroadcastHealth(input({ now: far, rows: [], lastSuccess: { started_at: new Date(far - 60 * 60000).toISOString(), status: "success" } }));
  assert.equal(h.canonical_next_event?.id, EV.id);
  assert.equal(h.in_fight_week, false);
  assert.equal(h.status, "GREEN", JSON.stringify(h.conditions));
});

test("read failure is RED, never a silent GREEN", () => {
  const h = evaluateBroadcastHealth(input({ readError: "HTTP 500 from ufc_events" }));
  assert.equal(h.status, "RED");
  assert.ok(h.conditions.some((c) => c.code === "health_read_failed"));
});

test("a failed last pass with a recent success is AMBER", () => {
  const h = evaluateBroadcastHealth(input({ lastRun: { ...ok(5), status: "failed" } }));
  assert.equal(h.status, "AMBER");
});

test("canonical event: skips Contender Series, cancelled cards and finished broadcasts", () => {
  const dwcs: CanonicalEvent = { id: "d", name: "Dana White's Contender Series: Week 9", event_date: "2026-11-13" };
  const cancelled: CanonicalEvent = { id: "c", name: "UFC Fight Night: Gone vs. Away", event_date: "2026-11-13", bouts_total: 6, bouts_active: 0 };
  assert.equal(canonicalNextEvent([dwcs, cancelled, EV], rowResolver([row()]), NOW)?.id, EV.id);
  /* Unknown bout counts never cancel an event. */
  const unknown: CanonicalEvent = { id: "u", name: "UFC Fight Night: Unknown", event_date: "2026-11-13" };
  assert.equal(canonicalNextEvent([unknown, EV], rowResolver([]), NOW)?.id, "u");
  /* After the main card + 5 h tail the next card takes over. */
  const after = Date.parse("2026-11-15T06:00:00Z");
  assert.equal(canonicalNextEvent([EV, LATER], rowResolver([row()]), after)?.id, LATER.id);
  /* Fight night across UTC midnight: still the current card. */
  const late = Date.parse("2026-11-15T02:00:00Z");
  assert.equal(canonicalNextEvent([EV, LATER], rowResolver([row()]), late)?.id, EV.id);
});

test("row matching: linked, the single unlinked row on the date, a decisive name, else nothing", () => {
  assert.equal(matchStoredRow(EV, [row()])?.ufc_slug, row().ufc_slug);
  assert.ok(matchStoredRow(EV, [row({ event_id: null, match_status: "unmatched" })]));
  const a = row({ event_id: null, ufc_slug: "a", event_name: "UFC Fight Night: Alpha vs Bravo" });
  const b = row({ event_id: null, ufc_slug: "b", event_name: "UFC Fight Night: Echo vs Foxtrot" });
  assert.equal(matchStoredRow(EV, [a, b])?.ufc_slug, "a");
  const c = row({ event_id: null, ufc_slug: "c", event_name: "UFC Fight Night: Golf vs Hotel" });
  assert.equal(matchStoredRow(EV, [b, c]), null, "never another card's start time");
  /* A row linked to a DIFFERENT event never attaches. */
  assert.equal(matchStoredRow(EV, [row({ event_id: LATER.id })]), null);
});

test("UI surface: strip, pending, unavailable, finished, none", () => {
  assert.equal(selectWatchSurface(EV, row(), NOW), "strip");
  assert.equal(selectWatchSurface(EV, row({ prelims_start_utc: null, main_card_start_utc: null, broadcasts: [] }), NOW), "pending");
  /* Carrier known, time not yet: still a strip (it names the carrier). */
  assert.equal(selectWatchSurface(EV, row({ prelims_start_utc: null, main_card_start_utc: null }), NOW), "strip");
  assert.equal(selectWatchSurface(EV, null, NOW), "unavailable");
  assert.equal(selectWatchSurface(EV, row(), Date.parse("2026-11-15T06:00:00Z")), "finished");
  assert.equal(selectWatchSurface(EV, null, Date.parse("2026-10-20T15:00:00Z")), "none", "outside fight week a missing row collapses");
  assert.equal(selectWatchSurface(null, null, NOW), "none");
});

test("fight-week window is the collector's 8 days, counted on the site clock", () => {
  assert.equal(FIGHT_WEEK_DAYS, 8);
  assert.equal(inFightWeek("2026-11-20", NOW), true);
  assert.equal(inFightWeek("2026-11-21", NOW), false);
  assert.equal(inFightWeek("2026-11-14", Date.parse("2026-11-15T04:00:00Z")), true, "fight night before the 05:00 UTC rollover");
});

test("no event is special-cased: the invariant and the UI carry no event names, ids or numbers", () => {
  for (const f of ["./broadcastHealth.ts", "../components/HowToWatch.tsx", "../../workers/ufc-broadcast-schedule/src/index.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /ufc-3\d\d|UFC 3\d\d|845c3b2c/i, f);
  }
});
