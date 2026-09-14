/* Sitemap eligibility. Run: npm run test:sitemap
 *
 * A URL belongs in the sitemap only if its page answers 200, is indexable and
 * names itself as canonical. For database entities that is decided by
 * replaying the page's own slug resolution (lib/slug.ts, lib/resolve.ts)
 * against the full population, so every emitted URL is one the route will
 * resolve to that same entity, and every skipped row has a named reason.
 *
 * Pure: node:test loads it directly. */
import { eventSlug, fighterSlug, matchupSlug, slugify } from "./slug.ts";

/* The protocol allows 50,000 URLs and 50 MB per file. 5,000 keeps each child
 * small enough to render quickly and to re-fetch cheaply, and segments the two
 * large populations (fights, fighters) as they grow. */
export const SITEMAP_CHUNK = 5000;
export const PROTOCOL_MAX_URLS = 50000;

export type PopFighter = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
export type PopEvent = { id: string; name: string; event_date: string | null };
export type PopBout = { id: string; event_id: string; status: string | null; bout_order: number | null; fighter_a_id: string; fighter_b_id: string };
export type Eligibility = { paths: string[]; excluded: Record<string, number> };

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] || 0) + 1; };

/* A sitemap path is lower-case slug segments only: no query, no fragment, no
 * trailing slash, no empty segment and no serialised null/undefined. */
export function isCleanPath(path: string): boolean {
  return /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(path)
    && !/(^|\/|-)(null|undefined|nan)(\/|-|$)/.test(path);
}

/* /fighters/[slug]: the id is the last dash token matching [0-9a-z]{6,20};
 * the lookup is `espn_athlete_id = id OR ufcstats_id = id LIMIT 1`, so the id
 * must belong to exactly one row; a slug whose id was retired by an identity
 * merge is a config redirect, not a page. */
export function eligibleFighters(fighters: PopFighter[], retiredSourceIds: Iterable<string>): Eligibility {
  const retired = new Set(retiredSourceIds);
  const owners = new Map<string, number>();
  for (const f of fighters) for (const v of new Set([f.espn_athlete_id, f.ufcstats_id].filter(Boolean) as string[])) owners.set(v, (owners.get(v) || 0) + 1);
  const excluded: Record<string, number> = {};
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const f of fighters) {
    const id = f.espn_athlete_id || f.ufcstats_id;
    if (!slugify(f.name)) { bump(excluded, "empty_name_slug"); continue; }
    if (!id) { bump(excluded, "no_source_id"); continue; }
    const slug = fighterSlug(f);
    if (slug.match(/-([0-9a-z]{6,20})$/)?.[1] !== id) { bump(excluded, "unresolvable_source_id"); continue; }
    if (owners.get(id) !== 1) { bump(excluded, "source_id_shared_by_rows"); continue; }
    if (retired.has(id)) { bump(excluded, "retired_slug_redirects"); continue; }
    const path = `/fighters/${slug}`;
    if (!isCleanPath(path)) { bump(excluded, "malformed_slug"); continue; }
    if (seen.has(path)) { bump(excluded, "duplicate_slug"); continue; }
    seen.add(path);
    paths.push(path);
  }
  return { paths, excluded };
}

/* /events/[slug]: resolved by date, then exact slug. */
export function eligibleEvents(events: PopEvent[]): Eligibility {
  const excluded: Record<string, number> = {};
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const e of events) {
    if (!e.event_date) { bump(excluded, "no_event_date"); continue; }
    if (!slugify(e.name)) { bump(excluded, "empty_name_slug"); continue; }
    const path = `/events/${eventSlug(e)}`;
    if (!isCleanPath(path)) { bump(excluded, "malformed_slug"); continue; }
    if (seen.has(path)) { bump(excluded, "duplicate_slug"); continue; }
    seen.add(path);
    paths.push(path);
  }
  return { paths, excluded };
}

/* /fights/[slug]: replays resolveFight. For each event on the slug's date,
 * bouts in bout_order desc: an exact match in either corner order, else a
 * name-prefix match. The URL is emitted only when exactly one event answers
 * and the bout it answers with has this slug as its canonical. */
