import type { MetadataRoute } from "next";
import { getAllEvents, getFighters, getArticles, getUpcomingEvents, getEventBouts, getRecentEvents, isContenderSeries } from "@/lib/db";
import { getReferees } from "@/lib/referees";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import { VOICES } from "@/lib/voices";
import { HOF_INDUCTEES } from "@/lib/hof";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [events, fighters, articles, upcoming, referees, recent] = await Promise.all([
    getAllEvents(),
    getFighters("", 1000),
    getArticles(500),
    getUpcomingEvents(6, { includeContenderSeries: true }),
    getReferees(250),
    getRecentEvents(12),
  ]);
  const now = new Date();
  const fixedPaths = ["/", "/fight-week", "/learn/fight-dna", "/hall-of-fame", "/history", "/events", "/fighters", "/rankings", "/referees", "/news", "/contender-series", "/pro", "/about", "/methodology"];
  const fixed: MetadataRoute.Sitemap = fixedPaths.map((p) => ({
    url: `${SITE.url}${p}`,
    lastModified: now,
    changeFrequency: p === "/" || p === "/news" || p === "/contender-series" || p === "/fight-week" ? "hourly" : "daily",
    priority: p === "/" ? 1 : p === "/news" || p === "/events" || p === "/contender-series" || p === "/fight-week" ? 0.9 : 0.8,
  }));
  const voicePages: MetadataRoute.Sitemap = VOICES.map((voice) => ({
    url: `${SITE.url}/voices/${voice.key}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.65,
  }));
  const refereePages: MetadataRoute.Sitemap = referees.map((referee) => ({
    url: `${SITE.url}/referees/${referee.slug}`,
    lastModified: referee.bio_verified_at || referee.last_event_date ? new Date(referee.bio_verified_at || `${referee.last_event_date}T00:00:00Z`) : now,
    changeFrequency: "weekly",
    priority: referee.bouts >= 50 ? 0.7 : 0.55,
  }));
  const today = now.toISOString().slice(0, 10);
  /* Matchup pages for the announced cards: the primary SEO surface. */
  const fights: MetadataRoute.Sitemap = [];
  for (const e of upcoming) {
    const bouts = await getEventBouts(e.id);
    for (const b of bouts) fights.push({ url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`, lastModified: now, changeFrequency: "daily", priority: 0.8 });
  }
  /* Permanent Pregame Desk pages: upcoming UFC cards plus the recent archive. */
  const pregame: MetadataRoute.Sitemap = [...upcoming.filter((e) => !isContenderSeries(e.name)), ...recent].map((e) => ({ url: `${SITE.url}/pregame/${eventSlug(e)}`, lastModified: now, changeFrequency: (e.event_date && e.event_date >= today ? "daily" : "monthly") as "daily" | "monthly", priority: e.event_date && e.event_date >= today ? 0.85 : 0.5 }));
  const hof: MetadataRoute.Sitemap = HOF_INDUCTEES.map((h) => ({ url: `${SITE.url}/hall-of-fame/${h.slug}`, lastModified: now, changeFrequency: "yearly" as const, priority: 0.55 }));
  return [
    ...fixed,
    ...pregame,
    ...hof,
    ...voicePages,
    ...refereePages,
    ...events.map((e) => ({ url: `${SITE.url}/events/${eventSlug(e)}`, lastModified: now, changeFrequency: (e.event_date && e.event_date >= today ? "daily" : "monthly") as "daily" | "monthly", priority: e.event_date && e.event_date >= today ? 0.9 : 0.6 })),
    ...fights,
    ...fighters.rows.map((f) => ({ url: `${SITE.url}/fighters/${fighterSlug(f)}`, lastModified: now, changeFrequency: "weekly" as const, priority: f.is_active ? 0.7 : 0.5 })),
    ...articles.rows.map((a) => ({ url: `${SITE.url}/news/${a.slug}`, lastModified: new Date(a.updated_at), changeFrequency: "weekly" as const, priority: 0.75 })),
  ];
}
