#!/usr/bin/env node
/* Pull the newest uploads of every enabled, verified channel in
 * ufc_video_channels into ufc_videos (docs/videos.md).
 *
 *   node scripts/videos/ingest_youtube.mjs [--dry-run] [--since-days N] [--channel <id>] [--relink [--ids a,b,c] [--explain [--explain-out file.json]]]
 *
 * Discovery (docs/UFC_MEDIA_VIDEO_ADDENDUM.md section 6):
 *   YOUTUBE_API_KEY set   -> Data API v3: channels.list -> uploads playlist ->
 *                            playlistItems.list -> videos.list (duration, status,
 *                            embeddable, live state)
 *   no key                -> the channel's public Atom feed (newest ~15 uploads)
 *                            plus oEmbed per new video to confirm embeddability;
 *                            duration_sec stays null
 * source_metadata.discovery records which path produced the row.
 *
 * Every video is classified into the video_type enum from its title (then, for
 * the strong families only, its description), linked to an event / fighters /
 * bout / article with confidence gating, and upserted on
 * (provider, provider_video_id). Unchanged rows are not rewritten. Rows a human
 * marked link_status='rejected' keep their links. --relink recomputes
 * classification + links for the stored rows of the selected channels without
 * touching the network (use it after a fighter/event load lands).
 *
 * Playlist backfill (The Ultimate Fighter, 2026-09-12):
 *
 *   node scripts/videos/ingest_youtube.mjs --playlist <id> [--playlist <id> ...] [--dry-run]
 *
 * Reads every item of the named playlists instead of a channel's newest
 * uploads, and ignores the --since-days window, because an archive's videos
 * are years old by design. Nothing else changes: a video is still written only
 * if its uploading channel is enabled AND verified in ufc_video_channels, so a
 * playlist cannot smuggle in a channel nobody vetted (the FS1-era @tufonfs1
 * channel is not allowlisted and stays out).
 *
 * Discovery is keyless: the public playlist page lists every item (following
 * its scroll continuations past ~100), each video's public watch page gives the
 * exact publish time, uploading channel id, duration and description, and
 * oEmbed confirms embeddability exactly as on the feed path. The uploading
 * channel is taken from the watch page, not the playlist listing. A video in
 * several playlists is ingested once (provider_video_id); its playlist-derived
 * season is used only when those playlists agree.
 *
 * Every row, from any mode, carries source_metadata.tuf (season, episode,
 * kind, evidence) when its title or playlist is about The Ultimate Fighter —
 * see tuf.mjs. No column or enum changes.
 */
import { canonicalJson } from '../news/lib.mjs';
import { detectLanguage,
  Supabase, loadEnv, loadFighterIndex, fetchText,
  PROVIDER, WINDOW_DAYS, feedUrl, watchUrl, parseYoutubeFeed, checkEmbeddable, discoverViaDataApi, discoverPlaylist,
  classifyVideo, loadEventContext, loadArchiveEvents, contextAt, linkVideo, tufSeriesEventSupported, confidenceFor, sleep,
} from './lib.mjs';
import { tufTag } from './tuf.mjs';
import { diffRow, project, destructiveReasons } from './relink_diff.mjs';

const MAX_DESCRIPTION = 6000;

/* Options are an argument, not module-scope argv, and the time window is
 * computed PER RUN. The Worker imports this module once per isolate and
 * calls main() many times; a `since` frozen at import would keep querying
 * the window that was current when the isolate started, which on a
 * long-lived isolate silently stops finding new uploads. */
