import "server-only";
import { cache } from "react";

import { getRankings } from "@/lib/db";
import { buildRankingIndex, type RankingIndex } from "@/lib/rankingContext";

/* The one server-side ranking resolver.
 *
 * Every surface that wants to know whether a fighter is ranked asks this and
 * nothing else. The point is not convenience, it is agreement: before this
 * existed, /rankings read the snapshot one way and the desk packet derived a
 * rank string another way, which is exactly how two surfaces come to disagree
 * about the same official fact.
 *
 * React `cache` dedupes within a render pass, so an event page with 13 bouts
 * and 26 fighters performs ONE snapshot read and 26 map lookups. The snapshot
 * itself is a single cached JSON document, so there is no per-fighter query
 * to accidentally turn into an N+1 in the first place.
 *
 * Fails closed. If the snapshot cannot be read, this returns null and every
 * badge renders nothing — rankings are never inferred from historical data,
 * and an absent snapshot shows as absence rather than as "unranked".
 */
export const getRankingIndex = cache(async (): Promise<RankingIndex | null> => {
  const snap = await getRankings().catch(() => null);
  return buildRankingIndex(snap);
});

/** Convenience for the common case: just the map, or an empty one. */
export const getRankingMap = cache(async () => {
  const index = await getRankingIndex();
  return index?.byFighter ?? new Map();
});
