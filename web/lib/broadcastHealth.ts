/* Broadcast schedule health: ONE definition, used by the ufc-broadcast-schedule
 * Worker's /health (and its cron self-check), the ufc-record-alerts watchdog
 * that reads that /health, and the homepage/event-page watch surface.
 *
 * Pure: no fetch, no env, no "@/..." import. The Worker bundles this file
 * directly (wrangler/esbuild strips the types) and `node --test` runs it as is.
 *
 * THE INVARIANT (P0, 2026-10-03)
 * ------------------------------
 * If a canonical UFC event (ufc_events, not Contender Series / Road to UFC, not
 * cancelled, not finished) is current or starts within FIGHT_WEEK_DAYS and has
 * no resolved broadcast row, the lane is RED. A missing Worker secret/binding is
 * RED. A collector whose last successful pass is older than the cadence allows
 * is RED.
 *
 * Why "no row for an in-window event" is always a pipeline fault and never
 * "UFC.com has not published yet": UFC.com's /events listing carries every
 * announced card weeks ahead, and the collector stores a row for each one it
 * lists — with null times / an empty carrier list while the promotion has not
 * published them. "Not published yet" is therefore a row WITH nulls; "no row"
 * means the collector did not run, did not write, or could not match the card.
 * That is the 2026-09-26 and 2026-10-03 failure exactly: the Worker had no
 * Supabase secret, every cron pass died before writing, and the homepage strip
 * silently vanished during fight week.
 */
import { isFinished, type EventBroadcast } from "./broadcast-display.ts";
import { ufcDaysUntil } from "./siteClock.ts";
import { resolveEventSchedule, type ScheduleEvent } from "./eventSchedule.ts";

/** "Fight week" for the invariant and for the reserved UI state. Matches the
 *  collector's own week tier (scripts/broadcast/lib/window.mjs WINDOW.weekHours = 192). */
export const FIGHT_WEEK_DAYS = 8;

/** Staleness limits for the last SUCCESSFUL collector pass, in minutes. Each is
 *  two of the collector's cadence periods plus slack (window.mjs CADENCE), so one
 *  missed pass is tolerated and two are an incident. */
export const STALE_LIMIT_MINUTES = {
  /** inside 24 h of the main card, or live: cadence 30-60 min */
  near: 150,
  /** fight week: cadence 6 h */
  week: 13 * 60,
  /** nothing in the window: cadence 12 h */
  idle: 25 * 60,
} as const;

export type HealthStatus = "GREEN" | "AMBER" | "RED";

export type CanonicalEvent = {
  id: string;
  name: string;
  event_date: string | null;
  card_status?: string | null;
  /** Bout counts, when the reader has them: an event whose every bout is
   *  cancelled is treated as cancelled. Unknown counts never cancel an event. */
  bouts_total?: number | null;
  bouts_active?: number | null;
};

export type LedgerRun = { started_at: string; finished_at?: string | null; status: string; notes?: unknown } | null;

export type HealthInput = {
  now: number;
  /** Candidate events, any order. The reader passes ufc_events dated from the
   *  site's yesterday to FIGHT_WEEK_DAYS out. */
  events: CanonicalEvent[];
  /** Resolve one event to its broadcast row, exactly as the pages do. */
  resolve: (e: CanonicalEvent) => EventBroadcast | null;
  lastRun: LedgerRun;
  lastSuccess: LedgerRun;
  /** Worker-only: secret/binding presence. Omitted by readers that cannot see them. */
  bindings?: Record<string, boolean> | null;
  /** Worker-only: the last cron wake, including skipped ones. */
  lastWake?: { at: string; trigger?: string; outcome?: string } | null;
  /** A read failed: the invariant cannot be evaluated, which is itself RED. */
  readError?: string | null;
};

export type HealthCondition = { code: string; severity: "RED" | "AMBER"; detail: string };

export type BroadcastHealth = {
  status: HealthStatus;
  incident: boolean;
  conditions: HealthCondition[];
  canonical_next_event: { id: string; name: string; event_date: string | null; days_out: number | null } | null;
  in_fight_week: boolean;
  broadcast_attached: boolean | null;
  broadcast_source: string | null;
  broadcast_slug: string | null;
  last_worker_run: { at: string; trigger?: string; outcome?: string } | null;
  last_ledger_run: { started_at: string; status: string; trigger: string | null } | null;
  last_success: string | null;
  minutes_since_success: number | null;
  stale_limit_minutes: number;
  last_verified_at: string | null;
  secrets_present: Record<string, boolean> | null;
};

