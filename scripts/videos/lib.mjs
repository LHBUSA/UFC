/* Shared helpers for the ufc.propbetedge.ai official-video layer
 * (docs/UFC_MEDIA_VIDEO_ADDENDUM.md sections 4-6, 10; docs/videos.md).
 *
 * Plain Node (>=20), no npm dependencies. Supabase access, feed/text helpers and
 * the fighter index are reused from scripts/news/lib.mjs; nothing here writes
 * DDL. Videos are never downloaded or rehosted: only provider ids and metadata
 * are stored and the embed URL is constructed at render time.
 */
import { normalize } from '../../shared/alias_resolver.mjs';
import { decodeEntities, fetchText, isContenderSeries, dedupeEvents, surname, USER_AGENT } from '../news/lib.mjs';

export { Supabase, loadEnv, loadFighterIndex, fetchText } from '../news/lib.mjs';

export const PROVIDER = 'youtube';
export const WINDOW_DAYS = 45;
export const VIDEO_TYPES = ['embedded_episode', 'countdown', 'fight_preview', 'full_fight', 'highlights', 'interview', 'press_conference', 'media_day', 'weigh_in', 'faceoff', 'post_fight', 'analysis', 'other'];

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------- discovery: feed */

export function feedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}
export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : null;
}
function tagAttr(block, name, attrName) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/* YouTube channel Atom feed -> { channel: {id, title}, entries: [...] }.
 * The feed carries the newest ~15 uploads (Shorts and live streams included) with
 * title, published/updated, alternate link, media:thumbnail and media:description. */
export function parseYoutubeFeed(xml) {
  const text = String(xml || '');
  const head = text.split(/<entry[\s>]/i)[0];
  /* The feed header prints the id without its "UC" prefix ("vgfXK4..."); entries carry the full id. */
  let headId = tagText(head, 'yt:channelId');
  if (headId && !/^UC/.test(headId) && headId.length === 22) headId = `UC${headId}`;
  const channel = { id: headId, title: tagText(head, 'title'), author: tagText(head, 'name') };
  const entries = [];
  for (const b of text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []) {
    const videoId = tagText(b, 'yt:videoId');
    if (!videoId) continue;
    const link = tagAttr(b, 'link', 'href');
    entries.push({
      video_id: videoId,
      channel_id: tagText(b, 'yt:channelId'),
      title: tagText(b, 'title') || tagText(b, 'media:title') || '',
      link,
      is_short: /\/shorts\//i.test(link || ''),
      published: tagText(b, 'published'),
      updated: tagText(b, 'updated'),
      thumbnail_url: tagAttr(b, 'media:thumbnail', 'url'),
      description: tagText(b, 'media:description') || '',
      views: Number(tagAttr(b, 'media:statistics', 'views')) || null,
    });
  }
  return { channel, entries };
}

/* oEmbed answers 200 for embeddable public videos; 401 (embedding disabled),
 * 403 (private) and 400/404 (unavailable) all mean "do not render a player".
 *
 * WHAT A 200 DOES NOT MEAN. It proves the embed page exists. It says nothing
 * about the viewer's country: UFC Brasil's XMK-nCzDxGo answered 200 and does
 * not play in the U.S. (GitHub issue #19). The check therefore records
 * `proves: 'embed_page_exists'` and never sets region knowledge; see
 * videoAvailability() below. */
