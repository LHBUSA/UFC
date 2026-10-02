/* Article right rail: what follows the lead cards (bout / fighters, live wire,
 * event) so a long article does not end its rail a screen in.
 *
 * Pure and deterministic: no I/O, no model, no headline similarity. Presentation
 * only. Nothing here touches what was generated or published, and the rail never
 * repeats a story the page already links in "More from the desk".
 *
 *   freshWire          drops live-wire items too old to call live
 *   railFollowStories  same-story coverage first, then the newest distinct
 *                      developments from the desk (via clusterNewsPage)
 *   railIntelLinks     a few product destinations chosen from the story's
 *                      context, none of which the lead cards already link */
import { clusterNewsPage, developmentKey, type ClusterArticle } from "./newsClusters.ts";

export type RailStory = ClusterArticle & { slug: string; headline: string; published_at: string | null };

/* "From the live wire" is a live module. On an old story the newest headlines
 * about its fighters can be weeks old, and calling them live is wrong. */
export const RAIL_WIRE_MAX_AGE_DAYS = 14;
export const RAIL_FOLLOW_SLOTS = 4;
/* Below this many same-story pieces the desk's latest fill the rest. */
const RELATED_ALONE = 3;

const DAY = 86_400_000;

export function freshWire<T extends { published_at: string | null }>(items: T[], now: number, maxAgeDays = RAIL_WIRE_MAX_AGE_DAYS): T[] {
  return items.filter((n) => {
    const t = n.published_at ? Date.parse(n.published_at) : NaN;
    return Number.isFinite(t) && now - t <= maxAgeDays * DAY;
  });
}

/** How closely a candidate belongs to the current story: bout, then a shared fighter, then the event. */
function closeness(cur: ClusterArticle, x: ClusterArticle): number {
  if (cur.bout_id && x.bout_id === cur.bout_id) return 3;
  const mine = new Set((cur.fighter_ids || []).filter(Boolean));
  if ((x.fighter_ids || []).some((id) => mine.has(id))) return 2;
  if (cur.event_id && x.event_id === cur.event_id) return 1;
  return 0;
}

const time = (s: string | null) => (s ? Date.parse(s) || 0 : 0);

export function railFollowStories<T extends RailStory>(
  current: ClusterArticle,
  related: T[],
  latest: T[],
  excludeIds: Iterable<string>,
  slots = RAIL_FOLLOW_SLOTS,
): { related: T[]; latest: T[] } {
  const used = new Set<string>([current.id, ...excludeIds]);
  const take = (x: T) => (used.has(x.id) ? false : (used.add(x.id), true));
  const rel = related
    .map((x) => ({ x, k: closeness(current, x) }))
    .filter((r) => r.k > 0)
    .sort((p, q) => q.k - p.k || time(q.x.published_at) - time(p.x.published_at))
    .map((r) => r.x)
    .filter(take)
    .slice(0, slots);
  if (rel.length >= RELATED_ALONE) return { related: rel, latest: [] };
  /* Same rule as the newsroom fronts: distinct developments lead. The current
   * story's own development is already covered above, so it is skipped here. */
  const own = developmentKey(current);
  const need = slots - rel.length;
  const { hero, feed } = clusterNewsPage(latest.filter((x) => !used.has(x.id) && developmentKey(x) !== own), need);
  const fill = [...(hero ? [hero] : []), ...feed].filter(take).slice(0, need);
  return { related: rel, latest: fill };
}

export type IntelLink = { href: string; label: string; note: string };

/** Section destinations by story context. The lead cards already link the
 *  fighters, the matchup and the event, so none of those appear here. */
export function railIntelLinks(ctx: { storyType: string; eventDate: string | null; hasBout: boolean; now: number }): IntelLink[] {
  const upcoming = ctx.eventDate ? Date.parse(ctx.eventDate) >= ctx.now - DAY : false;
  const links: IntelLink[] = upcoming
    ? [
        { href: "/fight-week", label: "Fight Week", note: "Card, weigh-ins and how to watch" },
        ...(ctx.hasBout ? [{ href: "/simulator", label: "Fight Simulator", note: "PBE Labs · 10,000 simulated fights" }] : []),
      ]
    : [
        { href: "/round-by-round", label: "Round by round", note: "Output per round, every archived bout" },
        ...(ctx.storyType === "results" ? [{ href: "/judges", label: "Judges & scorecards", note: "How the decisions were scored" }] : []),
      ];
  links.push(
    { href: "/rankings", label: "Rankings", note: "Every division, current and historical" },
    { href: "/learn/fight-dna", label: "How Fight DNA works", note: "The traits behind every profile" },
  );
  return links.slice(0, 4);
}