const isCancelled = (e: CanonicalEvent): boolean =>
  e.card_status === "cancelled" || (Number(e.bouts_total) > 0 && Number(e.bouts_active) === 0);

const NOT_CANONICAL = /contender series|road to ufc/i;

/**
 * The current-or-next canonical card: the soonest candidate that is not a
 * Contender Series / Road to UFC card, not cancelled, and not over. A card dated
 * before the site's today is still current while its resolved row is inside the
 * broadcast window (fight night crosses UTC midnight).
 */
export function canonicalNextEvent(events: CanonicalEvent[], resolve: HealthInput["resolve"], now: number): CanonicalEvent | null {
  const sorted = events
    .filter((e) => e.event_date && !NOT_CANONICAL.test(e.name) && !isCancelled(e))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  for (const e of sorted) {
    const days = ufcDaysUntil(e.event_date, now);
    if (days == null) continue;
    const row = resolve(e);
    if (row && isFinished(row, now)) continue;
    if (e.card_status === "complete") continue;
    if (days < 0 && !row) continue; // past and nothing says it is still on air
    return e;
  }
  return null;
}

/** Is this event inside the window where a missing broadcast row is an incident? */
export function inFightWeek(eventDate: string | null | undefined, now: number): boolean {
  const d = ufcDaysUntil(eventDate, now);
  return d != null && d >= -1 && d <= FIGHT_WEEK_DAYS;
}

export function staleLimitMinutes(row: EventBroadcast | null, eventDate: string | null, now: number): number {
  const main = row?.main_card_start_utc ? Date.parse(row.main_card_start_utc) : NaN;
  if (Number.isFinite(main) && main - now <= 24 * 3600e3) return STALE_LIMIT_MINUTES.near;
  if (eventDate && inFightWeek(eventDate, now)) {
    const d = ufcDaysUntil(eventDate, now);
    return d != null && d <= 1 ? STALE_LIMIT_MINUTES.near : STALE_LIMIT_MINUTES.week;
  }
  return STALE_LIMIT_MINUTES.idle;
}

const trig = (r: LedgerRun): string | null => {
  const n = r?.notes as { trigger?: unknown } | null | undefined;
  return n && typeof n.trigger === "string" ? n.trigger : null;
};

export function evaluateBroadcastHealth(input: HealthInput): BroadcastHealth {
  const { now } = input;
  const conditions: HealthCondition[] = [];
  const red = (code: string, detail: string) => conditions.push({ code, severity: "RED", detail });
  const amber = (code: string, detail: string) => conditions.push({ code, severity: "AMBER", detail });

  if (input.bindings) {
    for (const [name, present] of Object.entries(input.bindings)) {
      if (!present) red("missing_binding", `${name} is not configured; every pass fails before writing`);
    }
  }
  if (input.readError) red("health_read_failed", input.readError.slice(0, 160));

  const event = input.readError ? null : canonicalNextEvent(input.events, input.resolve, now);
  const row = event ? input.resolve(event) : null;
  const window = event ? inFightWeek(event.event_date, now) : false;

  if (event && window && !row) {
    red("broadcast_missing", `${event.name} (${event.event_date}) is inside fight week with no resolved broadcast row`);
  }

  const lastSuccessAt = input.lastSuccess?.started_at ?? null;
  const sinceMs = lastSuccessAt ? now - Date.parse(lastSuccessAt) : NaN;
  const minutesSince = Number.isFinite(sinceMs) ? Math.max(0, Math.round(sinceMs / 60000)) : null;
  const limit = staleLimitMinutes(row, event?.event_date ?? null, now);
  if (!input.readError) {
    if (minutesSince == null) red("collector_never_succeeded", "the run ledger has no successful pass");
    else if (minutesSince > limit) red("collector_stale", `last successful pass ${minutesSince}m ago, limit ${limit}m`);
  }
  if (input.lastRun && input.lastRun.status === "failed") {
    amber("last_run_failed", `most recent pass (${input.lastRun.started_at}) failed`);
  }
  if (row && row.source !== "approved_schedule" && !row.main_card_start_utc && window) {
    /* Honest "time to be announced": UFC.com has not published it. Not an
     * incident, but worth seeing on /health during fight week. */
    amber("times_unpublished", `${row.event_name}: UFC.com has not published start times`);
  }

  const status: HealthStatus = conditions.some((c) => c.severity === "RED") ? "RED" : conditions.length ? "AMBER" : "GREEN";
  return {
    status,
    incident: status === "RED",
    conditions,
    canonical_next_event: event ? { id: event.id, name: event.name, event_date: event.event_date, days_out: ufcDaysUntil(event.event_date, now) } : null,
    in_fight_week: window,
    broadcast_attached: event ? Boolean(row) : null,
    broadcast_source: row?.source ?? null,
    broadcast_slug: row?.ufc_slug ?? null,
    last_worker_run: input.lastWake ?? null,
    last_ledger_run: input.lastRun ? { started_at: input.lastRun.started_at, status: input.lastRun.status, trigger: trig(input.lastRun) } : null,
    last_success: lastSuccessAt,
    minutes_since_success: minutesSince,
    stale_limit_minutes: limit,
    last_verified_at: row?.verified_at ?? null,
    secrets_present: input.bindings ?? null,
  };
}

