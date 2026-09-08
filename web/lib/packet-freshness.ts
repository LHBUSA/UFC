/**
 * Whether a checked-in enrichment packet still describes the record we hold.
 *
 * Its own module, with no imports, for two reasons. It is the one piece of
 * this logic that has to be directly testable — enrichment.ts pulls in the
 * generated JSON through a path alias that a bare test runner cannot resolve —
 * and keeping it dependency-free means the guard can be used from anywhere
 * without dragging the whole enrichment layer along.
 */

/**
 * Are a packet's archive metrics still describing this referee?
 *
 * Packets are committed to the repository; bout counts come from the live
 * database. Those drift apart, and merging two referee identities guarantees
 * it: when "Eric McMahon" absorbed a duplicate spelling his live record went
 * 26 -> 29 while the committed packet went on saying 26. The page then showed
 * a 29-assignment headline above a distribution computed over 26 — which is
 * not so much a stale number as two different referees on one page.
 *
 * Regenerating the packet fixes an instance. Withholding metrics that do not
 * match closes the class. The headline reads the database directly and is
 * always right; the packet is the part that can go stale, so the packet is the
 * part that gets held back.
 *
 * Anything unknown counts as not current. Showing nothing is a visible gap;
 * showing a distribution over an unknown sample is an invisible claim.
 */
export function packetMetricsAreCurrent(
  packet: { metrics?: { sample_bouts?: number } | null } | null | undefined,
  liveBouts: number | null | undefined,
): boolean {
  const sample = packet?.metrics?.sample_bouts;
  if (typeof sample !== "number" || typeof liveBouts !== "number") return false;
  return sample === liveBouts;
}