export function parseCliOptions(argv = []) {
  return {
    dry: argv.includes('--dry-run'),
    relink: argv.includes('--relink'),
    sinceDays: Number(argv[argv.indexOf('--since-days') + 1] || 30) || 30,
    onlyChannel: argv.includes('--channel') ? argv[argv.indexOf('--channel') + 1] : null,
    /* --relink --ids a,b,c: recompute only these provider video ids. A full relink also applies every link
     * change the current card context implies; a targeted repair (a language rule) should not ride along with that. */
    ids: argv.includes('--ids') ? new Set(String(argv[argv.indexOf('--ids') + 1] || '').split(',').map((x) => x.trim()).filter(Boolean)) : null,
    /* --explain: a field-level diff of every row the run would rewrite (relink_diff.mjs). READ-ONLY by construction:
     * it is refused without --dry-run, so asking what a relink would do can never be the thing that does it. */
    explain: argv.includes('--explain'),
    /* A relink repairs event / bout / fighter links. Two other columns ride on the same resolver and are HELD unless
     * asked for by name: article_id follows newsroom coverage (a separate editorial decision), and a published<->review
     * flip hides or publishes a video. Held values are reported, never written. */
    allowArticleChange: argv.includes('--allow-article-change'),
    allowStatusChange: argv.includes('--allow-status-change'),
    explainOut: argv.includes('--explain-out') ? argv[argv.indexOf('--explain-out') + 1] : null,
    playlists: argv.flatMap((a, i) => (a === '--playlist' && argv[i + 1] ? [argv[i + 1]] : [])),
  };
}