/* ------------------------------------------------------------- row matching */

/* The ONE rule for "which stored row belongs to this event", shared by the
 * page reader (lib/broadcast.ts) and the Worker's health check, so /health can
 * never call a card attached that the homepage cannot find (or the reverse).
 *
 *   1. a row linked by event_id
 *   2. else the single UNLINKED row on the event's date
 *   3. else, among several unlinked rows that day, one decisive name overlap
 *   4. else nothing: never guess another card's start time */
const STOP = new Set(["ufc", "fight", "night", "vs", "the", "noche", "on", "espn", "abc"]);
function tokens(s: string): Set<string> {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));
}
export function nameOverlap(a: string, b: string): number {
  const x = tokens(a); const y = tokens(b);
  let n = 0;
  for (const t of x) if (y.has(t)) n += 1;
  return n;
}

export function matchStoredRow(event: { id: string; name: string; event_date: string | null }, rows: EventBroadcast[]): EventBroadcast | null {
  const linked = rows.find((r) => r.event_id === event.id);
  if (linked) return linked;
  if (!event.event_date) return null;
  const sameDate = rows.filter((r) => !r.event_id && r.event_date === event.event_date);
  if (sameDate.length === 1) return sameDate[0];
  if (sameDate.length === 0) return null;
  const hit = sameDate.filter((r) => nameOverlap(event.name, r.event_name) > 0);
  return hit.length === 1 ? hit[0] : null;
}

/** Stored rows -> the resolver evaluateBroadcastHealth() wants: the same
 *  match + approved-schedule merge every page uses. */
export function rowResolver(rows: EventBroadcast[]): (e: CanonicalEvent) => EventBroadcast | null {
  return (e) => resolveEventSchedule(e as ScheduleEvent, matchStoredRow(e, rows));
}

/* ------------------------------------------------------------------ UI state */

/** What the watch area on the homepage hero / event page renders.
 *
 *   strip        a resolved row with at least one start time or carrier
 *   pending      a resolved row with neither: UFC.com has not published them yet
 *   unavailable  no resolved row while the event is inside fight week: our
 *                pipeline did not deliver (see the invariant above). A compact,
 *                reserved-height notice; never an invented time or channel
 *   finished     the row's broadcast window has closed
 *   none         no event, or no row for an event outside fight week: nothing
 */
export type WatchSurfaceState = "strip" | "pending" | "unavailable" | "finished" | "none";

export function selectWatchSurface(
  event: { event_date: string | null } | null,
  row: EventBroadcast | null,
  now: number,
): WatchSurfaceState {
  if (!event) return "none";
  if (row) {
    if (isFinished(row, now)) return "finished";
    const hasTime = Boolean(row.early_prelims_start_utc || row.prelims_start_utc || row.main_card_start_utc);
    const hasCarrier = (row.broadcasts?.length ?? 0) > 0;
    return hasTime || hasCarrier ? "strip" : "pending";
  }
  return inFightWeek(event.event_date, now) ? "unavailable" : "none";
}