export function eligibleFights(events: PopEvent[], bouts: PopBout[], fighters: PopFighter[]): Eligibility {
  const F = new Map(fighters.map((f) => [f.id, f]));
  const E = new Map(events.map((e) => [e.id, e]));
  const byDate = new Map<string, PopEvent[]>();
  for (const e of events) if (e.event_date) byDate.set(e.event_date, [...(byDate.get(e.event_date) || []), e]);
  type Named = PopBout & { fa: PopFighter; fb: PopFighter };
  const boutsByEvent = new Map<string, Named[]>();
  for (const b of bouts) {
    const fa = F.get(b.fighter_a_id), fb = F.get(b.fighter_b_id);
    if (!fa || !fb) continue;
    boutsByEvent.set(b.event_id, [...(boutsByEvent.get(b.event_id) || []), { ...b, fa, fb }]);
  }
  for (const list of boutsByEvent.values()) list.sort((x, y) => (y.bout_order ?? 0) - (x.bout_order ?? 0));

  const resolve = (slug: string, date: string) => {
    const hits: Array<{ e: PopEvent; b: Named }> = [];
    for (const e of byDate.get(date) || []) {
      const list = boutsByEvent.get(e.id) || [];
      const hit = list.find((b) => matchupSlug(b.fa, b.fb, e) === slug || matchupSlug(b.fb, b.fa, e) === slug)
        || list.find((b) => slug.startsWith(`${slugify(b.fa.name)}-vs-${slugify(b.fb.name)}`) || slug.startsWith(`${slugify(b.fb.name)}-vs-${slugify(b.fa.name)}`));
      if (hit) hits.push({ e, b: hit });
    }
    return hits;
  };

  const excluded: Record<string, number> = {};
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const b of bouts) {
    const e = E.get(b.event_id);
    const fa = F.get(b.fighter_a_id), fb = F.get(b.fighter_b_id);
    if (!e) { bump(excluded, "no_event_row"); continue; }
    if (!e.event_date) { bump(excluded, "no_event_date"); continue; }
    if (!fa || !fb) { bump(excluded, "missing_fighter_row"); continue; }
    if (b.status === "cancelled") { bump(excluded, "cancelled_bout"); continue; }
    if (!slugify(fa.name) || !slugify(fb.name) || !slugify(e.name)) { bump(excluded, "empty_name_slug"); continue; }
    const slug = matchupSlug(fa, fb, e);
    const path = `/fights/${slug}`;
    if (seen.has(path)) { bump(excluded, "duplicate_slug"); continue; }
    if (!isCleanPath(path)) { bump(excluded, "malformed_slug"); continue; }
    const hits = resolve(slug, e.event_date);
    if (hits.length !== 1) { bump(excluded, hits.length ? "ambiguous_across_same_day_events" : "unresolvable"); continue; }
    if (matchupSlug(hits[0].b.fa, hits[0].b.fb, hits[0].e) !== slug) { bump(excluded, "resolves_to_other_canonical"); continue; }
    seen.add(path);
    paths.push(path);
  }
  return { paths, excluded };
}

export function chunkCount(n: number, size = SITEMAP_CHUNK): number {
  return Math.max(1, Math.ceil(n / size));
}

export function chunkOf<T>(list: T[], index1: number, size = SITEMAP_CHUNK): T[] {
  return list.slice((index1 - 1) * size, index1 * size);
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export type SitemapUrl = { loc: string; lastmod?: string | null };

/* lastmod is written only where the source records a real modification date;
 * a build or request time would claim every URL changed on every fetch. */
export function urlsetXml(urls: SitemapUrl[]): string {
  if (urls.length > PROTOCOL_MAX_URLS) throw new Error(`sitemap child has ${urls.length} URLs (max ${PROTOCOL_MAX_URLS})`);
  const body = urls.map((u) => `<url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${xmlEscape(u.lastmod)}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function sitemapIndexXml(locs: string[]): string {
  const body = locs.map((loc) => `<sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/* A W3C date (YYYY-MM-DD or full ISO) or null. */
export function lastmodOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