function isoOrNull(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* The persisted row for one discovered entry (links applied separately). */
function baseRow(entry, channel, discovery) {
  return {
    provider: PROVIDER,
    provider_video_id: entry.video_id,
    channel_id: channel.channel_id,
    channel_name: channel.name,
    channel_verified_source: Boolean(channel.verified),
    url: watchUrl(entry.video_id),
    title: entry.title,
    description: String(entry.description || '').slice(0, MAX_DESCRIPTION),
    published_at: isoOrNull(entry.published),
    duration_sec: entry.duration_sec ?? null,
    thumbnail_url: entry.thumbnail_url || null,
    embeddable: entry.embeddable ?? null,
    live_broadcast_state: entry.live_broadcast_state ?? null,
    discovery,
  };
}

function applyClassification(row, entry) {
  const cls = classifyVideo(entry.title, entry.description);
  row.video_type = cls.video_type;
  row.classification = cls;
  return row;
}

function keepStoredLinks(row, existing) {
  row.fighter_ids = existing.fighter_ids || [];
  row.event_id = existing.event_id; row.bout_id = existing.bout_id; row.article_id = existing.article_id;
  row.resolver_confidence = existing.resolver_confidence; row.link_status = existing.link_status;
  row.linking = existing.source_metadata?.linking || null;
  row.review_reason = existing.source_metadata?.review_reason || null;
  row.review = existing.source_metadata?.review || null;
  return row;
}

export const validDate = (s) => Boolean(s) && !Number.isNaN(new Date(s).getTime());

function applyLinks(row, entry, index, ctx, existing, policy = {}) {
  /* RELINK with no usable publish date: there is no historical context to resolve in, and today's cards are not
   * a substitute. The stored links stand; the row is counted as publish_date_unavailable. */
  if (policy.relink && existing && !validDate(entry.published)) { row.held = { publish_date_unavailable: true }; return keepStoredLinks(row, existing); }
  if (existing && existing.link_status === 'rejected') {
    /* A human rejection sticks: keep the stored links and status untouched. */
    row.fighter_ids = existing.fighter_ids || [];
    row.event_id = existing.event_id; row.bout_id = existing.bout_id; row.article_id = existing.article_id;
    row.resolver_confidence = existing.resolver_confidence; row.link_status = 'rejected';
    row.linking = existing.source_metadata?.linking || null;
    row.review_reason = existing.source_metadata?.review_reason || null;
    row.review = existing.source_metadata?.review || null;
    return row;
  }
  const l = linkVideo(entry, index, ctx);
  Object.assign(row, {
    fighter_ids: l.fighter_ids, event_id: l.event_id, bout_id: l.bout_id, article_id: l.article_id,
    resolver_confidence: l.resolver_confidence, link_status: l.link_status,
    linking: l.linking, review_reason: l.review_reason, review: l.review,
  });
  if (policy.relink && existing) {
    const held = {};
    /* The candidate count is article policy too: frozen with the link it describes. */
    if (!policy.allowArticleChange && row.linking && existing.source_metadata?.linking && 'article_candidates' in existing.source_metadata.linking) row.linking = { ...row.linking, article_candidates: existing.source_metadata.linking.article_candidates };
    if (!policy.allowArticleChange && (row.article_id ?? null) !== (existing.article_id ?? null)) {
      held.article_id = { stored: existing.article_id ?? null, proposed: row.article_id ?? null };
      row.article_id = existing.article_id ?? null;
      if (row.linking) row.linking = { ...row.linking, article_candidates: existing.source_metadata?.linking?.article_candidates ?? row.linking.article_candidates };
    }
    if (!policy.allowStatusChange && row.link_status !== existing.link_status) {
      held.link_status = { stored: existing.link_status, proposed: row.link_status, proposed_review_reason: row.review_reason };
      row.link_status = existing.link_status;
      row.review_reason = existing.source_metadata?.review_reason || null;
      row.review = existing.source_metadata?.review || null;
    }
    if (Object.keys(held).length) row.held = held;
  }
  return row;
}

/* `now` is a PARAMETER, not a closed-over module value. It used to be computed
 * at import, which froze the timestamp for the life of a Node process and, in
 * a Worker isolate, for the life of the isolate. */
function toDbRow(row, entry, existing, now) {
  const prev = existing?.source_metadata || {};
  const lang = detectLanguage(row.channel_name, entry.title, entry.description);
  const source_metadata = {
    ...prev,
    discovery: row.discovery,
    language: lang.language,
    language_method: lang.method,
    region_restriction: entry.region_restriction === undefined ? (prev.region_restriction ?? null) : entry.region_restriction,
    /* Region knowledge is only as good as its source (issue #19): the Data API
     * answer is proof, oEmbed is not. region_check says which one we have;
     * observed_region_block (a recorded player refusal) rides along in ...prev
     * and is never cleared by discovery. */
    region_check: entry.region_check || prev.region_check || null,
    feed_link: entry.link || prev.feed_link || null,
    is_short: entry.is_short ?? prev.is_short ?? null,
    feed_updated: entry.updated || prev.feed_updated || null,
    privacy_status: entry.privacy_status ?? prev.privacy_status ?? null,
    embed_check: entry.embed_check || prev.embed_check || null,
    classification: row.classification,
    linking: row.linking,
    review_reason: row.review_reason,
    review: row.review,
    linked_at: now.toISOString(),
  };
  if (entry.watch_page) source_metadata.watch_page = entry.watch_page;
  if (entry.playlists) source_metadata.playlists = entry.playlists;
  const playlistTitle = entry.playlist_title === undefined ? (prev.playlist_title || null) : entry.playlist_title;
  if (playlistTitle) source_metadata.playlist_title = playlistTitle;
  if (entry.playlist_id || prev.playlist_id) source_metadata.playlist_id = entry.playlist_id || prev.playlist_id;
  if (entry.playlist_title === null) delete source_metadata.playlist_title;
  const tuf = tufTag({ title: entry.title, description: entry.description, playlistTitle, durationSec: entry.duration_sec ?? null });
  if (tuf) source_metadata.tuf = tuf; else delete source_metadata.tuf;
  const { discovery, classification, linking, review_reason, review, ...cols } = row;
  return { ...cols, source_metadata, updated_at: now.toISOString() };
}

const COMPARE = ['channel_name', 'channel_verified_source', 'url', 'title', 'description', 'published_at', 'duration_sec', 'thumbnail_url', 'embeddable', 'live_broadcast_state', 'video_type', 'event_id', 'bout_id', 'article_id', 'resolver_confidence', 'link_status'];
function changed(dbRow, existing) {
  if (!existing) return true;
  for (const k of COMPARE) {
    const a = dbRow[k]; const b = existing[k];
    if (k === 'published_at') { if (isoOrNull(a) !== isoOrNull(b)) return true; continue; }
    if ((a ?? null) !== (b ?? null)) return true;
  }
  if (JSON.stringify([...(dbRow.fighter_ids || [])].sort()) !== JSON.stringify([...(existing.fighter_ids || [])].sort())) return true;
  const sm = existing.source_metadata || {};
  if (sm.discovery !== dbRow.source_metadata.discovery) return true;
  if (sm.language !== dbRow.source_metadata.language) return true;
  if (JSON.stringify(sm.region_restriction || null) !== JSON.stringify(dbRow.source_metadata.region_restriction || null)) return true;
  if ((sm.region_check?.method || null) !== (dbRow.source_metadata.region_check?.method || null)) return true;
  if ((sm.review_reason || null) !== (dbRow.source_metadata.review_reason || null)) return true;
  /* jsonb reorders object keys, so compare canonical (sorted-key) forms. */
  if (canonicalJson(sm.classification?.evidence || null) !== canonicalJson(dbRow.source_metadata.classification?.evidence || null)) return true;
  if (canonicalJson(sm.linking || null) !== canonicalJson(dbRow.source_metadata.linking || null)) return true;
  if (canonicalJson(sm.review || null) !== canonicalJson(dbRow.source_metadata.review || null)) return true;
  if (canonicalJson(sm.tuf || null) !== canonicalJson(dbRow.source_metadata.tuf || null)) return true;
  return false;
}

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

/* Archive rows only: drop an event reached through the bare TUF series head
 * unless the title supports it (lib.tufSeriesEventSupported). The rejected
 * candidate stays in the evidence. */
function guardTufSeriesEvent(row, entry, ctx, existing = null) {
  if (!row.event_id) return;
  const event = ctx.events.find((e) => e.id === row.event_id);
  const video = tufTag({ title: entry.title, description: entry.description, playlistTitle: entry.playlist_title ?? null, durationSec: entry.duration_sec ?? null });
  /* A relink has no playlist title, and the playlist is often what said this video is TUF at all. The tag stored
   * with the row is the same fact: without it the guard would stand down and a rejection made at backfill would
   * be erased simply because a relink happened. */
  const tag = video || existing?.source_metadata?.tuf || null;
  if (!tag) return;
  const verdict = tufSeriesEventSupported(
    { event_id: row.event_id, bout_id: row.bout_id, linking: row.linking },
    { title: entry.title, videoSeason: tag.season, eventSeason: event ? tufTag({ title: event.name })?.season ?? null : null },
  );
  if (verdict.supported) return;
  row.linking = { ...row.linking, event: null, event_rejected: { event_id: row.event_id, name: event?.name || null, ...row.linking?.event, ...verdict } };
  row.event_id = null; row.bout_id = null; row.article_id = null;
  const fighters = new Map((row.linking.fighters || []).map((f) => [f.fighter_id, f]));
  row.resolver_confidence = confidenceFor({ eventId: null, boutId: null, fighters });
}

/* One entry per provider_video_id across playlists. Every membership is kept;
 * the playlist title the TUF tag may read is kept only when the playlists that
 * name a season all name the same one. A video in both "TUF 22" and "TUF 21"
 * playlists gets no playlist-derived season rather than a guessed one. */
export function mergePlaylistEntries(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.video_id)) byId.set(e.video_id, { ...e, playlists: [] });
    const m = byId.get(e.video_id);
    if (!m.playlists.some((p) => p.id === e.playlist_id)) m.playlists.push({ id: e.playlist_id, title: e.playlist_title || null });
  }
  for (const m of byId.values()) {
    const seasons = new Map();
    for (const p of m.playlists) {
      const s = p.title ? tufTag({ title: '', playlistTitle: p.title })?.season : null;
      if (s) seasons.set(s, p);
    }
    if (seasons.size === 1) {
      const p = [...seasons.values()][0];
      m.playlist_id = p.id; m.playlist_title = p.title;
    } else if (seasons.size > 1) {
      m.playlist_id = m.playlists[0].id; m.playlist_title = null;
      m.playlist_season_conflict = [...seasons.keys()];
    }
    if (m.playlists.length === 1) delete m.playlists;
  }
  return [...byId.values()];
}

