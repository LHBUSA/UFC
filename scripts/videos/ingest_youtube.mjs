#!/usr/bin/env node
/* Pull the newest uploads of every enabled, verified channel in
 * ufc_video_channels into ufc_videos (docs/videos.md).
 *
 *   node scripts/videos/ingest_youtube.mjs [--dry-run] [--since-days N] [--channel <id>] [--relink]
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
 */
import { canonicalJson } from '../news/lib.mjs';
import { detectLanguage,
  Supabase, loadEnv, loadFighterIndex, fetchText,
  PROVIDER, WINDOW_DAYS, feedUrl, watchUrl, parseYoutubeFeed, checkEmbeddable, discoverViaDataApi,
  classifyVideo, loadEventContext, linkVideo, sleep,
} from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const RELINK = args.includes('--relink');
const SINCE_DAYS = Number(args[args.indexOf('--since-days') + 1] || 30) || 30;
const ONLY_CHANNEL = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : null;
const MAX_DESCRIPTION = 6000;

const now = new Date();
const since = new Date(now.getTime() - SINCE_DAYS * 86400e3);

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

function applyLinks(row, entry, index, ctx, existing) {
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
  return row;
}

function toDbRow(row, entry, existing) {
  const prev = existing?.source_metadata || {};
  const lang = detectLanguage(row.channel_name, entry.title, entry.description);
  const source_metadata = {
    ...prev,
    discovery: row.discovery,
    language: lang.language,
    language_method: lang.method,
    region_restriction: entry.region_restriction === undefined ? (prev.region_restriction ?? null) : entry.region_restriction,
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
  if ((sm.review_reason || null) !== (dbRow.source_metadata.review_reason || null)) return true;
  /* jsonb reorders object keys, so compare canonical (sorted-key) forms. */
  if (canonicalJson(sm.classification?.evidence || null) !== canonicalJson(dbRow.source_metadata.classification?.evidence || null)) return true;
  if (canonicalJson(sm.linking || null) !== canonicalJson(dbRow.source_metadata.linking || null)) return true;
  if (canonicalJson(sm.review || null) !== canonicalJson(dbRow.source_metadata.review || null)) return true;
  return false;
}

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

async function main() {
  const env = loadEnv();
  const sb = new Supabase(env);
  const apiKey = env.YOUTUBE_API_KEY || '';
  const discovery = apiKey ? 'youtube_data_api_v3' : 'atom_feed';

  let channels = await sb.select('ufc_video_channels', `select=provider,channel_id,name,handle,channel_class,verified,enabled&provider=eq.${PROVIDER}&enabled=is.true&verified=is.true&order=channel_class.asc,name.asc`);
  if (ONLY_CHANNEL) channels = channels.filter((c) => c.channel_id === ONLY_CHANNEL);
  if (!channels.length) throw new Error(ONLY_CHANNEL ? `channel ${ONLY_CHANNEL} is not enabled+verified in ufc_video_channels` : 'no enabled, verified channels: run scripts/videos/seed_channels.mjs first');

  const [index, ctx] = await Promise.all([loadFighterIndex(sb), loadEventContext(sb, { now, windowDays: WINDOW_DAYS })]);
  console.log(`${DRY ? 'DRY RUN  ' : ''}discovery=${discovery}${RELINK ? ' (relink, no network)' : ''} since=${since.toISOString().slice(0, 10)} channels=${channels.length}`);
  console.log(`index: ${index.fighters.length} fighters, ${ctx.events.length} events within +-${WINDOW_DAYS}d (${ctx.window.lo}..${ctx.window.hi}), ${ctx.bouts.length} bouts, ${ctx.cardFighterIds.size} card fighters`);

  const totals = { fetched: 0, skipped_old: 0, new: 0, updated: 0, unchanged: 0, review: 0, embed_checks: 0, failed_channels: 0 };
  const byType = {}; const byConfidence = {};
  const plan = [];

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
    } else {
      try {
        if (apiKey) {
          const d = await discoverViaDataApi(channel.channel_id, { key: apiKey, since });
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
      if (!RELINK && pub && pub < since) { totals.skipped_old += 1; continue; }
      const existing = existingById.get(entry.video_id) || null;

      /* Feed path: oEmbed once per new video (or whenever the stored answer is still null). */
      if (!RELINK && !apiKey && (entry.embeddable == null) && (!existing || existing.embeddable == null)) {
        const chk = await checkEmbeddable(entry.video_id);
        totals.embed_checks += 1;
        entry.embeddable = chk.embeddable;
        entry.embed_check = { method: 'oembed', status: chk.status, author_name: chk.author_name || null, checked_at: now.toISOString() };
        await sleep(150);
      } else if (!RELINK && !apiKey && existing) {
        entry.embeddable = existing.embeddable;
      }

      const row = baseRow(entry, channel, channelDiscovery || existing?.source_metadata?.discovery || discovery);
      applyClassification(row, entry);
      applyLinks(row, entry, index, ctx, existing);
      const dbRow = toDbRow(row, entry, existing);
      const isNew = !existing;
      const isChanged = changed(dbRow, existing);
      if (isNew) totals.new += 1; else if (isChanged) totals.updated += 1; else totals.unchanged += 1;
      bump(byType, dbRow.video_type); bump(byConfidence, dbRow.resolver_confidence);
      if (dbRow.link_status === 'review') totals.review += 1;

      const ev = dbRow.event_id ? ctx.events.find((e) => e.id === dbRow.event_id) : null;
      const names = dbRow.fighter_ids.map((id) => index.byId.get(id)?.name || id.slice(0, 8));
      const flag = isNew ? 'new' : isChanged ? 'upd' : '   ';
      console.log(`  ${flag} ${dbRow.provider_video_id} [${dbRow.video_type}/${dbRow.resolver_confidence}${dbRow.link_status === 'review' ? ' REVIEW' : ''}] emb=${dbRow.embeddable === null ? '?' : dbRow.embeddable ? 'y' : 'n'} ${dbRow.title.slice(0, 64)}`
        + `${ev ? ` | ev=${ev.name.slice(0, 32)}` : ''}${names.length ? ` | f=${names.join(', ')}` : ''}${dbRow.bout_id ? ' | bout' : ''}${dbRow.source_metadata.review_reason ? ` | review: ${dbRow.source_metadata.review_reason}` : ''}`);
      if (isNew || isChanged) rows.push(dbRow);
      plan.push({ channel: channel.name, id: dbRow.provider_video_id, action: isNew ? 'insert' : isChanged ? 'update' : 'unchanged', type: dbRow.video_type, confidence: dbRow.resolver_confidence, status: dbRow.link_status });
    }

    if (!rows.length) continue;
    if (DRY) { console.log(`  would upsert ${rows.length} rows`); continue; }
    for (let i = 0; i < rows.length; i += 100) {
      const written = await sb.upsert('ufc_videos', rows.slice(i, i + 100), 'provider,provider_video_id');
      console.log(`  upserted ${written.length} rows`);
    }
  }

  console.log('\nsummary');
  console.log(`  discovery: ${discovery}${RELINK ? ' (relink)' : ''}; channels: ${channels.length} (${totals.failed_channels} failed)`);
  console.log(`  fetched: ${totals.fetched}, skipped (older than ${SINCE_DAYS}d): ${totals.skipped_old}, embed checks: ${totals.embed_checks}`);
  console.log(`  new: ${totals.new}, updated: ${totals.updated}, unchanged: ${totals.unchanged}${DRY ? ' (dry run: nothing written)' : ''}`);
  console.log(`  by type: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  console.log(`  by confidence: ${['high', 'medium', 'low', 'none'].map((k) => `${k}=${byConfidence[k] || 0}`).join(', ')}`);
  console.log(`  review: ${totals.review}`);
  if (DRY && plan.length) console.log(`  plan: ${plan.filter((p) => p.action === 'insert').length} inserts, ${plan.filter((p) => p.action === 'update').length} updates, ${plan.filter((p) => p.action === 'unchanged').length} unchanged`);
}

main().catch((e) => { console.error(e); process.exit(1); });
