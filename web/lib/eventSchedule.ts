/* THE event schedule contract: one resolver behind every watch surface.
 *
 * Pure: no fetch, no env, no "@/..." import, so `node --test` runs it as is.
 *
 * Homepage WatchStrip, the event page's How to Watch panel, the Fight Week
 * snapshot, /api/ufc/next-event, /api/ufc/schedule and Round-for-Round all
 * read a broadcast row through lib/broadcast.ts, and lib/broadcast.ts passes
 * every row through resolveEventSchedule() below. There is no second path, so
 * those surfaces cannot disagree about when a card starts or where it airs.
 *
 * Priority, FIELD BY FIELD:
 *   1. the stored ufc_event_broadcasts row (the ufc-broadcast-schedule Worker,
 *      parsed from UFC.com's epoch attributes)
 *   2. an APPROVED_SCHEDULES entry keyed by OUR event id
 *   3. nothing: the field stays null and the surface says "not published"
 *
 * Why (2) exists: a single missing or unlinked stored row used to remove the
 * whole customer-facing schedule from the homepage (2026-09-26, Rosas Jr. vs
 * Barcelos: the Worker had no Supabase secret, so it never wrote the card).
 * An approved entry is facts someone checked, keyed by id only — never by
 * name, never by date, never copied from the previous card — so no other event
 * can inherit them, and the stored row silently takes over the moment the
 * collector writes it. */
import type { Broadcast, EventBroadcast } from "./broadcast-display.ts";

/* The UFC hub on Paramount+. The collector stores whichever landing page
 * UFC.com linked that week; approved entries use this one stable page. */
export const PARAMOUNT_UFC_URL = "https://www.paramountplus.com/collections/ufc/";

/** `source` on a row built (wholly or partly) from an approved entry. */
export const APPROVED_SOURCE = "approved_schedule";

export type ApprovedSchedule = {
  /** Omit a segment that was not verified. Never zero-fill or guess one. */
  early_prelims_start_utc?: string;
  prelims_start_utc?: string;
  main_card_start_utc?: string;
  broadcasts?: Broadcast[];
  /** The official UFC.com event page the times were checked against. */
  ufc_event_url?: string;
  /** When a person checked these values against the official source. */
  approved_at: string;
  /** Who/what approved it, for the audit trail in code review. */
  basis: string;
};

export const APPROVED_SCHEDULES: Record<string, ApprovedSchedule> = {
  /* UFC Fight Night: Rosas Jr. vs. Barcelos · 2026-09-26 · Meta APEX.
   * Main card owner-supplied 2026-09-20; prelims + main re-checked 2026-09-26
   * against UFC.com's data-prelims-card-timestamp / data-main-card-timestamp
   * (5:00 PM ET / 8:00 PM ET, Paramount+ for both segments). UFC.com lists no
   * early prelims for this card, so there is no early_prelims value. */
  "1f2531bd-70d4-494f-84c0-9587f9496796": {
    prelims_start_utc: "2026-09-26T21:00:00Z",
    main_card_start_utc: "2026-09-27T00:00:00Z",
    broadcasts: [{ provider: "Paramount+", region: "US", type: "streaming", watch_url: PARAMOUNT_UFC_URL, segments: ["prelims", "main_card"] }],
    ufc_event_url: "https://www.ufc.com/event/ufc-fight-night-september-26-2026",
    approved_at: "2026-09-26T16:00:00Z",
    basis: "owner-approved; matches UFC.com /events epoch attributes",
  },
};

export function approvedScheduleIds(): string[] {
  return Object.keys(APPROVED_SCHEDULES);
}

/** The fields an event row contributes when there is no stored broadcast row. */
export type ScheduleEvent = {
  id: string;
  name: string;
  event_date: string | null;
  venue?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
};

const TIME_FIELDS = ["early_prelims_start_utc", "prelims_start_utc", "main_card_start_utc"] as const;

export type ScheduleFields = Pick<EventBroadcast, "early_prelims_start_utc" | "prelims_start_utc" | "main_card_start_utc" | "broadcasts">;

/**
 * The merge rule itself, on just the schedule fields: stored wins per field,
 * the approved entry for THIS event id fills gaps, anything else stays null.
 * `filled` says whether any value came from the approved entry.
 */
export function resolveScheduleFields(eventId: string, stored: Partial<ScheduleFields> | null | undefined): (ScheduleFields & { filled: boolean }) | null {
  const fill = APPROVED_SCHEDULES[eventId];
  if (!stored && !fill) return null;
  let filled = false;
  const pick = (k: (typeof TIME_FIELDS)[number]): string | null => {
    if (stored?.[k]) return stored[k]!;
    if (fill?.[k]) { filled = true; return fill[k]!; }
    return null;
  };
  const early_prelims_start_utc = pick("early_prelims_start_utc");
  const prelims_start_utc = pick("prelims_start_utc");
  const main_card_start_utc = pick("main_card_start_utc");
  let broadcasts = stored?.broadcasts ?? [];
  if (!broadcasts.length && fill?.broadcasts?.length) { broadcasts = fill.broadcasts; filled = true; }
  return { early_prelims_start_utc, prelims_start_utc, main_card_start_utc, broadcasts, filled };
}