export async function main(injectedEnv, options = {}) {
  const env = injectedEnv || loadEnv();
  const sb = new Supabase(env);
  const DRY = Boolean(options.dry);
  const RELINK = Boolean(options.relink);
  const SINCE_DAYS = Number(options.sinceDays) || 30;
  const ONLY_CHANNEL = options.onlyChannel || null;
  const PLAYLISTS = Array.isArray(options.playlists) ? options.playlists.filter(Boolean) : [];
  const BACKFILL = PLAYLISTS.length > 0;
  if (BACKFILL && RELINK) throw new Error('--playlist and --relink are separate modes');
  const EXPLAIN = Boolean(options.explain);
  if (EXPLAIN && !DRY) throw new Error('--explain is a read-only report and requires --dry-run');
  const explained = [];
  const heldRows = [];
  const deferred = [];
  const now = options.now ? new Date(options.now) : new Date();
  const since = new Date(now.getTime() - SINCE_DAYS * 86400e3);
  const apiKey = env.YOUTUBE_API_KEY || '';
  const discovery = apiKey ? 'youtube_data_api_v3' : BACKFILL ? 'public_playlist_page' : 'atom_feed';

  let channels = await sb.select('ufc_video_channels', `select=provider,channel_id,name,handle,channel_class,verified,enabled&provider=eq.${PROVIDER}&enabled=is.true&verified=is.true&order=channel_class.asc,name.asc`);
  if (ONLY_CHANNEL) channels = channels.filter((c) => c.channel_id === ONLY_CHANNEL);
  if (!channels.length) throw new Error(ONLY_CHANNEL ? `channel ${ONLY_CHANNEL} is not enabled+verified in ufc_video_channels` : 'no enabled, verified channels: run scripts/videos/seed_channels.mjs first');

  const [index, ctx, archive] = await Promise.all([loadFighterIndex(sb), loadEventContext(sb, { now, windowDays: WINDOW_DAYS }), (BACKFILL || RELINK) ? loadArchiveEvents(sb) : null]);
  console.log(`${DRY ? 'DRY RUN  ' : ''}discovery=${discovery}${RELINK ? ' (relink, no network)' : ''} since=${since.toISOString().slice(0, 10)} channels=${channels.length}`);
  console.log(`index: ${index.fighters.length} fighters, ${ctx.events.length} events within +-${WINDOW_DAYS}d (${ctx.window.lo}..${ctx.window.hi}), ${ctx.bouts.length} bouts, ${ctx.cardFighterIds.size} card fighters`);
  if (archive) console.log(`archive: ${archive.events.length} events, ${archive.bouts.length} bouts; each playlist video is linked against the cards within +-${WINDOW_DAYS}d of its own publish date`);

  const totals = { fetched: 0, skipped_old: 0, new: 0, updated: 0, unchanged: 0, review: 0, embed_checks: 0, failed_channels: 0, skipped_not_allowlisted: 0, tuf_tagged: 0 };
  const byType = {}; const byConfidence = {};
  const plan = [];

  /* Backfill: read the playlists once, then hand each allowlisted channel the
   * items it uploaded. Items from any other channel are counted and dropped. */
  let playlistEntries = [];
  const playlistReports = [];
  if (BACKFILL) {
    const raw = [];
    for (const playlistId of PLAYLISTS) {
      try {
        const d = await discoverPlaylist(playlistId, { key: apiKey, now });
        raw.push(...d.entries);
        playlistReports.push({ id: playlistId, title: d.playlist.title, discovery: d.discovery, complete: d.complete, entries: d.entries.length, ...(d.stats || {}) });
        const st = d.stats || {};
        console.log(`playlist ${playlistId} "${d.playlist.title || '?'}": ${d.entries.length} item(s) via ${d.discovery}; complete=${d.complete}`
          + `${st.video_count != null ? ` (YouTube count ${st.video_count}, ${st.hidden_unavailable || 0} hidden as unavailable)` : ''}`
          + `${st.unreadable_watch_pages?.length ? `; unreadable watch pages: ${st.unreadable_watch_pages.join(',')}` : ''}${st.unread_continuation ? '; listing continuation not read' : ''}`);
      } catch (e) {
        totals.failed_channels += 1;
        playlistReports.push({ id: playlistId, failed: e.message });
        console.log(`playlist ${playlistId} FAILED: ${e.message}`);
      }
    }
    playlistEntries = mergePlaylistEntries(raw);
    totals.playlist_items = raw.length;
    totals.playlist_unique_videos = playlistEntries.length;
    const allowed = new Set(channels.map((c) => c.channel_id));
    for (const e of playlistEntries) if (!allowed.has(e.channel_id)) totals.skipped_not_allowlisted += 1;
  }

  for (const channel of channels) {
    const existingRows = await sb.select('ufc_videos', `select=id,provider_video_id,channel_name,channel_verified_source,url,title,description,published_at,duration_sec,thumbnail_url,embeddable,live_broadcast_state,video_type,fighter_ids,event_id,bout_id,article_id,resolver_confidence,link_status,source_metadata&provider=eq.${PROVIDER}&channel_id=eq.${encodeURIComponent(channel.channel_id)}`);
    const existingById = new Map(existingRows.map((r) => [r.provider_video_id, r]));

    let entries = [];
    let channelDiscovery = discovery;
    if (RELINK) {
      channelDiscovery = null;   /* keep whatever produced the row */
      entries = existingRows.map((r) => ({
        video_id: r.provider_video_id, title: r.title, description: r.description, published: r.published_at,
        link: r.source_metadata?.feed_link, is_short: r.source_metadata?.is_short, thumbnail_url: r.thumbnail_url,
        duration_sec: r.duration_sec, embeddable: r.embeddable, live_broadcast_state: r.live_broadcast_state,
        privacy_status: r.source_metadata?.privacy_status, updated: r.source_metadata?.feed_updated,
      }));
    } else if (BACKFILL) {
      entries = playlistEntries.filter((e) => e.channel_id === channel.channel_id);
      channelDiscovery = apiKey ? 'youtube_data_api_v3_playlist' : 'public_playlist_page';
      if (!entries.length) continue;
    } else {
      try {
        if (apiKey) {
          const d = await discoverViaDataApi(channel.channel_id, { key: apiKey, since, now });
          entries = d.entries;
        } else {
          const r = await fetchText(feedUrl(channel.channel_id));
          if (!r.ok) throw new Error(`feed http ${r.status}`);
          const parsed = parseYoutubeFeed(r.body);
          if (parsed.channel.id && parsed.channel.id !== channel.channel_id) throw new Error(`feed channel id mismatch: ${parsed.channel.id}`);
          entries = parsed.entries;
        }
      } catch (e) {
        totals.failed_channels += 1;
        console.log(`\n## ${channel.name} (${channel.channel_id}) FAILED: ${e.message}`);
        continue;
      }
    }
    totals.fetched += entries.length;
    console.log(`\n## ${channel.name} (${channel.channel_id}) ${channel.channel_class}: ${entries.length} ${RELINK ? 'stored' : 'discovered'}`);

    const rows = [];
    for (const entry of entries) {
      const pub = entry.published ? new Date(entry.published) : null;
      if (!RELINK && !BACKFILL && pub && pub < since) { totals.skipped_old += 1; continue; }
      if (RELINK && options.ids && !options.ids.has(entry.video_id)) continue;
      const existing = existingById.get(entry.video_id) || null;

      /* Feed path: oEmbed once per new video (or whenever the stored answer is still null). */
      if (!RELINK && !apiKey && (entry.embeddable == null) && (!existing || existing.embeddable == null)) {
        const chk = await checkEmbeddable(entry.video_id);
        totals.embed_checks += 1;
        /* The watch page's own "not playable in embed" overrides an oEmbed 200. */
        entry.embeddable = chk.embeddable === true && entry.watch_page?.playable_in_embed === false ? false : chk.embeddable;
        entry.embed_check = { method: 'oembed', status: chk.status, proves: chk.proves || null, author_name: chk.author_name || null, ...(entry.watch_page ? { watch_page_playable_in_embed: entry.watch_page.playable_in_embed } : {}), checked_at: now.toISOString() };
        await sleep(150);
      } else if (!RELINK && !apiKey && existing) {
        entry.embeddable = existing.embeddable;
      }

      const row = baseRow(entry, channel, channelDiscovery || existing?.source_metadata?.discovery || discovery);
      applyClassification(row, entry);
      /* A backfilled OR RELINKED video is linked against the cards around its own publish date. The date this
       * command happens to run must never change which event a video belongs to: a relink used to score all
       * stored rows against the cards around today, which detached the archive and re-attached 2021 videos
       * to 2026 cards (docs/evidence/video-relink-drift-2026-09-18.md). */
      const linkCtx = archive ? contextAt(archive, entry.published ? new Date(entry.published) : null, WINDOW_DAYS) : ctx;
      applyLinks(row, entry, index, linkCtx, existing, { relink: RELINK, allowArticleChange: Boolean(options.allowArticleChange), allowStatusChange: Boolean(options.allowStatusChange) });
      const held = row.held || null; delete row.held;
      if (held) { heldRows.push({ id: entry.video_id, title: entry.title, published_at: entry.published || null, ...held }); if (held.publish_date_unavailable) totals.publish_date_unavailable = (totals.publish_date_unavailable || 0) + 1; }
      if (archive && row.link_status !== 'rejected' && !(held && held.publish_date_unavailable)) guardTufSeriesEvent(row, entry, linkCtx, existing);
      const dbRow = toDbRow(row, entry, existing, now);
      if (dbRow.source_metadata.tuf) totals.tuf_tagged += 1;
      const isNew = !existing;
      const isChanged = changed(dbRow, existing);
      if (isNew) totals.new += 1; else if (isChanged) totals.updated += 1; else totals.unchanged += 1;
      bump(byType, dbRow.video_type); bump(byConfidence, dbRow.resolver_confidence);
      if (dbRow.link_status === 'review') totals.review += 1;

      const ev = dbRow.event_id ? linkCtx.events.find((e) => e.id === dbRow.event_id) : null;
      const names = dbRow.fighter_ids.map((id) => index.byId.get(id)?.name || id.slice(0, 8));
      const flag = isNew ? 'new' : isChanged ? 'upd' : '   ';
      console.log(`  ${flag} ${dbRow.provider_video_id} [${dbRow.video_type}/${dbRow.resolver_confidence}${dbRow.link_status === 'review' ? ' REVIEW' : ''}] emb=${dbRow.embeddable === null ? '?' : dbRow.embeddable ? 'y' : 'n'} ${dbRow.title.slice(0, 64)}`
        + `${ev ? ` | ev=${ev.name.slice(0, 32)}` : ''}${names.length ? ` | f=${names.join(', ')}` : ''}${dbRow.bout_id ? ' | bout' : ''}${dbRow.source_metadata.review_reason ? ` | review: ${dbRow.source_metadata.review_reason}` : ''}`);
      if (isNew || isChanged) rows.push(dbRow);
      if (EXPLAIN && isChanged && existing) {
        explained.push({ id: dbRow.provider_video_id, channel: channel.name, title: dbRow.title, published_at: dbRow.published_at, stored: project(existing), proposed: project(dbRow), ...diffRow(existing, dbRow), destructive: destructiveReasons(existing, dbRow, WINDOW_DAYS) });
      }
      plan.push({ channel: channel.name, id: dbRow.provider_video_id, action: isNew ? 'insert' : isChanged ? 'update' : 'unchanged', type: dbRow.video_type, confidence: dbRow.resolver_confidence, status: dbRow.link_status });
    }

    if (!rows.length) continue;
    if (DRY) { console.log(`  would upsert ${rows.length} rows`); continue; }
    /* A full relink writes nothing until the whole plan has passed the safety guard below. */
    if (RELINK && !options.ids) { deferred.push({ channel: channel.name, rows, existingById }); continue; }
    for (let i = 0; i < rows.length; i += 100) {
      const written = await sb.upsert('ufc_videos', rows.slice(i, i + 100), 'provider,provider_video_id');
      console.log(`  upserted ${written.length} rows`);
    }
  }

  /* FULL-RELINK SAFETY GUARD. A relink without --ids is planned in full first and refused in full if any row
   * would make a destructive move: an event lost or changed, a bout lost or changed, a fighter replaced, a
   * published<->review flip, or an event matched outside the date window. There is no override flag: a
   * destructive change that has been reviewed is applied by naming its rows with --ids. */
  if (deferred.length) {
    const blocked = [];
    for (const d of deferred) for (const r of d.rows) { const ex = d.existingById.get(r.provider_video_id); if (!ex) continue; const why = destructiveReasons(ex, r, WINDOW_DAYS); if (why.length) blocked.push({ id: r.provider_video_id, title: r.title, reasons: why }); }
    if (blocked.length) {
      for (const b of blocked.slice(0, 25)) console.log(`  BLOCKED ${b.id} ${b.reasons.join(',')} | ${String(b.title).slice(0, 70)}`);
      const err = new Error(`full relink refused: ${blocked.length} destructive change(s); nothing was written. Review with --dry-run --explain, then apply reviewed rows with --ids`);
      err.blocked = blocked;
      throw err;
    }
    for (const d of deferred) for (let i = 0; i < d.rows.length; i += 100) { const written = await sb.upsert('ufc_videos', d.rows.slice(i, i + 100), 'provider,provider_video_id'); console.log(`  upserted ${written.length} rows (${d.channel})`); }
  }

  console.log('\nsummary');
  console.log(`  discovery: ${discovery}${RELINK ? ' (relink)' : ''}; channels: ${channels.length} (${totals.failed_channels} failed)`);
  console.log(`  fetched: ${totals.fetched}, skipped (older than ${SINCE_DAYS}d): ${totals.skipped_old}, embed checks: ${totals.embed_checks}`);
  console.log(`  new: ${totals.new}, updated: ${totals.updated}, unchanged: ${totals.unchanged}${DRY ? ' (dry run: nothing written)' : ''}`);
  console.log(`  by type: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  console.log(`  by confidence: ${['high', 'medium', 'low', 'none'].map((k) => `${k}=${byConfidence[k] || 0}`).join(', ')}`);
  console.log(`  review: ${totals.review}`);
  console.log(`  TUF-tagged: ${totals.tuf_tagged}${BACKFILL ? `; playlist items ${totals.playlist_items}, unique videos ${totals.playlist_unique_videos}; from channels not allowlisted, skipped: ${totals.skipped_not_allowlisted}` : ''}`);
  if (DRY && plan.length) console.log(`  plan: ${plan.filter((p) => p.action === 'insert').length} inserts, ${plan.filter((p) => p.action === 'update').length} updates, ${plan.filter((p) => p.action === 'unchanged').length} unchanged`);

  if (heldRows.length) console.log(`  held (reported, not written): ${heldRows.filter((h) => h.article_id).length} article link(s), ${heldRows.filter((h) => h.link_status).length} status flip(s), ${heldRows.filter((h) => h.publish_date_unavailable).length} without a publish date`);
  if (EXPLAIN) {
    const byRisk = {}; for (const e of explained) byRisk[e.risk] = (byRisk[e.risk] || 0) + 1;
    console.log(`  explain: ${explained.length} row(s) would change; risk ${JSON.stringify(byRisk)}; stamp-only rewrites (no projected field differs): ${explained.filter((e) => !e.fields.length).length}`);
    if (options.explainOut) { const { writeFileSync } = await import('node:fs'); writeFileSync(options.explainOut, `${JSON.stringify({ generated_at: now.toISOString(), window: ctx.window, events_in_window: ctx.events.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date })), held: heldRows, rows: explained }, null, 1)}\n`); console.log(`  explain: wrote ${options.explainOut}`); }
  }

  /* Returned rather than logged-and-grepped, so a Worker can ledger it. */
  return { discovery, channels: channels.length, totals, by_type: byType, by_confidence: byConfidence, dry: DRY, relink: RELINK, ...(EXPLAIN ? { explained } : {}), held: heldRows, since: since.toISOString(), ...(BACKFILL ? { playlists: playlistReports } : {}) };
}

/* CLI ONLY. Importing this module must never call YouTube or write a row. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('ingest_youtube.mjs');
if (isCli) main(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
