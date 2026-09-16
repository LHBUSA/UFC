/* Publisher-controlled fallback feeds for sources whose site-wide RSS endpoint
 * can stay HTTP-healthy while its article list stops advancing.
 *
 * These are not alternate publishers or scraped third parties. They are RSS
 * links exposed by the publishers on current author profile pages. Ingest uses
 * them only when the primary source body is stale, preserving the cheap primary
 * feed path in normal operation while removing one stale endpoint as a single
 * point of failure.
 */

export const SOURCE_BODY_MAX_AGE_HOURS = 24;
export const SOURCE_BODY_MAX_AGE_MS = SOURCE_BODY_MAX_AGE_HOURS * 60 * 60 * 1000;

export const RSS_FALLBACKS = Object.freeze({
  'MMA Fighting': Object.freeze([
    'https://www.mmafighting.com/authors/damon-martin/rss',
    'https://www.mmafighting.com/authors/guilherme-cruz/rss',
    'https://www.mmafighting.com/authors/jed-meshew-2/rss',
    'https://www.mmafighting.com/authors/alex-lee/rss',
  ]),
  'MMA Mania': Object.freeze([
    'https://www.mmamania.com/authors/andrew-richardson/rss',
    'https://www.mmamania.com/authors/jesse-holland/rss',
    'https://www.mmamania.com/authors/ryan-harkness/rss',
    'https://www.mmamania.com/authors/alexander-behunin/rss',
    'https://www.mmamania.com/authors/dan-hiergesell/rss',
  ]),
});

export function fallbackUrlsFor(sourceName) {
  return RSS_FALLBACKS[sourceName] || [];
}
