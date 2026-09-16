/* Publisher-controlled fallback inputs for sources whose site-wide RSS endpoint
 * can stay HTTP-healthy while its article list stops advancing.
 *
 * These are not alternate publishers or scraped third parties. RSS fallbacks
 * are author feeds exposed by the same publisher. Live-page fallbacks are the
 * publisher's own current-news surfaces. Ingest uses them only when the primary
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

/* More than one page on purpose. On 2026-09-16 MMA Mania's /latest-news
 * surface itself lagged while its homepage and archive page were current. One
 * publisher page must not become the new single point of failure we just
 * removed from RSS. */
export const LATEST_PAGES = Object.freeze({
  'MMA Fighting': Object.freeze([
    'https://www.mmafighting.com/latest-news',
    'https://www.mmafighting.com/archives/full',
  ]),
  'MMA Mania': Object.freeze([
    'https://www.mmamania.com/latest-news',
    'https://www.mmamania.com/',
  ]),
});

export function fallbackUrlsFor(sourceName) {
  return RSS_FALLBACKS[sourceName] || [];
}

export function fallbackPagesFor(sourceName) {
  return LATEST_PAGES[sourceName] || [];
}

/* Kept for callers/tests that only need the preferred page. */
export function fallbackPageFor(sourceName) {
  return fallbackPagesFor(sourceName)[0] || null;
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

function articlePathLooksReal(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    /* Both current fallback publishers are Vox properties whose article URLs
     * contain a durable numeric story id. Requiring it eliminates category,
     * navigation, tag and archive links before they can reach detail fetching. */
    if (host === 'mmafighting.com' || host === 'mmamania.com') {
      return /\/\d{5,}(?:\/|$)/.test(u.pathname);
    }
    return true;
  } catch {
    return false;
  }
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
    if (/\/(?:authors?|login|signup|search|rss|about|contact|masthead|community-guidelines|privacy|terms|pages|archives)(?:\/|$)/i.test(path)) return null;
    u.hash = '';
    const out = u.toString();
    return articlePathLooksReal(out) ? out : null;
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
    /* Real Vox cards can put metadata after image wrappers, so give the clock a
     * generous but still card-local radius. Detail-page enrichment below is the
     * fallback when the list page still provides no usable timestamp. */
    if (distance <= 6000 && distance < bestDistance) {
      best = marker.value;
      bestDistance = distance;
    }
  }
  return best;
}

function jsonLdNodes(html) {
  const nodes = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(String(html || '')))) {
    try { nodes.push(JSON.parse(m[1].trim())); } catch { /* malformed publisher block */ }
  }
  return nodes;
}

function walkJson(node, fn) {
  if (!node) return;
  if (Array.isArray(node)) { for (const v of node) walkJson(v, fn); return; }
  if (typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) walkJson(value, fn);
}

function collectJsonLdArticles(html, pageUrl, add) {
  for (const parsed of jsonLdNodes(html)) {
    walkJson(parsed, (node) => {
      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
      if (!/\b(?:NewsArticle|Article|BlogPosting)\b/i.test(type)) return;
      const rawUrl = typeof node.url === 'string'
        ? node.url
        : (typeof node.mainEntityOfPage === 'string' ? node.mainEntityOfPage : node.mainEntityOfPage?.['@id']);
      const link = samePublisherArticleUrl(rawUrl, pageUrl);
      const title = visibleText(node.headline || node.name || '');
      if (link && validHeadline(title)) {
        add({ title, link, published: node.datePublished || node.dateCreated || node.dateModified || null, summary: visibleText(node.description || '') });
      }
    });
  }
}

function metaContent(html, key) {
  const text = String(html || '');
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${esc}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${esc}["'][^>]*>`, 'i'),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return decodeHtml(m[1]).trim();
  }
  return null;
}

/**
 * Parse one actual article page for headline + publication time. This is used
 * only when a live listing exposes a real article link but its card markup does
 * not carry a machine-readable timestamp close enough for parseLatestPage.
 */
export function parseArticlePage(html, articleUrl) {
  let best = null;
  for (const parsed of jsonLdNodes(html)) {
    walkJson(parsed, (node) => {
      if (best) return;
      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
      if (!/\b(?:NewsArticle|Article|BlogPosting)\b/i.test(type)) return;
      const title = visibleText(node.headline || node.name || '');
      const published = node.datePublished || node.dateCreated || null;
      if (validHeadline(title) && published) best = { title, link: articleUrl, published, summary: visibleText(node.description || '') };
    });
  }
  if (best) return best;

  const title = visibleText(metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || '');
  const published = metaContent(html, 'article:published_time') || metaContent(html, 'datePublished');
  if (validHeadline(title) && published) {
    return { title, link: articleUrl, published, summary: visibleText(metaContent(html, 'og:description') || '') };
  }

  const time = String(html || '').match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1] || null;
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  const h1Title = visibleText(h1);
  return validHeadline(h1Title) && time
    ? { title: h1Title, link: articleUrl, published: decodeHtml(time).trim(), summary: '' }
    : null;
}

/**
 * Parse a publisher's live news HTML into the same item shape as RSS.
 *
 * Dated cards and JSON-LD are preferred. Real same-publisher article links are
 * still returned when the list card has no machine-readable date; the ingest
 * layer may resolve those few undated links against their own article pages.
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
