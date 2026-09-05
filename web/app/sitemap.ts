import type { MetadataRoute } from "next";
import { getAllEvents, getFighters, getArticles } from "@/lib/db";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [events, fighters, articles] = await Promise.all([getAllEvents(), getFighters("", 1000), getArticles(500)]);
  const now = new Date();
  const fixed: MetadataRoute.Sitemap = ["/", "/events", "/fighters", "/rankings", "/news", "/pro", "/about"].map((p) => ({
    url: `${SITE.url}${p}`, lastModified: now, changeFrequency: p === "/" ? "daily" : "weekly", priority: p === "/" ? 1 : 0.7,
  }));
  return [
    ...fixed,
    ...events.map((e) => ({ url: `${SITE.url}/events/${eventSlug(e)}`, lastModified: now, changeFrequency: "daily" as const, priority: 0.8 })),
    ...fighters.map((f) => ({ url: `${SITE.url}/fighters/${fighterSlug(f)}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.6 })),
    ...articles.map((a) => ({ url: `${SITE.url}/news/${a.slug}`, lastModified: new Date(a.updated_at), changeFrequency: "weekly" as const, priority: 0.6 })),
  ];
}
