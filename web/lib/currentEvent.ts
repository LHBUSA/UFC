import "server-only";

import { getEventById, getNextEvent, type Event } from "@/lib/db";
import { getNextBroadcast } from "@/lib/broadcast";

/**
 * Canonical consumer-facing UFC card selector.
 *
 * During a real broadcast window, the active broadcast owns the product even
 * if the calendar has crossed midnight UTC or a date query/cache would
 * otherwise advance to the next card. Only after that window closes do we
 * fall back to the next scheduled UFC event.
 */
export async function getCurrentOrNextUfcEvent(now = Date.now()): Promise<Event | null> {
  try {
    const broadcast = await getNextBroadcast(now, 0);
    if (broadcast?.event_id) {
      const event = await getEventById(broadcast.event_id);
      if (event) return event;
    }
  } catch {
    // The schedule/date path remains the fail-open fallback.
  }
  return getNextEvent();
}
