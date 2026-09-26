/* Fight Week rail: the Event Snapshot rows, the watch link and the desk's
 * editorial notes.
 *
 * Pure: no fetch, no env, no "@/..." import, so `node --test` runs it as is.
 *
 * Start times and carriers are NOT decided here. They come from the one
 * schedule contract, lib/eventSchedule.ts (stored ufc_event_broadcasts row,
 * then the approved event-id-keyed entry, field by field), which is the same
 * resolver behind the homepage strip, the event page and /api/ufc/next-event.
 * FIGHT_WEEK_EDITORIAL below carries desk notes only — never times. */
import { localTime, zoneLabel, providerList, type Broadcast } from "./broadcast-display.ts";
import { PARAMOUNT_UFC_URL, resolveScheduleFields, type ScheduleFields } from "./eventSchedule.ts";

export type SnapshotRow = { label: string; value: string };
export type SnapshotLink = { label: string; href: string; external: boolean };

type Schedule = Partial<ScheduleFields>;
type EventLike = { id: string; event_date: string | null; venue: string | null; city: string | null; region: string | null; country: string | null };

/* The rail sends every Paramount+ reader to one stable UFC hub page. */
export { PARAMOUNT_UFC_URL };

export const FIGHT_WEEK_EDITORIAL: Record<string, { watchFor?: string }> = {
  /* UFC Fight Night: Rosas Jr. vs. Barcelos · 2026-09-26 · Meta APEX. */
  "1f2531bd-70d4-494f-84c0-9587f9496796": {
    watchFor: "The clearest edge is Raul’s grappling pressure against Barcelos’ lower takedown volume. If Rosas establishes control early, that first five-minute stretch could define the entire fight.",
  },
};

/* Venue clock. Events carry no time zone, so the zone comes from where the
 * venue is; a place this table does not know gets no Local Time row rather
 * than a guessed one. States split across zones are listed by city only. */
const CITY_ZONE: Record<string, string> = {
  "las vegas": "America/Los_Angeles", "los angeles": "America/Los_Angeles", "anaheim": "America/Los_Angeles", "sacramento": "America/Los_Angeles", "seattle": "America/Los_Angeles",
  "phoenix": "America/Phoenix", "glendale": "America/Phoenix", "denver": "America/Denver", "salt lake city": "America/Denver",
  "chicago": "America/Chicago", "houston": "America/Chicago", "dallas": "America/Chicago", "austin": "America/Chicago", "san antonio": "America/Chicago", "nashville": "America/Chicago", "kansas city": "America/Chicago", "st. louis": "America/Chicago", "new orleans": "America/Chicago",
  "new york": "America/New_York", "newark": "America/New_York", "boston": "America/New_York", "philadelphia": "America/New_York", "miami": "America/New_York", "jacksonville": "America/New_York", "tampa": "America/New_York", "orlando": "America/New_York", "atlanta": "America/New_York", "charlotte": "America/New_York", "washington": "America/New_York", "columbus": "America/New_York", "cleveland": "America/New_York", "detroit": "America/New_York",
  "toronto": "America/Toronto", "montreal": "America/Toronto", "vancouver": "America/Vancouver", "edmonton": "America/Edmonton", "mexico city": "America/Mexico_City",
  "london": "Europe/London", "manchester": "Europe/London", "paris": "Europe/Paris", "abu dhabi": "Asia/Dubai", "riyadh": "Asia/Riyadh", "perth": "Australia/Perth", "sydney": "Australia/Sydney", "singapore": "Asia/Singapore", "shanghai": "Asia/Shanghai", "macau": "Asia/Macau", "sao paulo": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo",
};
export function venueZone(e: Pick<EventLike, "city">): string | null {
  return CITY_ZONE[(e.city || "").trim().toLowerCase()] || null;
}

/* "5:00 PM PT": US zones read the way a broadcast graphic says them (PT, not
 * PDT); every other zone keeps the label Intl gives it. */
export function clockLabel(iso: string, timeZone: string): string {
  const t = localTime(iso, timeZone);
  if (!t) return "";
  const z = zoneLabel(iso, timeZone).replace(/^([ECMP])[DS]T$/, "$1T");
  return z ? `${t} ${z}` : t;
}

/* The canonical merge (lib/eventSchedule.ts). Idempotent, so a row that
 * lib/broadcast.ts already resolved comes back unchanged. */
export function resolveSchedule(eventId: string, stored: Schedule | null | undefined): Schedule | null {
  const r = resolveScheduleFields(eventId, stored);
  if (!r) return null;
  const { filled: _filled, ...fields } = r;
  return fields;
}

export function watchForNote(eventId: string): string | null {
  return FIGHT_WEEK_EDITORIAL[eventId]?.watchFor || null;
}

const US = (b: Broadcast) => !b.region || /^(us|usa)$/i.test(b.region);
function carriers(s: Schedule | null): Broadcast[] {
  const all = (s?.broadcasts || []).filter((b) => b && b.provider);
  const us = all.filter(US);
  return us.length ? us : all;
}
const isParamount = (b: Broadcast) => /paramount\s*\+|paramount plus/i.test(b.provider);

function dateLabel(d: string | null): string {
  if (!d) return "Date TBA";
  const t = new Date(`${d.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(t.getTime()) ? "Date TBA" : t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function updatedLabel(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
function venueLabel(e: EventLike): string {
  const place = [e.city, e.region || e.country].filter(Boolean).join(", ");
  return [e.venue, place].filter(Boolean).join(" · ") || "Venue TBA";
}

/* Rows with nothing verified behind them are left out, never padded: a card
 * with no schedule shows Date · Venue · Card · Updated and nothing else. A
 * finished card keeps its times but drops the "stream live" line. */
export function eventSnapshot(p: { event: EventLike; stored?: Schedule | null; bouts: number; updated: string | null; done: boolean }): { rows: SnapshotRow[]; watch: SnapshotLink | null } {
  const { event, bouts, done } = p;
  const s = resolveSchedule(event.id, p.stored);
  const start = s?.main_card_start_utc || null;
  const zone = venueZone(event);
  const on = carriers(s);
  const lead = on[0] || null;
  const rows: SnapshotRow[] = [{ label: "Date", value: dateLabel(event.event_date) }, { label: "Venue", value: venueLabel(event) }];
  if (start && zone) rows.push({ label: "Local Time", value: clockLabel(start, zone) });
  if (s?.early_prelims_start_utc) rows.push({ label: "Early Prelims", value: clockLabel(s.early_prelims_start_utc, "America/New_York") });
  if (s?.prelims_start_utc) rows.push({ label: "Prelims", value: clockLabel(s.prelims_start_utc, "America/New_York") });
  if (start) rows.push({ label: "Main Card", value: clockLabel(start, "America/New_York") });
  if (on.length) rows.push({ label: "Broadcast", value: providerList(on) });
  if (lead && !done) rows.push({ label: "Watch", value: `${lead.type === "streaming" ? "Stream" : "Watch"} live on ${lead.provider}` });
  rows.push({ label: "Card", value: `${bouts} announced ${bouts === 1 ? "bout" : "bouts"}` });
  const updated = updatedLabel(p.updated);
  if (updated) rows.push({ label: "Updated", value: updated });
  const href = lead ? (isParamount(lead) ? PARAMOUNT_UFC_URL : lead.watch_url) : null;
  return { rows, watch: lead && href && !done ? { label: `Watch on ${lead.provider}`, href, external: true } : null };
}
