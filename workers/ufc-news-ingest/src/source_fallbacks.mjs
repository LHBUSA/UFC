/* Publisher-controlled fallback inputs for sources whose site-wide RSS endpoint
 * can stay HTTP-healthy while its article list stops advancing.
 *
 * These are not alternate publishers or scraped third parties. RSS fallbacks
 * are author feeds exposed by the same publisher. Latest-page fallbacks are the
 * publisher's own current-news index. Ingest uses them only when the primary
 * source body is stale, preserving the cheap primary-feed path in normal
 * operation while removing one frozen site-wide endpoint as a single point of
 * failure.
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
    'https://www.mmamania.com/authors/ryan-harkness-mma-news-writer/rss',
    'https://www.mmamania.com/authors/jesse-holland-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2/rss',
    'https://www.mmamania.com/authors/alexbehunin-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2/rss',
    'https://www.mmamania.com/authors/dan-hiergesell-ufc-highlights/rss',
  ]),
});

export const LATEST_PAGES = Object.freeze({
  'MMA Fighting': 'https://www.mmafighting.com/latest-news',
  'MMA Mania': 'https://www.mmamania.com/latest-news',
});

export function fallbackUrlsFor(sourceName) {
  return RSS_FALLBACKS[sourceName] || [];
}

export function fallbackPageFor(sourceName) {
  return LATEST_PAGES[sourceName] || null;
}
