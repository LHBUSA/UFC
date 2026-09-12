/* How to Watch: the reader, the display model, and the state machine.
 *
 * The page NEVER touches UFC.com. It reads ufc_event_broadcasts, which the
 * ufc-broadcast-schedule Cloudflare Worker fills on a Cron Trigger. A reader's
 * page load must not be able to wait on, or be broken by, the promotion's
 * website — that is the entire point of having the Worker.
 *
 * This module is the SERVER half: the PostgREST readers. The pure display
 * model — types, timezone conversion, the state machine, the countdown — lives
 * in lib/broadcast-display.ts with no server import, so the same functions can
 * run in the client component that re-renders the times in the visitor's zone.
 * It is re-exported here so a server component has one import to make.
 */
import "server-only";
import { dbConfigured, REVALIDATE } from "@/lib/db";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export * from "@/lib/broadcast-display";

import type { EventBroadcast } from "@/lib/broadcast-display";
import { isFinished } from "@/lib/broadcast-display";

const COLS = [
  "ufc_slug", "event_id", "match_status", "event_name", "event_headline", "event_date",
  "venue", "city", "region", "country", "location_raw",
  "early_prelims_start_utc", "prelims_start_utc", "main_card_start_utc",
  "broadcasts", "ufc_event_url", "tickets_url",
  "source", "source_url", "parser", "verified_at", "last_changed_at",
].join(",");

/* Same failure posture as lib/db.ts: a missing env var, a table that does not
 * exist yet, or a network blip yields an EMPTY result and a log line. The How
 * to Watch block then renders nothing at all rather than a broken panel, and
 * every other part of the page is unaffected. */
async function rest<T>(path: string, fallback: T, revalidate = REVALIDATE): Promise<T> {
  if (!dbConfigured() || !URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      next: { revalidate },
    });
    if (!res.ok) {
      console.error(`[broadcast] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return fallback;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : fallback;
  } catch (e) {
    console.error(`[broadcast] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return fallback;
  }
}

/** Every stored card, soonest first. Cards with no published time sort last.
 *
 * `revalidate: 0` is the right argument from an API route. "Is there an
 * upcoming event, and when does it start" is an existence question, and a
 * cached answer to an existence question is wrong at exactly the moment it
 * flips — Next's data cache also outlives the deployment that filled it. Pages
 * keep the 5-minute data cache; the routes cache at the CDN instead, where the
 * TTL is short and per-request. */
export async function getBroadcastSchedule(limit = 40, revalidate?: number): Promise<EventBroadcast[]> {
  return rest<EventBroadcast[]>(
    `ufc_event_broadcasts?select=${COLS}&order=main_card_start_utc.asc.nullslast&limit=${limit}`,
    [],
    revalidate,
  );
}

/**
 * The broadcast row for one of OUR events.
 *
 * Two lookups, deliberately. `event_id` is the link the Worker resolved and is
 * the authority when it exists. The date fallback exists because UFC.com
 * publishes cards before our schedule source does, so a brand-new event page
 * can have a broadcast row that is not linked yet — and showing the right start
 * time one cron cycle early is better than showing none. The fallback is only
 * ever used when the row is UNLINKED, so it can never override a real link.
 */
export async function getBroadcastForEvent(event: { id: string; event_date: string | null; name: string }): Promise<EventBroadcast | null> {
  const linked = await rest<EventBroadcast[]>(
    `ufc_event_broadcasts?select=${COLS}&event_id=eq.${event.id}&limit=1`, [],
  );
  if (linked[0]) return linked[0];
  if (!event.event_date) return null;
  const sameDate = await rest<EventBroadcast[]>(
    `ufc_event_broadcasts?select=${COLS}&event_date=eq.${event.event_date}&event_id=is.null&limit=4`, [],
  );
  if (sameDate.length === 1) return sameDate[0];
  if (sameDate.length === 0) return null;
  /* More than one unlinked card on the date: only accept a decisive name
   * overlap, otherwise show nothing rather than the wrong card's start time. */
  const hit = sameDate.filter((r) => nameOverlap(event.name, r.event_name) > 0);
  return hit.length === 1 ? hit[0] : null;
}

/** The soonest card that has not finished its broadcast window. */
export async function getNextBroadcast(now = Date.now(), revalidate?: number): Promise<EventBroadcast | null> {
  const rows = await getBroadcastSchedule(12, revalidate);
  return rows.find((r) => !isFinished(r, now)) ?? null;
}

const STOP = new Set(["ufc", "fight", "night", "vs", "the", "noche", "on", "espn", "abc"]);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));
}
function nameOverlap(a: string, b: string): number {
  const x = tokens(a); const y = tokens(b);
  let n = 0;
  for (const t of x) if (y.has(t)) n += 1;
  return n;
}

