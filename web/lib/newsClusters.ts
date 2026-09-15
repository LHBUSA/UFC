/* News index development clustering. Pure and deterministic: no I/O, no
 * headline similarity, no model. Presentation only: every article on the page
 * is still rendered and linked; nothing is hidden, merged or redirected.
 *
 * A "development" is identified from authoritative ids, strongest first:
 *   bout_id                      same bout
 *   fighter_ids (set)            same fighter(s), no bout attached
 *   event_id + story_type        same event and kind, no bout or fighter
 *   article id                   otherwise its own development
 *
 * The first PRIMARY_SLOTS cards (hero included) prefer distinct developments.
 * Articles displaced from those slots:
 *   - that belong to the hero's development -> "More on this story" under the hero
 *   - any other development -> kept in the feed after the primary slots, never
 *     adjacent to another card of the same development where avoidable. */

export type ClusterArticle = { id: string; bout_id: string | null; event_id: string | null; fighter_ids: string[] | null; story_type: string };

export const PRIMARY_SLOTS = 6;

export function developmentKey(a: ClusterArticle): string {
  if (a.bout_id) return `bout:${a.bout_id}`;
  const fighters = [...new Set((a.fighter_ids || []).filter(Boolean))].sort();
  if (fighters.length) return `fighters:${fighters.join("+")}`;
  if (a.event_id) return `event:${a.event_id}:${a.story_type}`;
  return `article:${a.id}`;
}

/** Stable reorder so no two neighbours share a development when another order exists. */
function spreadAdjacent<T extends ClusterArticle>(items: T[], previousKey: string | null): T[] {
  const pool = [...items];
  const out: T[] = [];
  let last = previousKey;
  while (pool.length) {
    const i = pool.findIndex((a) => developmentKey(a) !== last);
    const pick = pool.splice(i === -1 ? 0 : i, 1)[0];
    out.push(pick);
    last = developmentKey(pick);
  }
  return out;
}

export function clusterNewsPage<T extends ClusterArticle>(rows: T[], slots = PRIMARY_SLOTS): { hero: T | null; heroRelated: T[]; feed: T[] } {
  if (!rows.length) return { hero: null, heroRelated: [], feed: [] };
  const hero = rows[0];
  const heroKey = developmentKey(hero);
  const primary: T[] = [hero];
  const used = new Set([heroKey]);
  const heroRelated: T[] = [];
  const displaced: T[] = [];
  const later: T[] = [];
  for (const a of rows.slice(1)) {
    const k = developmentKey(a);
    if (k === heroKey) { heroRelated.push(a); continue; }
    if (primary.length < slots && !used.has(k)) { primary.push(a); used.add(k); continue; }
    if (primary.length < slots) { displaced.push(a); continue; }
    later.push(a);
  }
  /* Thin inventory: fill any empty primary slots from displaced, in order. */
  while (primary.length < slots && displaced.length) primary.push(displaced.shift()!);
  const rest = spreadAdjacent([...displaced, ...later].sort((x, y) => rows.indexOf(x) - rows.indexOf(y)), developmentKey(primary[primary.length - 1]));
  return { hero, heroRelated, feed: [...primary.slice(1), ...rest] };
}
