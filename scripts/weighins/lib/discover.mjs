/* Where this card's weigh-in sources are, found in data we ALREADY ingest.
 *
 * Both lanes start from ufc_news_items, which the newsroom fills every two
 * minutes from the registered publishers (ufc_news_sources). Nothing here
 * searches the web or constructs a URL:
 *
 *   OFFICIAL  a UFC.com News item whose URL/title is the promotion's "Official
 *             Weigh-In Results" article for THIS card. The URL is taken as the
 *             newsroom captured it (verified host www.ufc.com, path /news/), so
 *             no slug is ever invented. ufc_events carries no ufc_slug, and the
 *             previous `https://www.ufc.com/event/${event.ufc_slug}` built
 *             "https://www.ufc.com/event/" for every card.
 *
 *   WIRE      weigh-in stories from the other registered publishers, read from
 *             the source_body the newsroom already stored. The collector never
 *             re-fetches a publisher the newsroom has captured.
 *
 * "For THIS card" is decided conservatively: the item is linked to the event
 * by the newsroom, or its text names the card (the part of the event name
 * before the colon, e.g. "Noche UFC"), or it names BOTH headliners. A same-day
 * boxing or ONE weigh-in in the same feed never qualifies — and even if it
 * did, fighter matching is restricted to athletes booked on this card.
 */

import { normalize } from '../../../shared/alias_resolver.mjs';

const WEIGH_RE = /weigh[\s-]?ins?|weighs?\s+in|weighed\s+in|made\s+weight|makes?\s+weight|missed\s+weight|miss(?:es)?\s+weight|on\s+the\s+scale/i;
const OFFICIAL_RE = /official[\s-]weigh[\s-]?in[\s-]results/i;

export function isVerifiedUfcNewsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'www.ufc.com' && u.pathname.startsWith('/news/');
  } catch {
    return false;
  }
}

/** Anchors that identify this card in text: "Noche UFC", and the headliners' surnames. */
export function eventAnchors(event, bouts = [], fighters = []) {
  const name = String(event?.name || '');
  const prefix = name.includes(':') ? name.split(':')[0].trim() : null;
  const main = [...bouts].filter((b) => b.status !== 'cancelled').sort((a, b) => (b.bout_order ?? 0) - (a.bout_order ?? 0))[0] || null;
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const headliners = main ? [byId.get(main.fighter_a_id), byId.get(main.fighter_b_id)].filter(Boolean).map((f) => normalize(f.name).split(' ').pop()) : [];
  return {
    prefix: prefix && prefix.length >= 5 ? normalize(prefix) : null,
    headliners: headliners.filter((s) => s && s.length >= 3),
  };
}

export function refersToEvent(item, event, anchors) {
  if (item.event_id && item.event_id === event.id) return true;
  const hay = ` ${normalize([item.title, item.summary, item.url, (item.source_body || '').slice(0, 4000)].join(' '))} `;
  if (anchors.prefix && hay.includes(` ${anchors.prefix} `)) return true;
  if (anchors.headliners.length === 2 && anchors.headliners.every((s) => hay.includes(` ${s} `))) return true;
  return false;
}

/**
 * @returns {Promise<{official: Array, wire: Array, considered: number, rejected: Array}>}
 */
export async function discoverWeighInSources(sb, { event, bouts = [], fighters = [] } = {}) {
  const day = Date.parse(`${event.event_date}T00:00:00Z`);
  const from = new Date(day - 4 * 86400e3).toISOString();
  const to = new Date(day + 2 * 86400e3).toISOString();
  const [sources, items] = await Promise.all([
    sb.select('ufc_news_sources', 'select=id,name,url,kind'),
    sb.select('ufc_news_items',
      `select=id,source_id,url,title,summary,source_body,published_at,source_published_at,event_id&published_at=gte.${from}&published_at=lte.${to}` +
      `&or=(title.ilike.*weigh*,summary.ilike.*weigh*,title.ilike.*weight*,url.ilike.*weigh*)&order=published_at.desc&limit=300`),
  ]);
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const anchors = eventAnchors(event, bouts, fighters);
  const official = [];
  const wire = [];
  const rejected = [];

  for (const it of items) {
    const text = `${it.title || ''} ${it.summary || ''}`;
    const name = sourceName.get(it.source_id) || 'Unknown source';
    const mine = refersToEvent(it, event, anchors);
    if (!mine) { rejected.push({ url: it.url, why: 'not this card' }); continue; }

    if (isVerifiedUfcNewsUrl(it.url) && (OFFICIAL_RE.test(it.url) || OFFICIAL_RE.test(it.title || ''))) {
      official.push({ url: it.url, name: 'UFC.com', news_item_id: it.id, published_at: it.source_published_at || it.published_at, title: it.title });
      continue;
    }
    if (!WEIGH_RE.test(text) && !WEIGH_RE.test(it.url || '')) { rejected.push({ url: it.url, why: 'not a weigh-in story' }); continue; }
    if (/(^|\.)ufc\.com$/i.test(safeHost(it.url))) { rejected.push({ url: it.url, why: 'ufc.com non-results page' }); continue; }
    const body = String(it.source_body || '');
    if (body.length < 200) { rejected.push({ url: it.url, why: 'newsroom holds no body for this item' }); continue; }
    wire.push({ url: it.url, name, news_item_id: it.id, published_at: it.source_published_at || it.published_at, title: it.title, text: body });
  }

  /* Newest first within each lane; the official lane rarely has more than one. */
  return { official, wire, considered: items.length, rejected };
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
