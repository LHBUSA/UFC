/* Slug → entity resolution shared by pages, their route gates and OG image
 * routes. Every read is strict: null means the entity genuinely does not
 * exist, and an upstream failure throws (5xx) instead of posing as a 404. */
import "server-only";
import { getEventsOnDate, getEventBouts, getFighterBySourceId, type Bout, type Event, type Fighter } from "@/lib/db";
import { eventDateFromSlug, eventSlug, fighterIdFromSlug, matchupSlug, slugify } from "@/lib/slug";

export async function resolveEvent(slug: string): Promise<Event | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date, true);
  return events.find((e) => eventSlug(e) === slug) || events[0] || null;
}

export async function resolveFight(slug: string): Promise<{ e: Event; b: Bout; bouts: Bout[] } | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date, true);
  for (const e of events) {
    const bouts = await getEventBouts(e.id, undefined, true);
    const hit = bouts.find((b) => matchupSlug(b.fighter_a, b.fighter_b, e) === slug || matchupSlug(b.fighter_b, b.fighter_a, e) === slug);
    if (hit) return { e, b: hit, bouts };
    const loose = bouts.find((b) => slug.startsWith(`${slugify(b.fighter_a.name)}-vs-${slugify(b.fighter_b.name)}`) || slug.startsWith(`${slugify(b.fighter_b.name)}-vs-${slugify(b.fighter_a.name)}`));
    if (loose) return { e, b: loose, bouts };
  }
  return null;
}

export async function resolveFighter(slug: string): Promise<Fighter | null> {
  const id = fighterIdFromSlug(slug);
  return id ? getFighterBySourceId(id, true) : null;
}
