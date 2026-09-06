/* Slug → entity resolution shared by pages and their OG image routes. */
import "server-only";
import { getEventsOnDate, getEventBouts, getFighterBySourceId, type Bout, type Event, type Fighter } from "@/lib/db";
import { eventDateFromSlug, eventSlug, fighterIdFromSlug, matchupSlug, slugify } from "@/lib/slug";

export async function resolveEvent(slug: string): Promise<Event | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date);
  return events.find((e) => eventSlug(e) === slug) || events[0] || null;
}

export async function resolveFight(slug: string): Promise<{ e: Event; b: Bout; bouts: Bout[] } | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date);
  for (const e of events) {
    const bouts = await getEventBouts(e.id);
    const hit = bouts.find((b) => matchupSlug(b.fighter_a, b.fighter_b, e) === slug || matchupSlug(b.fighter_b, b.fighter_a, e) === slug);
    if (hit) return { e, b: hit, bouts };
    const loose = bouts.find((b) => slug.startsWith(`${slugify(b.fighter_a.name)}-vs-${slugify(b.fighter_b.name)}`) || slug.startsWith(`${slugify(b.fighter_b.name)}-vs-${slugify(b.fighter_a.name)}`));
    if (loose) return { e, b: loose, bouts };
  }
  return null;
}

export async function resolveFighter(slug: string): Promise<Fighter | null> {
  const id = fighterIdFromSlug(slug);
  return id ? getFighterBySourceId(id) : null;
}
