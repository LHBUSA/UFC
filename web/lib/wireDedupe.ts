export type WireDevelopmentItem = {
  title?: string | null;
  topic_signature?: string | null;
  event_id?: string | null;
  bout_id?: string | null;
  fighter_ids?: string[] | null;
  taxonomy?: { labels?: string[]; matched?: string[] } | null;
};

/* Shared semantic key for both the public Cloudflare wire and the first-party
 * site rail/sidebar. Generic UFC event result hubs (main card results,
 * prelims results, scorecards) are one development. Fighter/bout-specific
 * result stories, weigh-in results and other event context stay independent. */
export function wireDevelopmentKey(item: WireDevelopmentItem): string | null {
  if (item.topic_signature) return `topic:${item.topic_signature}`;

  const taxonomy = item.taxonomy && typeof item.taxonomy === "object" ? item.taxonomy : {};
  const labels = Array.isArray(taxonomy.labels) ? taxonomy.labels.filter(Boolean) : [];
  const matched = Array.isArray(taxonomy.matched) ? taxonomy.matched.filter(Boolean) : [];
  const fighterIds = Array.isArray(item.fighter_ids) ? item.fighter_ids.filter(Boolean) : [];

  const isEventResultsHub =
    Boolean(item.event_id) &&
    !item.bout_id &&
    fighterIds.length === 0 &&
    labels.includes("result") &&
    matched.some((m) => m === "result:results" || m === "result:scorecards");

  return isEventResultsHub ? `event-result-hub:${item.event_id}` : null;
}
