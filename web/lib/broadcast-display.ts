/* How to Watch: the pure display model.
 *
 * Types, timezone conversion, the state machine and the countdown. Deliberately
 * free of any server import so that the SAME functions run in the server
 * component that renders the first paint and in the client component that
 * re-renders it in the visitor's own timezone. Two implementations of "what
 * time does the main card start" is exactly how a page ends up disagreeing
 * with itself.
 *
 * THE CONVERSION RULE
 * -------------------
 * Every localized string in this file comes from Intl.DateTimeFormat with an
 * IANA timeZone. There is no hour arithmetic anywhere and there must never be:
 * "ET minus one hour" is wrong in Arizona, wrong across every DST boundary,
 * and wrong for every viewer outside North America. The stored value is always
 * a UTC instant; the zone is always the viewer's.
 */

export type BroadcastType = "streaming" | "tv" | "ppv" | null;
export type Segment = "early_prelims" | "prelims" | "main_card";

export type Broadcast = {
  provider: string;
  region: string | null;
  type: BroadcastType;
  watch_url: string | null;
  segments: Segment[];
};

export type EventBroadcast = {
  ufc_slug: string;
  event_id: string | null;
  match_status: "matched" | "unmatched" | "ambiguous";
  event_name: string;
  event_headline: string | null;
  event_date: string | null;
  venue: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  location_raw: string | null;
  early_prelims_start_utc: string | null;
  prelims_start_utc: string | null;
  main_card_start_utc: string | null;
  broadcasts: Broadcast[];
  ufc_event_url: string;
  tickets_url: string | null;
  source: string;
  source_url: string;
  parser: string;
  verified_at: string;
  last_changed_at: string;
};


/** How long after the main card starts we still call a card "live". */
export const LIVE_TAIL_MS = 5 * 60 * 60 * 1000;
/** A verification older than this is shown as stale rather than as fresh. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type WatchState =
  | "upcoming"      // starts later than today
  | "today"         // starts today, not yet started
  | "live"          // inside the broadcast window
  | "finished"      // the window has passed
  | "time_tba";     // no segment has a published start time

export type StartLine = { key: Segment; label: string; utc: string };

const SEGMENT_LABEL: Record<Segment, string> = {
  early_prelims: "Early Prelims",
  prelims: "Prelims",
  main_card: "Main Card",
};

/** The published segments, earliest first. Nulls are omitted, never zeroed. */
export function startLines(b: Pick<EventBroadcast, "early_prelims_start_utc" | "prelims_start_utc" | "main_card_start_utc">): StartLine[] {
  const out: StartLine[] = [];
  if (b.early_prelims_start_utc) out.push({ key: "early_prelims", label: SEGMENT_LABEL.early_prelims, utc: b.early_prelims_start_utc });
  if (b.prelims_start_utc) out.push({ key: "prelims", label: SEGMENT_LABEL.prelims, utc: b.prelims_start_utc });
  if (b.main_card_start_utc) out.push({ key: "main_card", label: SEGMENT_LABEL.main_card, utc: b.main_card_start_utc });
  return out;
}

/** The instant the broadcast opens: the earliest published segment. */
export function firstStartMs(b: Parameters<typeof startLines>[0]): number | null {
  const lines = startLines(b);
  if (!lines.length) return null;
  const t = Date.parse(lines[0].utc);
  return Number.isFinite(t) ? t : null;
}

export function mainCardMs(b: Pick<EventBroadcast, "main_card_start_utc">): number | null {
  if (!b.main_card_start_utc) return null;
  const t = Date.parse(b.main_card_start_utc);
  return Number.isFinite(t) ? t : null;
}

export function isFinished(b: Parameters<typeof startLines>[0] & Pick<EventBroadcast, "main_card_start_utc">, now = Date.now()): boolean {
  const main = mainCardMs(b) ?? firstStartMs(b);
  if (main == null) return false;
  return now > main + LIVE_TAIL_MS;
}

/**
 * Which of the ten designed states this card is in, for a given viewer clock
 * and timezone.
 *
 * "today" is the viewer's today, not Eastern's — a Californian looking at a
 * card that starts at 22:00 their Friday should be told "Today", and a
 * Londoner looking at the same instant should not.
 */
export function watchState(
  b: Parameters<typeof startLines>[0] & Pick<EventBroadcast, "main_card_start_utc">,
  now = Date.now(),
  timeZone?: string,
): WatchState {
  const first = firstStartMs(b);
  const main = mainCardMs(b);
  if (first == null && main == null) return "time_tba";
  const open = first ?? main!;
  const close = (main ?? open) + LIVE_TAIL_MS;
  if (now > close) return "finished";
  if (now >= open) return "live";
  return sameDay(now, open, timeZone) ? "today" : "upcoming";
}

/** Calendar-day comparison in a named zone. Never date arithmetic on offsets. */
export function sameDay(aMs: number, bMs: number, timeZone?: string): boolean {
  return dayKey(aMs, timeZone) === dayKey(bMs, timeZone);
}

export function dayKey(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  }
}

/**
 * Localized clock time for a canonical instant.
 *
 * The ONLY conversion mechanism in this codebase. There is deliberately no
 * hour-offset arithmetic anywhere: "ET minus one hour" is wrong for Arizona,
 * wrong for every card that straddles a DST boundary, and wrong for every
 * viewer outside North America. Intl carries the full tz database.
 */
export function localTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(d).replace(/\s?([AP])M/, " $1M");
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  }
}

/** The short zone name a viewer recognises: CDT, PST, GMT+1. */
export function zoneLabel(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short", hour: "numeric" }).formatToParts(d);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Localized weekday + date, for the line under the event name. */
export function localDay(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(d);
  } catch {
    return "";
  }
}

/**
 * "5h 12m", "42m", "Live now".
 *
 * Computed from a UTC instant the server already sent. The countdown never
 * calls the API: a clock that ticks is a client concern and re-fetching a
 * start time every minute to render it would be absurd.
 */
export function countdown(targetMs: number, now = Date.now()): string {
  const ms = targetMs - now;
  if (ms <= 0) return "Live now";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "18 min ago", "3 hours ago" — for the verification line. */
export function verifiedAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never verified";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never verified";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function isStale(iso: string | null | undefined, now = Date.now()): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

/** Carriers we can legitimately link. Never a manufactured destination. */
export function linkableBroadcasts(b: Pick<EventBroadcast, "broadcasts">): Broadcast[] {
  return (b.broadcasts ?? []).filter((x) => x && x.provider && x.watch_url);
}

/** A human list: "Paramount+", "Paramount+ and CBS", "A, B and C". */
export function providerList(broadcasts: Broadcast[]): string {
  const names = broadcasts.map((b) => b.provider).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Which segments a carrier covers, for the sub-label under a CTA. */
export function segmentSummary(b: Broadcast): string {
  if (!b.segments?.length) return "";
  if (b.segments.length === 3) return "Full card";
  return b.segments.map((s) => SEGMENT_LABEL[s]).join(" · ");
}
