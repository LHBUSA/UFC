/* Sitemap data: complete populations, one eligibility rule set.
 *
 * The old app/sitemap.ts read fighters with a single request capped at 1,000
 * rows (3,178 exist) and listed fights only for the next six cards, although
 * the historical fight archive is the strongest organic-search surface. Every
 * population here is walked with keyset pagination (restAllRows) and is
 * strict: a failed page fails the sitemap (5xx, retried by crawlers) instead
 * of publishing a silently shorter one. */
import "server-only";
import { isContenderSeries, restAllRows } from "@/lib/db";
import { getJudgeArchive } from "@/lib/judges";
import { RETIRED_FIGHTER_SLUGS } from "@/lib/retiredFighterSlugs";
import { eventSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import { VOICES } from "@/lib/voices";
import { HOF_INDUCTEES } from "@/lib/hof";
import { seasons as tufSeasons } from "@/lib/tuf";
import {
  chunkCount, chunkOf, eligibleEvents, eligibleFighters, eligibleFights, isCleanPath, lastmodOf,
  type Eligibility, type PopBout, type PopEvent, type PopFighter, type SitemapUrl,
} from "@/lib/sitemapRules";

export const SITEMAP_REVALIDATE = 3600;

/* Public, canonical, indexable section pages. Account, login, cart, order,
 * desk preview, QA, API and store print/mockup routes are deliberately absent. */
const SECTION_PATHS = [
  "/", "/fight-week", "/events", "/fighters", "/rankings", "/news", "/round-by-round",
  "/weigh-ins", "/injuries", "/contender-series", "/contender-series/alumni",
  "/tuf", "/tuf/alumni", "/tuf/champions", "/tuf/coaches",
  "/history", "/history/gracie-influence", "/hall-of-fame",
  "/referees", "/judges", "/model", "/learn/fight-dna", "/pro", "/about", "/methodology",
];

type PopArticle = { id: string; slug: string; updated_at: string | null; published_at: string | null };
type PopReferee = { name: string; slug: string | null; bio_verified_at: string | null; last_event_date: string | null };

const abs = (path: string) => `${SITE.url}${path === "/" ? "" : path}`;

async function fighterPopulation() {
  return restAllRows<PopFighter>("ufc_fighters", "id,name,espn_athlete_id,ufcstats_id", "id", "", SITEMAP_REVALIDATE);
}
async function eventPopulation() {
  return restAllRows<PopEvent>("ufc_events", "id,name,event_date", "id", "", SITEMAP_REVALIDATE);
}
async function boutPopulation() {
  return restAllRows<PopBout>("ufc_bouts", "id,event_id,status,bout_order,fighter_a_id,fighter_b_id", "id", "", SITEMAP_REVALIDATE);
}

export async function fighterEligibility(): Promise<Eligibility & { population: number }> {
  const fighters = await fighterPopulation();
  return { ...eligibleFighters(fighters, RETIRED_FIGHTER_SLUGS.map((r) => r.retiredSourceId)), population: fighters.length };
}

export async function fightEligibility(): Promise<Eligibility & { population: number }> {
  const [fighters, events, bouts] = await Promise.all([fighterPopulation(), eventPopulation(), boutPopulation()]);
  return { ...eligibleFights(events, bouts, fighters), population: bouts.length };
}

export async function eventUrls(): Promise<SitemapUrl[]> {
  const [events, bouts] = await Promise.all([eventPopulation(), boutPopulation()]);
  const { paths } = eligibleEvents(events);
  const withBouts = new Set(bouts.filter((b) => b.status !== "cancelled").map((b) => b.event_id));
  /* Pregame Desk pages: upcoming UFC cards plus the twelve most recent, the
   * same selection as before, limited to cards that have bouts (an empty desk
   * is a placeholder, not a page). Contender Series weeks have no desk. */
  const today = new Date().toISOString().slice(0, 10);
  const desk = events.filter((e) => e.event_date && !isContenderSeries(e.name) && withBouts.has(e.id));
  const upcoming = desk.filter((e) => e.event_date! >= today);
  const recent = desk.filter((e) => e.event_date! < today).sort((a, b) => b.event_date!.localeCompare(a.event_date!)).slice(0, 12);
  const pregame = [...upcoming, ...recent].map((e) => `/pregame/${eventSlug(e)}`).filter(isCleanPath);
  return [...paths, ...new Set(pregame)].map((p) => ({ loc: abs(p) }));
}

export async function newsUrls(): Promise<SitemapUrl[]> {
  const rows = await restAllRows<PopArticle>("ufc_articles", "id,slug,updated_at,published_at", "id", "&status=eq.published", SITEMAP_REVALIDATE);
  const seen = new Set<string>();
  const out: SitemapUrl[] = [];
  for (const a of rows) {
    const path = `/news/${a.slug}`;
    if (!isCleanPath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({ loc: abs(path), lastmod: lastmodOf(a.updated_at || a.published_at) });
  }
  return out;
}

export async function officialUrls(): Promise<SitemapUrl[]> {
  const [referees, archive] = await Promise.all([
    /* Keyset on name: the directory is one row per canonical referee name. */
    restAllRows<PopReferee>("ufc_referee_directory", "name,slug,bio_verified_at,last_event_date", "name", "", SITEMAP_REVALIDATE),
    getJudgeArchive(),
  ]);
  /* A judge list built from a partially failed scorecard walk would drop
   * officials; fail instead. */
  if (!archive.complete) throw new Error("[sitemap] judge archive incomplete");
  const out: SitemapUrl[] = [];
  const seen = new Set<string>();
  const add = (path: string, lastmod: string | null) => {
    if (!isCleanPath(path) || seen.has(path)) return;
    seen.add(path);
    out.push({ loc: abs(path), lastmod });
  };
  /* A directory row without a slug has no profile page. */
  for (const r of referees) if (r.slug) add(`/referees/${r.slug}`, lastmodOf(r.bio_verified_at || r.last_event_date));
  for (const j of archive.judges) add(`/judges/${j.slug}`, lastmodOf(j.lastEventDate));
  return out;
}

export function pageUrls(): SitemapUrl[] {
  const paths = [
    ...SECTION_PATHS,
    ...HOF_INDUCTEES.map((h) => `/hall-of-fame/${h.slug}`),
    ...VOICES.map((v) => `/voices/${v.key}`),
    ...tufSeasons().map((s) => `/tuf/${s.slug}`),
  ];
  return [...new Set(paths)].filter((p) => p === "/" || isCleanPath(p)).map((p) => ({ loc: abs(p) }));
}

/* Child sitemap names, in index order. Chunk counts come from the same
 * eligibility the children render, so the index never lists an empty file. */
export async function sitemapFiles(): Promise<string[]> {
  const [fighters, fights] = await Promise.all([fighterEligibility(), fightEligibility()]);
  return [
    "pages.xml", "events.xml", "news.xml", "officials.xml",
    ...Array.from({ length: chunkCount(fighters.paths.length) }, (_, i) => `fighters-${i + 1}.xml`),
    ...Array.from({ length: chunkCount(fights.paths.length) }, (_, i) => `fights-${i + 1}.xml`),
  ];
}

export async function sitemapChild(file: string): Promise<SitemapUrl[] | null> {
  if (file === "pages.xml") return pageUrls();
  if (file === "events.xml") return eventUrls();
  if (file === "news.xml") return newsUrls();
  if (file === "officials.xml") return officialUrls();
  const m = file.match(/^(fighters|fights)-([1-9]\d*)\.xml$/);
  if (!m) return null;
  const all = m[1] === "fighters" ? await fighterEligibility() : await fightEligibility();
  const n = Number(m[2]);
  if (n > chunkCount(all.paths.length)) return null;
  return chunkOf(all.paths, n).map((p) => ({ loc: abs(p) }));
}
