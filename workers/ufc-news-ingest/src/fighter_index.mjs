/* The fighter index for entity linking, loaded only when it is needed and
 * reused while the roster has not changed.
 *
 * Until 2026-10-07 every two-minute run loaded the whole index (24 columns of
 * ufc_fighters, every alias) and then linked EVERY parsed item against it,
 * including the hundreds that were already in ufc_news_items and were about to
 * be discarded as duplicates. The linking, not the load, was almost all of the
 * Worker's ~10 s of CPU per run. runIngest now links only items the database
 * does not already have, and asks for the index only when there is at least
 * one; this module makes that request cheap when the roster is unchanged.
 *
 * Shape: identical to loadFighterIndex() in scripts/news/lib.mjs
 * ({ fighters, byId, aliasesByFighter, resolver }), because linkEntities and
 * findFighterMentions read it. lib.mjs is shared with other (frozen) Workers
 * and scripts, so it is deliberately left untouched and this is a local copy.
 *
 * Columns: the ingest path reads only fighter `id` and `name` and alias
 * `fighter_id` and `alias`:
 *   - findFighterMentions: f.id, f.name, aliasesByFighter, resolver.resolve(raw, 'news')
 *   - linkEntities: index.byId.get(...).id / .name
 *   - AliasResolver.resolve with no second keys (no ufcstats_id, dob, record,
 *     weight_class) never reads those fields of a fighter, so they cannot
 *     change a result. fighter_index.test.mjs proves the parity.
 *
 * Freshness: the cached copy is keyed by a version probe - row count plus
 * max(updated_at) of ufc_fighters and row count plus max(created_at) of
 * ufc_fighter_aliases, two one-row requests. Neither table has an update
 * trigger, so an in-place rename that does not touch updated_at, or an alias
 * edited in place, is invisible to the probe; RECONCILE_MS forces a full
 * reload regardless, so such an edit is picked up within that bound. A failed
 * probe is treated as "changed" and reloads.
 */
import { AliasResolver } from '../../../shared/alias_resolver.mjs';

export const RECONCILE_MS = 60 * 60 * 1000;

const FIGHTER_QUERY = 'select=id,name&order=id.asc';
const ALIAS_QUERY = 'select=fighter_id,alias&order=id.asc';

/** Build the index from rows. Same construction as lib.mjs loadFighterIndex. */
export function buildFighterIndex(fighters, aliases) {
  const aliasesByFighter = new Map();
  for (const a of aliases) {
    if (!aliasesByFighter.has(a.fighter_id)) aliasesByFighter.set(a.fighter_id, []);
    aliasesByFighter.get(a.fighter_id).push(a.alias);
  }
  const resolver = new AliasResolver(fighters.map((f) => ({
    id: f.id,
    name: f.name,
    aliases: aliasesByFighter.get(f.id) || [],
  })));
  const byId = new Map(fighters.map((f) => [f.id, f]));
  return { fighters, byId, aliasesByFighter, resolver };
}

export async function loadLeanFighterIndex(sb) {
  const [fighters, aliases] = await Promise.all([
    sb.select('ufc_fighters', FIGHTER_QUERY),
    sb.select('ufc_fighter_aliases', ALIAS_QUERY),
  ]);
  return buildFighterIndex(fighters, aliases);
}

async function rosterVersion(sb) {
  if (typeof sb.countAndMax !== 'function') return null;
  const [f, a] = await Promise.all([
    sb.countAndMax('ufc_fighters', 'updated_at'),
    sb.countAndMax('ufc_fighter_aliases', 'created_at'),
  ]);
  if (!f || !a) return null;
  return `${f.count}|${f.max}|${a.count}|${a.max}`;
}

/** Isolate-scoped cache. Cron invocations often share an isolate; when they
 * do not, the cost is one normal load. */
let cache = null;

export function resetFighterIndexCache() { cache = null; }

/**
 * The index for this run, and how it was obtained ('cached' | 'loaded').
 * `stats` is optional and receives { index_source, index_version }.
 */
export async function getFighterIndex(sb, { now = Date.now(), stats = null } = {}) {
  const version = await rosterVersion(sb);
  const fresh = cache && version !== null && cache.version === version && (now - cache.loadedAt) < RECONCILE_MS;
  if (!fresh) {
    const index = await loadLeanFighterIndex(sb);
    cache = { index, version, loadedAt: now };
  }
  if (stats) { stats.index_source = fresh ? 'cached' : 'loaded'; stats.index_version = version; }
  return cache.index;
}
