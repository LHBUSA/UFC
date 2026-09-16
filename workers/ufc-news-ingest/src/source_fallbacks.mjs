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

const HTML_ENTITIES = Object.freeze({
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
});

function decodeHtml(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m);
}

function visibleText(s) {
  return decodeHtml(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function samePublisherArticleUrl(href, pageUrl) {
  try {
    const base = new URL(pageUrl);
    const u = new URL(decodeHtml(href), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = (h) => h.replace(/^www\./i, '').toLowerCase();
    if (host(u.hostname) !== host(base.hostname)) return null;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/latest-news') return null;
    if (/\/(?:authors?|login|signup|search|rss|about|contact|masthead|community-guidelines|privacy|terms|pages)(?:\/|$)/i.test(path)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function validHeadline(title) {
  const t = String(title || '').trim();
  if (t.length < 18 || t.length > 320) return false;
  if (t.split(/\s+/).length < 3) return false;
  if (/^(?:latest news|latest ufc\/mma news|read more|next|previous|login|sign up|the feed)$/i.test(t)) return false;
  return true;
}

function nearestPublished(timeMarkers, index) {
  let best = null;
  let bestDistance = Infinity;
  for (const marker of timeMarkers) {
    const distance = Math.abs(marker.index - index);
    if (distance <= 2200 && distance < bestDistance) {
      best = marker.value;
      bestDistance = distance;
    }
  }
  return best;
}

function collectJsonLdArticles(html, pageUrl, add) {
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); }
    catch { continue; }

    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { for (const v of node) walk(v); return; }
      if (typeof node !== 'object') return;

      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
      if (/\b(?:NewsArticle|Article|BlogPosting)\b/i.test(type)) {
        const rawUrl = typeof node.url === 'string'
          ? node.url
          : (typeof node.mainEntityOfPage === 'string' ? node.mainEntityOfPage : node.mainEntityOfPage?.['@id']);
        const link = samePublisherArticleUrl(rawUrl, pageUrl);
        const title = visibleText(node.headline || node.name || '');
        if (link && validHeadline(title)) {
          add({ title, link, published: node.datePublished || node.dateCreated || node.dateModified || null, summary: '' });
        }
      }

      for (const value of Object.values(node)) walk(value);
    };
    walk(parsed);
  }
}

/**
 * Parse a publisher's live Latest News HTML into the same item shape as RSS.
 *
 * This deliberately does NOT try to understand every element on the page. It
 * accepts only same-publisher article-looking links with real headline text and
 * pairs them with the nearest machine-readable <time datetime="..."> marker.
 * JSON-LD articles are accepted first when the publisher exposes them. The
 * normal UFC-focus filter and database dedupe still run after this parser, so a
 * boxing/sidebar link cannot become a scored UFC candidate merely by appearing
 * on the page.
 */
export function parseLatestPage(html, pageUrl, { limit = 80 } = {}) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();

  const add = (item) => {
    if (!item?.link || !item?.title || seen.has(item.link) || out.length >= limit) return;
    seen.add(item.link);
    out.push(item);
  };

  collectJsonLdArticles(text, pageUrl, add);

  const timeMarkers = [];
  const timeRe = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let tm;
  while ((tm = timeRe.exec(text))) timeMarkers.push({ index: tm.index, value: decodeHtml(tm[1]).trim() });

  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let a;
  while (out.length < limit && (a = anchorRe.exec(text))) {
    const link = samePublisherArticleUrl(a[1], pageUrl);
    if (!link || seen.has(link)) continue;
    const title = visibleText(a[2]);
    if (!validHeadline(title)) continue;
    add({ title, link, published: nearestPublished(timeMarkers, a.index), summary: '' });
  }

  return out;
}