/**
 * The resolved schedule for one of OUR events: the stored row merged with the
 * approved entry for that event id, field by field, stored always winning.
 *
 * Returns the same EventBroadcast shape the collector writes, so every renderer
 * keeps working unchanged. `source` stays the stored row's source when the
 * stored row supplied every displayed field, and becomes APPROVED_SOURCE the
 * moment any displayed field came from the approved entry — the surface must
 * not claim "verified from UFC.com" for a value it did not read there.
 */
export function resolveEventSchedule(event: ScheduleEvent | null, stored: EventBroadcast | null | undefined): EventBroadcast | null {
  const fill = event ? APPROVED_SCHEDULES[event.id] : undefined;
  if (!fill) return stored ?? null;
  if (!event) return stored ?? null;

  if (!stored) {
    const place = [event.city, event.region || event.country].filter(Boolean).join(", ") || null;
    return {
      ufc_slug: slugFromUrl(fill.ufc_event_url) || event.id,
      event_id: event.id,
      match_status: "matched",
      event_name: event.name,
      event_headline: null,
      event_date: event.event_date,
      venue: event.venue ?? null,
      city: event.city ?? null,
      region: event.region ?? null,
      country: event.country ?? null,
      location_raw: place,
      early_prelims_start_utc: fill.early_prelims_start_utc ?? null,
      prelims_start_utc: fill.prelims_start_utc ?? null,
      main_card_start_utc: fill.main_card_start_utc ?? null,
      broadcasts: fill.broadcasts ?? [],
      ufc_event_url: fill.ufc_event_url || "https://www.ufc.com/events",
      tickets_url: null,
      source: APPROVED_SOURCE,
      source_url: fill.ufc_event_url || "https://www.ufc.com/events",
      parser: "approved-schedule-v1",
      verified_at: fill.approved_at,
      last_changed_at: fill.approved_at,
    };
  }

  const { filled, ...fields } = resolveScheduleFields(event.id, stored)!;
  return { ...stored, ...fields, event_id: stored.event_id || event.id, source: filled ? APPROVED_SOURCE : stored.source };
}

/** Where the displayed values came from, in the words a reader sees. */
export function scheduleSourceLabel(b: Pick<EventBroadcast, "source">): string {
  return b.source === APPROVED_SOURCE ? "Confirmed schedule" : "UFC.com";
}

/**
 * Merge approved entries into a list of stored rows (schedule, next-event,
 * Round-for-Round). A stored row linked to an approved event is merged field
 * by field; an approved event with no linked row gets its fallback row. Rows
 * for other events pass through untouched. Soonest main card first, undated
 * last — the same order the stored query uses.
 */
export function mergeApprovedSchedules(stored: EventBroadcast[], events: ScheduleEvent[]): EventBroadcast[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  /* Same rule as getBroadcastForEvent: an UNLINKED stored row stands for an
   * approved event only when it is the one unlinked row on that date. That
   * keeps a freshly written but not-yet-linked row from appearing twice. */
  for (const e of events) {
    if (!APPROVED_SCHEDULES[e.id] || !e.event_date || stored.some((r) => r.event_id === e.id)) continue;
    const sameDate = stored.filter((r) => !r.event_id && r.event_date === e.event_date);
    if (sameDate.length === 1) byId.set(`unlinked:${sameDate[0].ufc_slug}`, e);
  }
  const linked = new Set<string>();
  const rows = stored.map((r) => {
    const e = r.event_id ? byId.get(r.event_id) : byId.get(`unlinked:${r.ufc_slug}`);
    if (!e || !APPROVED_SCHEDULES[e.id]) return r;
    linked.add(e.id);
    return resolveEventSchedule(e, r)!;
  });
  for (const e of events) {
    if (linked.has(e.id) || !APPROVED_SCHEDULES[e.id]) continue;
    const r = resolveEventSchedule(e, null);
    if (r) rows.push(r);
  }
  const key = (r: EventBroadcast) => (r.main_card_start_utc ? Date.parse(r.main_card_start_utc) : Number.POSITIVE_INFINITY);
  return rows.sort((a, b) => key(a) - key(b));
}

function slugFromUrl(u: string | undefined): string | null {
  const m = u ? /\/event\/([a-z0-9-]+)/i.exec(u) : null;
  return m ? m[1] : null;
}
