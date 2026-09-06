import type { MetadataRoute } from "next";
import { getAllEvents, getFighters, getArticles, getUpcomingEvents, getEventBouts } from "@/lib/db";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [events, fighters, articles, upcoming] = await Promise.all([getAllEvents(), getFighters("", 1000), getArticles(500), getUpcomingEvents(6, { includeContenderSeries: true })]);
  const now = new Date();
  const fixed: MetadataRoute.Sitemap = ["/", "/events", "/fighters", "/rankings", "/news", "/pro", "/about"].map((p) => ({
    url: `${SITE.url}${p}`, lastModified: now, changeFrequency: p === "/" || p === "/news" ? "hourly" : "daily", priority: p === "/" ? 1 : 0.8,
  }));
  const today = now.toISOString().slice(0, 10);
  /* Matchup pages for the announced cards: the primary SEO surface. */
  const fights: MetadataRoute.Sitemap = [];
  for (const e of upcoming) {
    const bouts = await getEventBouts(e.id);
    for (const b of bouts) fights.push({ url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`, lastModified: now, changeFrequency: "daily", priority: 0.8 });
  }
  return [
    ...fixed,
    ...events.map((e) => ({ url: `${SITE.url}/events/${eventSlug(e)}`, lastModified: now, changeFrequency: (e.event_date && e.event_date >= today ? "daily" : "monthly") as "daily" | "monthly", priority: e.event_date && e.event_date >= today ? 0.9 : 0.6 })),
    ...fights,
    ...fighters.rows.map((f) => ({ url: `${SITE.url}/fighters/${fighterSlug(f)}`, lastModified: now, changeFrequency: "weekly" as const, priority: f.is_active ? 0.7 : 0.5 })),
    ...articles.rows.map((a) => ({ url: `${SITE.url}/news/${a.slug}`, lastModified: new Date(a.updated_at), changeFrequency: "weekly" as const, priority: 0.7 })),
  ];
}