export async function checkEmbeddable(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`;
  try {
    const r = await fetchText(url, { timeoutMs: 15000, attempts: 2 });
    let author = null;
    if (r.ok) { try { author = JSON.parse(r.body).author_name || null; } catch { /* ignore */ } }
    return { embeddable: r.ok, status: r.status, author_name: author, proves: r.ok ? 'embed_page_exists' : 'not_embeddable' };
  } catch (e) {
    return { embeddable: null, status: null, error: e.message };
  }
}

/* --------------------------------------------------- availability policy */

/* The region the site is evaluated for. Mirrored by web/lib/videoPolicy.ts
 * POLICY_REGION; the two must agree or the resolver and the page will
 * disagree about which videos exist. */
export const POLICY_REGION = 'US';

/* Regional UFC channels publish for a country audience and are the ones that
 * region-lock uploads. Never assume their clips play everywhere. */
export const REGIONAL_CHANNEL = /brasil|espa[nñ]ol|latino|eurasia|japan|quebec/i;

/**
 * Can a reader in `region` play this video, as far as we KNOW?
 *
 *   unembeddable  embeddable === false (embedding disabled / private / gone)
 *   blocked       Data API regionRestriction excludes the region, or a
 *                 recorded observation (source_metadata.observed_region_block)
 *                 says the player refused it there
 *   playable      embeddable === true AND the Data API answered the region
 *                 question (region_check.method = youtube_data_api)
 *   unverified    everything else -- including every oEmbed-only row. Offered
 *                 poster-first; the page's player falls back at runtime.
 *
 * `row` is a ufc_videos row (embeddable + source_metadata).
 */
export function videoAvailability(row, region = POLICY_REGION) {
  if (!row || row.embeddable === false) return 'unembeddable';
  const sm = row.source_metadata || {};
  const rr = sm.region_restriction;
  const blockedByApi = rr && ((Array.isArray(rr.blocked) && rr.blocked.includes(region))
    || (Array.isArray(rr.allowed) && rr.allowed.length > 0 && !rr.allowed.includes(region)));
  const observed = Array.isArray(sm.observed_region_block?.regions) && sm.observed_region_block.regions.includes(region);
  if (blockedByApi || observed) return 'blocked';
  const verified = sm.region_check?.method === 'youtube_data_api' || sm.discovery === 'youtube_data_api_v3';
  return row.embeddable === true && verified ? 'playable' : 'unverified';
}

/* Resolver order inside one relevance tier: proven-playable first, then
 * unverified clips from global channels, then unverified regional clips. */
export function availabilityRank(row, region = POLICY_REGION) {
  const a = videoAvailability(row, region);
  if (a === 'playable') return 0;
  if (a === 'unverified') return REGIONAL_CHANNEL.test(row.channel_name || '') ? 2 : 1;
  return 9;
}

/* --------------------------------------------- discovery: Data API v3 */

const API = 'https://www.googleapis.com/youtube/v3';

async function apiGet(resource, params, key) {
  const q = new URLSearchParams({ ...params, key });
  const r = await fetchText(`${API}/${resource}?${q}`, { timeoutMs: 25000, attempts: 3 });
  if (!r.ok) throw new Error(`youtube ${resource} -> ${r.status}: ${r.body.slice(0, 300)}`);
  return JSON.parse(r.body);
}

/* "PT1H2M3S" -> 3723 */
export function isoDurationToSec(s) {
  const m = String(s || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

/* channels.list -> uploads playlist -> playlistItems.list (newest first, stop
 * once a page is entirely older than `since`) -> videos.list for duration,
 * status.embeddable, privacy and live state. Quota: 1 unit per call. */
export async function discoverViaDataApi(channelId, { key, since, now = new Date() }) {
  const ch = await apiGet('channels', { part: 'contentDetails,snippet', id: channelId }, key);
  const item = (ch.items || [])[0];
  if (!item) throw new Error(`channels.list returned nothing for ${channelId}`);
  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`no uploads playlist for ${channelId}`);
  const ids = [];
  let pageToken;
  for (let page = 0; page < 20; page += 1) {
    const pl = await apiGet('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, key);
    let allOld = true;
    for (const it of pl.items || []) {
      const vid = it.contentDetails?.videoId;
      const pub = it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt;
      if (!vid) continue;
      if (since && pub && new Date(pub) < since) continue;
      allOld = false;
      ids.push(vid);
    }
    pageToken = pl.nextPageToken;
    if (!pageToken || allOld) break;
  }
  const entries = await videoEntries(ids, key, now);
  return { channel: { id: channelId, title: item.snippet?.title || null, uploads_playlist: uploads }, entries };
}

/* ------------------------------------ discovery: public YouTube pages */

/* The JSON object assigned to `var <name> = {...};` in a YouTube page. Scans
 * braces with string awareness instead of a lazy regex: titles and
 * descriptions routinely contain "};". */
export function extractPageJson(html, name) {
  const text = String(html || '');
  const marker = text.indexOf(`var ${name} = {`);
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function collect(node, pick, out = []) {
  if (!node || typeof node !== 'object') return out;
  const hit = pick(node);
  if (hit) { out.push(hit); return out; }
  for (const k of Object.keys(node)) collect(node[k], pick, out);
  return out;
}

/* One playlist row, from either renderer YouTube has shipped for playlists. */
function playlistItem(node) {
  const l = node.lockupViewModel;
  if (l && l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && l.contentId) {
    const meta = l.metadata?.lockupMetadataViewModel || {};
    const channel = collect(meta.metadata, (n) => (typeof n.browseId === 'string' && /^UC/.test(n.browseId) ? n.browseId : null))[0] || null;
    const badge = collect(l.contentImage, (n) => (n.thumbnailBadgeViewModel ? n.thumbnailBadgeViewModel.text : null))[0] || null;
    return { video_id: l.contentId, title: meta.title?.content || '', channel_id: channel, length_text: badge };
  }
  const p = node.playlistVideoRenderer;
  if (p && p.videoId) {
    return {
      video_id: p.videoId,
      title: p.title?.runs?.map((r) => r.text).join('') || p.title?.simpleText || '',
      channel_id: p.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
      length_text: p.lengthText?.simpleText || null,
    };
  }
  return null;
}

function continuationToken(node) {
  return collect(node, (n) => (n.continuationItemRenderer ? (collect(n.continuationItemRenderer, (m) => m.continuationCommand?.token || null)[0] || null) : null))[0] || null;
}

/* A public playlist page -> title, visible items, the continuation token for
 * the next batch (playlists longer than ~100), and what YouTube says it hid. */
export function parsePlaylistPage(html) {
  const data = extractPageJson(html, 'ytInitialData');
  if (!data) return null;
  const list = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const items = collect(list, playlistItem);
  const title = data.microformat?.microformatDataRenderer?.title
    || data.header?.pageHeaderRenderer?.pageTitle
    || data.metadata?.playlistMetadataRenderer?.title || null;
  const text = JSON.stringify(data.header || {}) + JSON.stringify(data.sidebar || {});
  const count = text.match(/"(\d[\d,]*) videos?"/);
  const hidden = JSON.stringify(data.alerts || []).match(/(\d[\d,]*) unavailable videos? (?:is|are) hidden/);
  const cfg = String(html || '');
  return {
    title,
    items,
    continuation: continuationToken(list),
    video_count: count ? Number(count[1].replace(/,/g, '')) : null,
    hidden_unavailable: hidden ? Number(hidden[1].replace(/,/g, '')) : 0,
    innertube: {
      key: (cfg.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || null,
      client_version: (cfg.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || null,
    },
  };
}

/* The next batch of a playlist page: the same POST the public page makes when a
 * reader scrolls. The key is the page's own web-client key, printed in the page
 * for every visitor; it is not an account credential and carries no quota. */
export function parsePlaylistContinuation(json) {
  const actions = [...(json?.onResponseReceivedActions || []), ...(json?.onResponseReceivedEndpoints || [])];
  const batch = actions.flatMap((a) => a.appendContinuationItemsAction?.continuationItems || []);
  return { items: collect(batch, playlistItem), continuation: continuationToken(batch) };
}

/* A public watch page -> the fields the Data API would have given: exact
 * publish time, uploading channel, duration, description, live state, and the
 * page's own answer to "may this be embedded". */
export function parseWatchPage(html) {
  const p = extractPageJson(html, 'ytInitialPlayerResponse');
  const vd = p?.videoDetails;
  if (!vd?.videoId) return null;
  const mf = p.microformat?.playerMicroformatRenderer || {};
  const thumbs = vd.thumbnail?.thumbnails || [];
  let live = 'none';
  if (vd.isLiveContent || mf.liveBroadcastDetails) {
    if (mf.liveBroadcastDetails?.isLiveNow) live = 'live';
    else if (mf.liveBroadcastDetails?.endTimestamp) live = 'completed';
    else if (vd.isUpcoming) live = 'upcoming';
    else live = 'completed';
  }
  const countries = Array.isArray(mf.availableCountries) ? mf.availableCountries : null;
  return {
    video_id: vd.videoId,
    channel_id: vd.channelId || mf.externalChannelId || null,
    channel_title: vd.author || mf.ownerChannelName || null,
    title: vd.title || mf.title?.simpleText || '',
    description: vd.shortDescription || '',
    published: mf.publishDate || mf.uploadDate || null,
    duration_sec: Number.isFinite(Number(vd.lengthSeconds)) && Number(vd.lengthSeconds) > 0 ? Number(vd.lengthSeconds) : null,
    thumbnail_url: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    live_broadcast_state: live,
    privacy_status: vd.isPrivate ? 'private' : mf.isUnlisted ? 'unlisted' : 'public',
    playability_status: p.playabilityStatus?.status || null,
    playable_in_embed: typeof p.playabilityStatus?.playableInEmbed === 'boolean' ? p.playabilityStatus.playableInEmbed : null,
    available_in_us: countries && countries.length ? countries.includes('US') : null,
  };
}

async function fetchPublicPage(url, { method = 'GET', body = null, timeoutMs = 25000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: ctl.signal });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) { lastErr = new Error(`http ${res.status}`); await sleep(1500 * (i + 1)); continue; }
      return { ok: res.ok, status: res.status, body: text };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* Every item of a public playlist without any API credential: the playlist
 * page (and its scroll continuations) lists the items, and each video's public
 * watch page supplies exact metadata. `complete` is true only when the listing
 * ran to its end and every listed video's page was read; YouTube's own count of
 * hidden unavailable videos is reported, never guessed at. */
export async function discoverPlaylistPublic(playlistId, { now = new Date(), maxPages = 40, delayMs = 1000, retryRounds = 2, retryPauseMs = 60000 } = {}) {
  const base = 'https://www.youtube.com';
  /* Same slow-down answer as a watch page: a listing without ytInitialData is retried before it is a failure. */
  let page = null; let status = null;
  for (let round = 0; round <= retryRounds && !page; round += 1) {
    if (round > 0) await sleep(retryPauseMs * round);
    const r = await fetchPublicPage(`${base}/playlist?list=${encodeURIComponent(playlistId)}&hl=en&gl=US`);
    status = r.status;
    if (r.ok) page = parsePlaylistPage(r.body);
  }
  if (!page) throw new Error(status === 200 ? 'playlist page carried no ytInitialData' : `playlist page http ${status}`);
  const listed = [...page.items];
  let token = page.continuation;
  let pages = 1;
  while (token && pages < maxPages && page.innertube.key && page.innertube.client_version) {
    await sleep(delayMs);
    const c = await fetchPublicPage(`${base}/youtubei/v1/browse?key=${encodeURIComponent(page.innertube.key)}&prettyPrint=false`, {
      method: 'POST',
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: page.innertube.client_version, hl: 'en', gl: 'US' } }, continuation: token }),
    });
    if (!c.ok) break;
    let next;
    try { next = parsePlaylistContinuation(JSON.parse(c.body)); } catch { break; }
    listed.push(...next.items);
    token = next.continuation;
    pages += 1;
  }
  const seen = new Set();
  const unique = listed.filter((it) => (seen.has(it.video_id) ? false : seen.add(it.video_id)));

  const entries = [];
  const readWatch = async (it) => {
    try {
      const wr = await fetchPublicPage(`${base}/watch?v=${encodeURIComponent(it.video_id)}&hl=en&gl=US`);
      const w = wr.ok ? parseWatchPage(wr.body) : null;
      return w && w.video_id === it.video_id ? w : null;
    } catch { return null; }
  };
  /* A watch page without player data is YouTube asking us to slow down, not a
   * missing video (unavailable ones are already hidden from the listing). Such
   * items get later passes at a slower pace; whatever still fails is reported
   * and makes the playlist incomplete. */
  let pending = unique;
  const got = new Map();
  for (let round = 0; round <= retryRounds && pending.length; round += 1) {
    if (round > 0) await sleep(retryPauseMs * round);
    const failed = [];
    for (const it of pending) {
      await sleep(delayMs * (round + 1));
      const w = await readWatch(it);
      if (w) got.set(it.video_id, w); else failed.push(it);
    }
    pending = failed;
  }
  const unreadable = pending.map((it) => it.video_id);
  for (const it of unique) {
    const w = got.get(it.video_id);
    if (!w) continue;
    entries.push({
      ...w,
      link: watchUrl(w.video_id),
      is_short: null,
      updated: null,
      embeddable: null,                /* decided by oEmbed in the ingest, as on the feed path */
      region_restriction: w.available_in_us === false ? { allowed: null, blocked: [POLICY_REGION], source: 'watch_page_available_countries' } : undefined,
      watch_page: { playable_in_embed: w.playable_in_embed, playability_status: w.playability_status, available_in_us: w.available_in_us, checked_at: new Date(now).toISOString() },
      listing_channel_id: it.channel_id,
      playlist_id: playlistId,
      playlist_title: page.title,
    });
  }
  return {
    discovery: 'public_playlist_page',
    complete: !token && unreadable.length === 0,
    playlist: { id: playlistId, title: page.title },
    stats: { listed: unique.length, pages, video_count: page.video_count, hidden_unavailable: page.hidden_unavailable, unread_continuation: Boolean(token), unreadable_watch_pages: unreadable },
    entries,
  };
}

/* Every item of one playlist, regardless of age (archive backfill). Without a
 * key: the public playlist page (discoverPlaylistPublic). With one:
 * playlists.list for the title, playlistItems.list paged to the end (bounded),
 * videos.list for details. Each entry carries the playlist id and title so the
 * TUF tag can read them. */
export async function discoverPlaylist(playlistId, { key, now = new Date(), maxPages = 40 } = {}) {
  if (!key) return discoverPlaylistPublic(playlistId, { now, maxPages });
  const meta = await apiGet('playlists', { part: 'snippet', id: playlistId }, key);
  const title = meta.items?.[0]?.snippet?.title || null;
  const ids = [];
  let pageToken;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const pl = await apiGet('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, key);
    for (const it of pl.items || []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    pageToken = pl.nextPageToken;
    if (!pageToken) { complete = true; break; }
  }
  const entries = (await videoEntries([...new Set(ids)], key, now)).map((e) => ({ ...e, playlist_id: playlistId, playlist_title: title }));
  return { discovery: 'youtube_data_api_v3_playlist', complete, playlist: { id: playlistId, title }, entries };
}

async function videoEntries(ids, key, now) {
  const entries = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await apiGet('videos', { part: 'snippet,contentDetails,status,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') }, key);
    for (const it of v.items || []) {
      const sn = it.snippet || {};
      const thumbs = sn.thumbnails || {};
      const thumb = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url || null;
      let live = sn.liveBroadcastContent || 'none';
      if (live === 'none' && it.liveStreamingDetails?.actualEndTime) live = 'completed';
      entries.push({
        video_id: it.id,
        channel_id: sn.channelId,
        channel_title: sn.channelTitle,
        title: sn.title || '',
        link: watchUrl(it.id),
        is_short: null,               /* the API does not flag Shorts; duration <= 60s is the usual proxy */
        published: sn.publishedAt,
        updated: null,
        thumbnail_url: thumb,
        description: sn.description || '',
        duration_sec: isoDurationToSec(it.contentDetails?.duration),
        embeddable: it.status?.embeddable == null ? null : Boolean(it.status.embeddable),
        /* contentDetails.regionRestriction: { allowed: [...] } or { blocked: [...] } when YouTube limits playback by country. */
        region_restriction: it.contentDetails?.regionRestriction ? { allowed: it.contentDetails.regionRestriction.allowed || null, blocked: it.contentDetails.regionRestriction.blocked || null } : null,
        /* The API answered the region question for this video, whether or not
         * it named a restriction. This -- not oEmbed -- is what makes a row
         * "playable" rather than "unverified" (videoAvailability). */
        region_check: it.contentDetails ? { method: 'youtube_data_api', checked_at: new Date(now).toISOString() } : null,
        privacy_status: it.status?.privacyStatus || null,
        live_broadcast_state: live,
      });
    }
  }
  return entries;
}

/* ------------------------------------------------------- classification */

/* Ordered: the first family whose pattern hits the TITLE wins. Post-fight beats
 * press conference on purpose ("Post-Fight Press Conference" is the post-fight
 * media event of docs/fight_state_ledger.md). Description patterns are consulted
 * only when the title says nothing, and only for the strong, format-naming
 * families: the description boilerplate ("Watch UFC on ...", "UFC Video
 * Archive") must not classify anything. */
const TITLE_RULES = [
  /* English first, then the Portuguese (UFC Brasil) and Spanish (UFC Espanol) forms of the same families. */
  ['embedded_episode', /\bembedded\b/i],
  ['countdown', /\bcountdown\b|\bcuenta regresiva\b|\bcontagem regressiva\b/i],
  ['post_fight', /\bpost[\s-]?fight\b|\bpost[\s-]?show\b|\bp[oó]s[\s-]?(?:show|luta|evento)\b|\bpost[\s-]?pelea\b/i],
  ['press_conference', /\bpress\s?conference\b|\bpresser\b|\bpress conf\b|\bcoletiva\b|\bconferencia de prensa\b|\brueda de prensa\b/i],
  ['media_day', /\bmedia\s?day\b|\bdia de m[ií]dia\b|\bd[ií]a de medios\b/i],
  ['weigh_in', /\bweigh[\s-]?ins?\b|\bpesagem\b|\bpesaje\b/i],
  ['faceoff', /\bface[\s-]?offs?\b|\bstaredowns?\b|\bstare[\s-]?downs?\b|\bencaradas?\b|\bcareos?\b/i],
  ['full_fight', /\bfree\s?fight\b|\bfull\s?fight\b|\bluta completa\b|\bpelea completa\b|\bevento completo\b|\bmarat[oó]n\b/i],
  ['highlights', /\bhighlights?\b|\bevery (?:knockout|finish|submission)\b|\bbest (?:finishes|knockouts|moments)\b|\bmelhores momentos\b|\bnocautes\b|\bfinaliza[cç][oõ]es\b|\bmejores momentos\b|\bresumen\b/i],
  ['fight_preview', /\bpreview\b|\bpromo\b|\bfight week\b|\bpr[eé][\s-]?show\b|\bprevia\b|\bpr[eé]via\b|\bcartelera\b|\bpanor[aá]ma\b/i],
  ['analysis', /\bbreakdown\b|\brecap\b|\banalysis\b|\bfilm room\b|\bround[\s-]by[\s-]round\b|\ban[aá]lis(?:is|e)\b/i],
  ['interview', /\binterviews?\b|\bsits? down with\b|\b1[\s-]on[\s-]1\b|\bone[\s-]on[\s-]one\b|\bq&a\b|\bexclusive\b|\bentrevista\b/i],
];
const DESCRIPTION_RULES = TITLE_RULES.filter(([t]) => ['embedded_episode', 'countdown', 'press_conference', 'media_day', 'weigh_in', 'full_fight'].includes(t));

export function classifyVideo(title, description) {
  const evidence = [];
  let type = null;
  for (const [t, re] of TITLE_RULES) {
    const m = String(title || '').match(re);
    if (!m) continue;
    evidence.push({ video_type: t, source: 'title', match: m[0] });
    if (!type) type = t;
  }
  if (!type) {
    for (const [t, re] of DESCRIPTION_RULES) {
      const m = String(description || '').match(re);
      if (!m) continue;
      evidence.push({ video_type: t, source: 'description', match: m[0] });
      if (!type) type = t;
    }
  }
  return { video_type: type || 'other', evidence };
}

/* ------------------------------------------------ content language (V1) */

/* Channel → default language; the UFC/ESPN feeds are English unless a title is
 * unmistakably Spanish/Portuguese. Stored in source_metadata.language so the
 * web can label cards and filter without a schema change. */
const CHANNEL_LANG = [[/brasil|portugu/i, 'pt'], [/espa[nñ]ol|latino/i, 'es'], [/^ufc$|fight pass|espn|europe|\buk\b|australia|asia|japan|eurasia|quebec/i, 'en']];
const ES_HINT = /\b(el|la|los|las|del|con|contra|pelea|peleador|entrevista|conferencia|resumen|noche|hoy|semana|previa|mejores|momentos|así|más|será|todo|nuevo)\b|ñ|¿|¡/i;
const PT_HINT = /\b(luta|lutador|lutadora|entrevista|coletiva|melhores|momentos|noite|semana|prévia|contra|não|você|também|história|campeão|pesagem)\b|ção|ções/i;
export function detectLanguage(channelName, title, description) {
  const ch = String(channelName || '');
  const byChannel = (CHANNEL_LANG.find(([re]) => re.test(ch)) || [])[1] || 'unknown';
  if (byChannel === 'es' || byChannel === 'pt') return { language: byChannel, method: 'channel' };
  const text = String(title || '');
  const es = (text.match(ES_HINT) || []).length, pt = (text.match(PT_HINT) || []).length;
  if (pt >= 2 && /ção|não|você/i.test(text)) return { language: 'pt', method: 'title' };
  if (es >= 2 && /ñ|¿|¡/i.test(text)) return { language: 'es', method: 'title' };
  if (byChannel === 'en') return { language: 'en', method: 'channel' };
  void description;
  return { language: 'unknown', method: 'none' };
}

/* ---------------------------------------------------- text preparation */

/* Hashtags carry most of the event signal on Shorts ("#ufcparis", "#UFC331",
 * "#NocheUFC"): expand them into the words the event keys use before normalizing. */
export function expandHashtags(text) {
  return String(text || '')
    .replace(/#ufc\s?(\d{2,3})\b/gi, ' ufc $1 ')
    .replace(/#nocheufc\b/gi, ' noche ufc ')
    .replace(/#ufcfightnight\b/gi, ' ufc fight night ')
    .replace(/#(?:dwcs|contenderseries)\b/gi, ' contender series ')
    .replace(/#ufc([a-z]+)\b/gi, ' ufc $1 ')
    .replace(/#([a-z]+)ufc\b/gi, ' $1 ufc ');
}

export function prepText(s) {
  return ` ${normalize(expandHashtags(s))} `;
}

function hasPhrase(norm, phrase) {
  return phrase && norm.includes(` ${phrase} `);
}

/* --------------------------------------------------- event context */

const CITY_ALIASES = { 'las vegas': ['vegas', 'las vegas'], 'abu dhabi': ['abu dhabi', 'abudhabi'], 'salt lake city': ['salt lake city', 'slc'], 'rio de janeiro': ['rio', 'rio de janeiro'], 'mexico city': ['mexico city', 'mexico'] };

/* Match keys for one event, strongest first:
 *   number  "ufc 331"                          (title head "UFC 331")
 *   name    full normalized name, "A vs B" tail (>= 3 tokens)
 *   series  "noche ufc", "contender series"    (non-numbered heads; shared by every week of a series)
 *   city    "ufc paris", "ufc vegas"           (never for Contender Series cards)
 *   headliners: both surnames of the "A vs B" tail present (Fight Night cards, >= 4 chars each) */
export function eventKeys(e) {
  const keys = [];
  const n = normalize(e.name);
  if (n) keys.push({ key: n, kind: 'name' });
  const m = String(e.name || '').match(/^([^:]+):\s*(.+)$/);
  const head = m ? normalize(m[1]) : n;
  const tail = m ? normalize(m[2]) : '';
  const num = head.match(/^ufc (\d{2,3})$/);
  if (num) keys.push({ key: `ufc ${num[1]}`, kind: 'number' });
  else if (head && head !== 'ufc fight night') {
    keys.push({ key: head, kind: 'series' });
    if (/contender series/.test(head)) keys.push({ key: 'contender series', kind: 'series' }, { key: 'dwcs', kind: 'series' });
    if (head === 'noche ufc') keys.push({ key: 'ufc noche', kind: 'series' });
  }
  if (tail && tail.split(' ').length >= 3) keys.push({ key: tail, kind: 'name' });
  const vs = tail.match(/^(.+?) vs (.+?)(?: \d)?$/);
  const headliners = vs ? [surname(vs[1]), surname(vs[2])].filter((s) => s.length >= 4) : [];
  const city = normalize(e.city);
  const cityKeys = [];
  if (city && !isContenderSeries(e.name)) {
    for (const alias of CITY_ALIASES[city] || [city]) cityKeys.push(`ufc ${alias}`);
    if (head === 'ufc fight night') cityKeys.push(`fight night ${city}`);
  }
  return { keys, cityKeys, headliners: headliners.length === 2 ? headliners : [] };
}

export async function loadEventContext(sb, { now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const lo = new Date(now.getTime() - windowDays * 86400e3).toISOString().slice(0, 10);
  const hi = new Date(now.getTime() + windowDays * 86400e3).toISOString().slice(0, 10);
  const events = await sb.select('ufc_events', `select=id,name,event_date,venue,city,region,country,card_status&event_date=gte.${lo}&event_date=lte.${hi}`);
  if (!events.length) return { events: [], bouts: [], cardFighterIds: new Set(), articlesByBout: new Map(), window: { lo, hi } };
  const ids = events.map((e) => e.id).join(',');
  const bouts = await sb.select('ufc_bouts', `select=id,event_id,fighter_a_id,fighter_b_id,status,bout_order&event_id=in.(${ids})&status=neq.cancelled`);
  const boutIds = bouts.map((b) => b.id);
  const articles = [];
  for (let i = 0; i < boutIds.length; i += 200) {
    articles.push(...await sb.select('ufc_articles', `select=id,bout_id,published_at&status=eq.published&bout_id=in.(${boutIds.slice(i, i + 200).join(',')})&order=published_at.desc`));
  }
  return buildEventContext(events, bouts, articles, { lo, hi });
}

/* ARCHIVE LINKING. The window above is "the cards around now", which is right
 * for a feed of new uploads and wrong for a 2014 playlist video: its "UFC
 * Vegas" would be decided among this month's Vegas cards and its surnames among
 * this month's card fighters. A backfill loads every event once and links each
 * video against the cards around ITS OWN publish date (contextAt). */
export async function loadArchiveEvents(sb) {
  const [events, bouts, articles] = await Promise.all([
    sb.select('ufc_events', 'select=id,name,event_date,venue,city,region,country,card_status&order=id.asc'),
    sb.select('ufc_bouts', 'select=id,event_id,fighter_a_id,fighter_b_id,status,bout_order&status=neq.cancelled&order=id.asc'),
    sb.select('ufc_articles', 'select=id,bout_id,published_at&status=eq.published&bout_id=not.is.null&order=published_at.desc'),
  ]);
  return { events, bouts, articles };
}

export function contextAt(archive, when, windowDays = WINDOW_DAYS) {
  if (!when || Number.isNaN(when.getTime())) return { events: [], bouts: [], cardFighterIds: new Set(), articlesByBout: new Map(), window: { lo: null, hi: null }, surnameRequiresEvent: true };
  const lo = new Date(when.getTime() - windowDays * 86400e3).toISOString().slice(0, 10);
  const hi = new Date(when.getTime() + windowDays * 86400e3).toISOString().slice(0, 10);
  const events = archive.events.filter((e) => e.event_date && e.event_date >= lo && e.event_date <= hi);
  const ids = new Set(events.map((e) => e.id));
  const bouts = archive.bouts.filter((b) => ids.has(b.event_id)).map((b) => ({ ...b }));
  const boutIds = new Set(bouts.map((b) => b.id));
  return { ...buildEventContext(events, bouts, archive.articles.filter((a) => boutIds.has(a.bout_id)), { lo, hi }), surnameRequiresEvent: true };
}

function buildEventContext(events, bouts, articles, window) {
  const { lo, hi } = window;
  if (!events.length) return { events: [], bouts: [], cardFighterIds: new Set(), articlesByBout: new Map(), window: { lo, hi } };
  const boutsByEvent = new Map();
  for (const b of bouts) {
    if (!boutsByEvent.has(b.event_id)) boutsByEvent.set(b.event_id, []);
    boutsByEvent.get(b.event_id).push(b);
  }
  const primaries = dedupeEvents(events, { boutsByEvent });
  const idMap = new Map();
  for (const p of primaries) { idMap.set(p.id, p.id); for (const a of p.alt_ids) idMap.set(a, p.id); }
  for (const b of bouts) b.event_id = idMap.get(b.event_id) || b.event_id;
  const cardFighterIds = new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]));
  const articlesByBout = new Map();
  for (const a of articles) {
    if (!articlesByBout.has(a.bout_id)) articlesByBout.set(a.bout_id, []);
    articlesByBout.get(a.bout_id).push(a);
  }
  return { events: primaries.map((e) => ({ ...e, ...eventKeys(e) })), bouts, cardFighterIds, articlesByBout, window: { lo, hi } };
}

/* ------------------------------------------------------- entity linking */

const KIND_RANK = { number: 4, name: 3, series: 2, city: 2, headliners: 1 };
/* Surnames that are ordinary words or belong to non-fighters who appear in every
 * title ("Dana White"): never attach on a surname-only hit. */
const SURNAME_STOPLIST = new Set(['white', 'young', 'page', 'wells', 'walker', 'gore', 'hill', 'brown', 'green', 'black', 'price', 'king', 'long', 'strong', 'best', 'fight', 'rose', 'bell', 'hall', 'wood', 'stone', 'gold', 'power', 'fury', 'champion', 'mexico', 'paris', 'vegas', 'card', 'night']);

function daysFrom(dateStr, when) {
  if (!dateStr) return 1e9;
  return Math.abs((new Date(`${dateStr}T00:00:00Z`).getTime() - when.getTime()) / 86400e3);
}

/* Event: collect every key hit (title first, then description), keep the strongest
 * kind, then the event nearest the publish date. A series/city key shared by two
 * cards is decided by date only when one card is clearly nearer (>= 2 days closer);
 * otherwise the event goes to review. Two different events hit at the same strength
 * in the title (e.g. a "UFC 330 recap / UFC 331 preview") also go to review. */
export function linkEvent(text, titleText, ctx, publishedAt) {
  const normAll = prepText(text);
  const normTitle = prepText(titleText);
  const hits = [];
  for (const e of ctx.events) {
    const found = (key, kind) => {
      const inTitle = hasPhrase(normTitle, key);
      if (inTitle || hasPhrase(normAll, key)) hits.push({ event: e, key, kind, rank: KIND_RANK[kind] + (inTitle ? 0.5 : 0), in_title: inTitle });
    };
    for (const k of e.keys) found(k.key, k.kind);
    for (const k of e.cityKeys) found(k, 'city');
    if (e.headliners.length === 2 && e.headliners.every((s) => hasPhrase(normTitle, s) || hasPhrase(normAll, s))) {
      const inTitle = e.headliners.every((s) => hasPhrase(normTitle, s));
      hits.push({ event: e, key: e.headliners.join(' + '), kind: 'headliners', rank: KIND_RANK.headliners + (inTitle ? 0.5 : 0), in_title: inTitle });
    }
  }
  if (!hits.length) return { event: null, evidence: null, review: null };
  const top = Math.max(...hits.map((h) => h.rank));
  const best = hits.filter((h) => h.rank === top);
  const byEvent = new Map();
  for (const h of best) if (!byEvent.has(h.event.id)) byEvent.set(h.event.id, h);
  if (byEvent.size === 1) {
    const h = best[0];
    return { event: h.event, evidence: { key: h.key, kind: h.kind, in_title: h.in_title, method: 'unique_key' }, review: null };
  }
  const when = publishedAt || new Date();
  const ranked = [...byEvent.values()].map((h) => ({ h, dist: daysFrom(h.event.event_date, when) })).sort((a, b) => a.dist - b.dist);
  const sameKey = ranked.every((r) => r.h.key === ranked[0].h.key);
  if (sameKey && (ranked.length === 1 || ranked[1].dist - ranked[0].dist >= 2)) {
    const h = ranked[0].h;
    return { event: h.event, evidence: { key: h.key, kind: h.kind, in_title: h.in_title, method: 'nearest_date', distance_days: Math.round(ranked[0].dist) }, review: null };
  }
  return {
    event: null,
    evidence: null,
    review: { reason: 'multiple_events', candidates: ranked.map((r) => ({ event_id: r.h.event.id, name: r.h.event.name, key: r.h.key, kind: r.h.kind, distance_days: Math.round(r.dist) })) },
  };
}

/* Fighters, gated (docs/videos.md):
 *   1. full name / multi-token alias, searched among the +-45d card fighters
 *      (or the linked event's card when that disambiguates), attached only when
 *      exactly one fighter carries that name in the pool;
 *   2. the same full-name scan over the whole table, attached only when the
 *      alias resolver's exact-normalized candidate set has one member;
 *   3. surname (>= 4 chars, title only), attached only when it belongs to exactly
 *      one +-45d card fighter and is not on the stoplist.
 * Anything with 2+ candidates is a review item, never an attachment. */
export function linkFighters(text, titleText, index, ctx, eventId) {
  const normAll = prepText(text);
  const normTitle = prepText(titleText);
  const attached = new Map();            /* fighter_id -> {method, alias} */
  const review = [];

  /* Candidate names: multi-token only (single-token nicknames tag far too loosely). */
  const nameIndex = new Map();           /* normalized name -> Set(fighter_id) */
  for (const f of index.fighters) {
    /* A nickname is not a name, however many words it has: "The Best" and
     * "Main Event" are ring names that ordinary sentences contain. */
    const nick = f.nickname ? normalize(f.nickname) : null;
    const own = normalize(f.name);
    for (const raw of [f.name, ...(index.aliasesByFighter.get(f.id) || [])]) {
      const n = normalize(raw);
      if (!n || n.split(' ').length < 2) continue;
      if (nick && n === nick && n !== own) continue;
      if (!nameIndex.has(n)) nameIndex.set(n, new Set());
      nameIndex.get(n).add(f.id);
    }
  }
  const eventBoutFighters = eventId ? new Set(ctx.bouts.filter((b) => b.event_id === eventId).flatMap((b) => [b.fighter_a_id, b.fighter_b_id])) : null;

  for (const [n, ids] of nameIndex) {
    if (!hasPhrase(normAll, n)) continue;
    /* Longer names win over their own prefixes ("Bruno Silva" vs "Bruno Silva de ..."). */
    const inTitle = hasPhrase(normTitle, n);
    const all = [...ids];
    const inWindow = all.filter((id) => ctx.cardFighterIds.has(id));
    const onEvent = eventBoutFighters ? all.filter((id) => eventBoutFighters.has(id)) : [];
    let pick = null; let method = null;
    if (onEvent.length === 1) { pick = onEvent[0]; method = 'full_name_event_card'; }
    else if (inWindow.length === 1) { pick = inWindow[0]; method = 'full_name_window_card'; }
    else if (all.length === 1) { pick = all[0]; method = 'full_name_unique'; }
    if (pick) {
      if (!attached.has(pick)) attached.set(pick, { method, alias: n, in_title: inTitle });
    } else {
      review.push({ reason: 'ambiguous_fighter_name', alias: n, candidate_fighter_ids: all.slice(0, 6), in_window: inWindow.length });
    }
  }

  /* Surname pass, title only. Scope: the linked event's card when an event is
   * known (a surname absent from that card attaches nothing, even if unique in
   * the window: "Lopes vs. Silva" replays under a #NocheUFC tag are past bouts),
   * otherwise the +-45d card fighters. Unique in scope -> attach; 2+ -> review. */
  const scoped = Boolean(eventBoutFighters && eventBoutFighters.size);
  const scopeIds = scoped ? eventBoutFighters : ctx.cardFighterIds;
  const scopeName = scoped ? 'surname_unique_event_card' : 'surname_unique_window';
  const surnameOwners = new Map();
  for (const id of scopeIds) {
    const f = index.byId.get(id);
    if (!f) continue;
    const s = surname(f.name);
    if (s.length < 4 || SURNAME_STOPLIST.has(s)) continue;
    if (!surnameOwners.has(s)) surnameOwners.set(s, new Set());
    surnameOwners.get(s).add(id);
  }
  const titleTokens = new Set(normTitle.trim().split(' ').filter(Boolean));
  /* A surname already accounted for by a full-name hit ("Michael Chandler") is
   * that fighter's, not a card-mate's who shares it. */
  const claimedSurnames = new Set([...attached.keys()].map((id) => surname(index.byId.get(id)?.name || '')).filter(Boolean));
  /* Archive context (contextAt): a card window around an old publish date is a
   * weak scope, so surname-only hits need a linked event. */
  const surnameAllowed = scoped || !ctx.surnameRequiresEvent;
  for (const [s, owners] of surnameOwners) {
    if (!surnameAllowed || !titleTokens.has(s) || claimedSurnames.has(s)) continue;
    if (owners.size === 1) {
      const id = [...owners][0];
      if (!attached.has(id)) attached.set(id, { method: scopeName, alias: s, in_title: true });
    } else if (![...owners].some((id) => attached.has(id))) {
      review.push({ reason: 'ambiguous_surname', alias: s, scope: scopeName, candidate_fighter_ids: [...owners].slice(0, 6) });
    }
  }
  return { fighters: attached, review };
}

/* Bout: both fighters of one announced bout attached FROM THE TITLE (descriptions
 * routinely name the card's main event, which would tag every fight-week video
 * with the headliners). If several bouts qualify (a fighter rebooked across two
 * cards inside the window) prefer the linked event's bout, else the nearest card. */
export function linkBout(fighters, ctx, eventId, publishedAt) {
  const set = new Set([...fighters.entries()].filter(([, f]) => f.in_title).map(([id]) => id));
  const pool = eventId ? ctx.bouts.filter((b) => b.event_id === eventId) : ctx.bouts;
  const hits = pool.filter((b) => set.has(b.fighter_a_id) && set.has(b.fighter_b_id));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const when = publishedAt || new Date();
  const byDate = (b) => { const e = ctx.events.find((x) => x.id === b.event_id); return e ? daysFrom(e.event_date, when) : 1e9; };
  return hits.sort((a, b) => byDate(a) - byDate(b))[0];
}

export function confidenceFor({ eventId, boutId, fighters }) {
  const methods = [...fighters.values()].map((f) => f.method);
  const fullName = methods.some((m) => m.startsWith('full_name'));
  if (eventId && boutId) return 'high';
  if (eventId || fullName) return 'medium';
  if (methods.length) return 'low';
  return 'none';
}

/* An event reached only through the shared "The Ultimate Fighter" series head
 * (every TUF finale card carries it) is a date guess, not a match. For a TUF
 * video it stands only when a bout on that card was linked from the title, or
 * the title itself says "finale" and the card's season does not contradict the
 * video's. House fights, casting clips and coach segments name no card. */
export function tufSeriesEventSupported(link, { title, videoSeason, eventSeason }) {
  const ev = link?.linking?.event;
  if (!link?.event_id || !ev || ev.kind !== 'series') return { supported: true };
  if (link.bout_id) return { supported: true, basis: 'bout linked from the title' };
  if (!/\bfinale\b/i.test(String(title || ''))) return { supported: false, reason: 'tuf_series_key_without_finale_in_title' };
  if (videoSeason && eventSeason && videoSeason !== eventSeason) return { supported: false, reason: 'tuf_series_key_season_conflict', video_season: videoSeason, event_season: eventSeason };
  return { supported: true, basis: 'finale in title, no season conflict' };
}

/* One call per video: returns the columns to persist plus the evidence block. */
export function linkVideo(entry, index, ctx) {
  const publishedAt = entry.published ? new Date(entry.published) : null;
  const text = `${entry.title}\n${entry.description || ''}`;
  const ev = linkEvent(text, entry.title, ctx, publishedAt);
  let eventId = ev.event ? ev.event.id : null;
  const fl = linkFighters(text, entry.title, index, ctx, eventId);
  const fighterIds = [...fl.fighters.keys()].sort();
  const bout = linkBout(fl.fighters, ctx, eventId, publishedAt);
  let eventEvidence = ev.evidence;
  if (bout && !eventId) { eventId = bout.event_id; eventEvidence = { method: 'via_bout', bout_id: bout.id }; }
  const articles = bout ? ctx.articlesByBout.get(bout.id) || [] : [];
  const articleId = articles.length === 1 ? articles[0].id : null;
  const reviews = [...(ev.review ? [ev.review] : []), ...fl.review];
  return {
    event_id: eventId,
    bout_id: bout ? bout.id : null,
    article_id: articleId,
    fighter_ids: fighterIds,
    resolver_confidence: confidenceFor({ eventId, boutId: bout ? bout.id : null, fighters: fl.fighters }),
    link_status: reviews.length ? 'review' : 'published',
    linking: {
      event: eventEvidence,
      fighters: [...fl.fighters.entries()].map(([id, f]) => ({ fighter_id: id, ...f })),
      bout: bout ? { bout_id: bout.id, event_id: bout.event_id } : null,
      article_candidates: articles.length,
    },
    review_reason: reviews.length ? reviews.map((r) => r.reason).join(',') : null,
    review: reviews.length ? reviews : null,
  };
}
