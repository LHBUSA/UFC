/* ufc-video-autopilot — the authoritative owner of UFC video.
 *
 * Discovery, classification and entity resolution for official YouTube uploads.
 * Nothing else writes ufc_videos, and no other Worker decides which video
 * belongs to which fighter, bout, event or article — ufc-news-enrich ASKS this
 * lane through /resolve and attaches what it is given.
 *
 * The discovery, classification and linking logic is scripts/videos/*.mjs,
 * reused unchanged: official/approved channels only, verified+enabled in
 * ufc_video_channels, embeddability confirmed via the Data API or oEmbed,
 * language detection, and confidence-gated linking. This Worker supplies the
 * schedule, the ledger and the resolution endpoint.
 *
 * WHAT IT REPLACES. `.github/workflows/video-autopilot.yml`, cron
 * `17,47 * * * *`, still running on GitHub. It is disabled only once this lane
 * has produced a clean run, so the lane is never unowned.
 *
 * THE RULE THAT MATTERS FOR ARTICLES
 *
 * "Do not add loosely related videos merely to make the page look richer." The
 * ingest already computes resolver_confidence and link_status; /resolve simply
 * refuses to serve anything below high confidence. A page with no video is a
 * correct page when no video confidently belongs to the story.
 *
 * Endpoints
 *   GET  /health          unauthenticated, no side effects
 *   GET  /resolve         videos for a fighter/bout/event/article, high confidence only
 *   POST /admin/run       run discovery now (?dry=true, ?since=N, ?relink=true)
 */
import { main as ingestYoutube } from '../../../scripts/videos/ingest_youtube.mjs';
import { videoAvailability, availabilityRank, POLICY_REGION } from '../../../scripts/videos/lib.mjs';

const WORKER = 'ufc-video-autopilot';
const VERSION = 'v0.2.0';
const PROVIDER = 'youtube';

const health = { last_run_at: null, last_status: null, last_result: null, last_error: null };
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), {
  status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i += 1) d |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return d === 0;
}

async function sb(env, method, path, { body, prefer } = {}) {
  const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* Language lives in source_metadata, not in a column. Selecting a column that
 * does not exist makes PostgREST reject the WHOLE query with a 42703, so a
 * guessed field name is not a missing value -- it is a dead endpoint. */
const VIDEO_COLS = 'id,provider,provider_video_id,channel_id,channel_name,channel_verified_source,url,title,'
  + 'description,published_at,duration_sec,thumbnail_url,embeddable,video_type,'
  + 'fighter_ids,event_id,bout_id,article_id,resolver_confidence,link_status,source_metadata';

/**
 * Videos that confidently belong to a subject.
 *
 * FIVE CONDITIONS, ALL REQUIRED, and each one is a way a page gets a video it
 * should not have:
 *
 *   resolver_confidence = high   the linker was sure, not merely willing
 *   link_status != rejected      a human's rejection is final
 *   embeddable = true            an unembeddable video renders as a dead box
 *   not known region-blocked     for POLICY_REGION (US): Data API
 *                                regionRestriction or a recorded
 *                                observed_region_block (issue #19)
 *   the subject actually matches  fighter/bout/event/article, not "related"
 *
 * embeddable=true is NOT proof of playability. On the feed path it comes from
 * oEmbed, which answered 200 for UFC Brasil's XMK-nCzDxGo although the video
 * does not play in the U.S. So every served video carries `availability`:
 * 'playable' only when the Data API answered the region question, otherwise
 * 'unverified' -- and inside a tier, unverified clips from regional channels
 * (UFC Brasil / UFC Espanol / ...) rank after everything else. The page
 * re-checks live state and its player falls back at runtime.
 *
 * Ordering prefers a bout link over an event link over a fighter link, because
 * a video about THIS fight beats a video about the card it is on, which beats a
 * video about one of the fighters some other time.
 */
export async function resolveVideos(env, { fighterId, boutId, eventId, articleId, limit = 3 } = {}) {
  if (!fighterId && !boutId && !eventId && !articleId) return { videos: [], tier: null, reason: 'no subject given' };

  /* THE RELEVANCE HIERARCHY, strongest first. The rule it encodes is that a
   * video must involve THE SUBJECT of the story, not merely the card the
   * subject appears on.
   *
   *   1  the article itself
   *   2  the exact bout, and the primary fighter is in it
   *   3  the exact event, AND the primary fighter is in the video
   *   4  an official video involving the primary fighter, any time
   *   5  nothing
   *
   * Tier 3 is where the previous version was wrong: it matched on event alone,
   * which attaches a generic same-card clip to a story about someone who is not
   * in it. Every tier below the first therefore carries the fighter predicate.
   *
   * A video does not have to have been ingested FOR this article to belong to
   * it — the fighter/bout/event graph is what connects them, and history counts
   * as much as this morning's discovery. */
  const tiers = [];
  if (articleId) tiers.push({ tier: 1, name: 'article', filter: `article_id=eq.${articleId}` });
  if (boutId && fighterId) tiers.push({ tier: 2, name: 'bout+fighter', filter: `bout_id=eq.${boutId}&fighter_ids=cs.{${fighterId}}` });
  if (boutId && !fighterId) tiers.push({ tier: 2, name: 'bout', filter: `bout_id=eq.${boutId}` });
  if (eventId && fighterId) tiers.push({ tier: 3, name: 'event+fighter', filter: `event_id=eq.${eventId}&fighter_ids=cs.{${fighterId}}` });
  if (fighterId) tiers.push({ tier: 4, name: 'fighter', filter: `fighter_ids=cs.{${fighterId}}` });

  const seen = new Map();
  const suppressed = new Map();
  let matchedTier = null;
  for (const t of tiers) {
    /* Over-fetch so a region-blocked clip does not cost the tier its slot. */
    const rows = await sb(env, 'GET',
      `ufc_videos?select=${VIDEO_COLS}&${t.filter}&provider=eq.${PROVIDER}`
      + `&resolver_confidence=eq.high&link_status=neq.rejected&embeddable=is.true`
      + `&order=published_at.desc&limit=${Math.min(20, limit * 4)}`);
    const usable = [];
    for (const v of rows || []) {
      const availability = videoAvailability(v, POLICY_REGION);
      if (availability === 'playable' || availability === 'unverified') usable.push({ v, availability });
      else suppressed.set(v.provider_video_id, availability);
    }
    /* Stable sort: published_at desc survives inside each availability rank. */
    usable.sort((x, y) => availabilityRank(x.v, POLICY_REGION) - availabilityRank(y.v, POLICY_REGION));
    for (const { v, availability } of usable) {
      if (seen.size >= limit) break;
      if (!seen.has(v.id)) { seen.set(v.id, { ...v, _tier: t.tier, _tier_name: t.name, _availability: availability }); }
    }
    if (seen.size) { matchedTier = matchedTier ?? t.tier; }
    if (seen.size >= limit) break;
  }

  const videos = [...seen.values()].slice(0, limit).map((v) => ({
    id: v.id,
    provider: v.provider,
    video_id: v.provider_video_id,
    url: v.url,
    title: v.title,
    /* Attribution travels WITH the video. A page that embeds a channel's work
     * without naming the channel is not attribution, and the renderer should
     * never have to look it up separately or be able to forget it. */
    publisher: v.channel_name,
    channel_id: v.channel_id,
    channel_verified_source: v.channel_verified_source,
    published_at: v.published_at,
    /* Null when discovery came from the Atom feed rather than the Data API.
     * Left null rather than guessed, and never a publication requirement. */
    duration_sec: v.duration_sec ?? null,
    thumbnail_url: v.thumbnail_url,
    language: v.source_metadata?.language ?? null,
    video_type: v.video_type,
    embeddable: v.embeddable,
    /* Availability travels with the copy the article stores, so the page
     * never has to trust `embeddable` as proof of playability. */
    availability: v._availability,
    policy_region: POLICY_REGION,
    region_verified: v._availability === 'playable',
    region_restriction: v.source_metadata?.region_restriction ?? null,
    observed_region_block: v.source_metadata?.observed_region_block ?? null,
    matched_tier: v._tier,
    matched_on: v._tier_name,
    resolver_confidence: v.resolver_confidence,
  }));

  return {
    videos,
    tier: matchedTier,
    suppressed_by_policy: [...suppressed].map(([video_id, availability]) => ({ video_id, availability, region: POLICY_REGION })),
    reason: videos.length ? null
      : suppressed.size
        ? `no high-confidence video involving this story subject is playable in ${POLICY_REGION} (${suppressed.size} suppressed by availability policy)`
        : 'no high-confidence embeddable video involves this story subject (tier 5: none)',
  };
}

/* ---- ledger ------------------------------------------------------------- */

async function openRun(env, invoked) {
  const rows = await sb(env, 'POST', 'ufc_ingest_runs', {
    body: [{ worker: WORKER, status: 'running', notes: { lane: 'videos', invoked } }],
    prefer: 'return=representation',
  });
  return rows?.[0]?.id || null;
}
async function closeRun(env, id, status, notes) {
  if (!id) return;
  try {
    await sb(env, 'PATCH', `ufc_ingest_runs?id=eq.${id}`,
      { body: { status, finished_at: new Date().toISOString(), notes }, prefer: 'return=minimal' });
  } catch (e) { console.error(`[${WORKER}] close run ${id}: ${String(e.message).slice(0, 200)}`); }
}

async function runVideos(env, { dry = false, sinceDays = 30, relink = false, onlyChannel = null, invoked = 'cron', cron = null } = {}) {
  health.last_run_at = new Date().toISOString();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured', error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' };
  }

  let runId = null;
  if (!dry) {
    try { runId = await openRun(env, invoked); }
    catch (e) {
      health.last_status = 'ledger_open_failed';
      health.last_error = String(e.message).slice(0, 200);
      return { status: 'ledger_open_failed', error: health.last_error };
    }
  }

  try {
    const result = await ingestYoutube(env, { dry, sinceDays, relink, onlyChannel, now: Date.now() });
    health.last_status = 'success';
    health.last_result = result;
    health.last_error = null;
    const t = result.totals || {};
    console.log(`[${WORKER}] ${dry ? 'DRY ' : ''}ok discovery=${result.discovery} channels=${result.channels} `
      + `fetched=${t.fetched} new=${t.new} updated=${t.updated} unchanged=${t.unchanged} review=${t.review}`);
    await closeRun(env, runId, 'success', { lane: 'videos', invoked, cron, ...result });
    return { status: 'success', dry, result };
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 400);
    health.last_status = 'failed';
    health.last_error = detail;
    console.error(`[${WORKER}] FAILED: ${detail}`);
    await closeRun(env, runId, 'failed', { lane: 'videos', invoked, cron, error: detail });
    return { status: 'failed', error: detail };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      let counts = null;
      try {
        const [total, high, channels] = await Promise.all([
          sb(env, 'GET', 'ufc_videos?select=id&limit=1', { prefer: 'count=exact' }).then(() => null).catch(() => null),
          sb(env, 'GET', `ufc_videos?select=id,resolver_confidence&provider=eq.${PROVIDER}&resolver_confidence=eq.high&limit=1000`),
          sb(env, 'GET', 'ufc_video_channels?select=name,channel_class,verified,enabled&order=name.asc'),
        ]);
        counts = {
          high_confidence_videos: high?.length ?? null,
          channels_enabled_verified: (channels || []).filter((c) => c.verified && c.enabled).length,
          channels_total: (channels || []).length,
        };
      } catch (e) { counts = { error: String(e.message).slice(0, 160) }; }
      return json({
        service: WORKER, version: VERSION, ...health,
        lane: 'videos',
        replaces: 'video-autopilot.yml cron "17,47 * * * *" on a GitHub runner',
        cron: '13,43 * * * *',
        policy: {
          channels: 'official/approved only; verified AND enabled in ufc_video_channels',
          embeddable: 'required — an unembeddable video renders as a dead box',
          availability: `oEmbed 200 proves an embed page exists, NOT playability in ${POLICY_REGION}. `
            + 'playable = Data API region answer allows it; unverified = no region answer (served, ranked after proven clips, regional channels last; the page player falls back at runtime); '
            + 'blocked = Data API regionRestriction or source_metadata.observed_region_block (never served)',
          region_proof: env.YOUTUBE_API_KEY ? 'youtube_data_api_v3 contentDetails.regionRestriction' : 'NONE — no YOUTUBE_API_KEY, every feed-path row is unverified',
          attach_rule: 'resolver_confidence=high only; a page with no video is correct when none confidently belongs',
        },
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          YOUTUBE_API_KEY: Boolean(env.YOUTUBE_API_KEY),
        },
        discovery: env.YOUTUBE_API_KEY ? 'youtube_data_api_v3' : 'atom_feed + oEmbed (duration unavailable)',
        ...counts,
        writes: 'ufc_videos, ufc_ingest_runs. Never ufc_articles, never storage.',
      });
    }

    if (url.pathname === '/resolve') {
      const q = url.searchParams;
      try {
        const out = await resolveVideos(env, {
          fighterId: q.get('fighter'), boutId: q.get('bout'),
          eventId: q.get('event'), articleId: q.get('article'),
          limit: Math.min(5, Math.max(1, Number(q.get('limit')) || 3)),
        });
        return json({ service: WORKER, ...out });
      } catch (e) { return json({ error: String(e.message).slice(0, 200) }, 500); }
    }

    if (req.method !== 'POST' || !authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const dry = url.searchParams.get('dry') === 'true';
      const relink = url.searchParams.get('relink') === 'true';
      const sinceDays = Math.min(365, Math.max(1, Number(url.searchParams.get('since')) || 30));
      const onlyChannel = url.searchParams.get('channel') || null;
      return json({ service: WORKER, version: VERSION, ...(await runVideos(env, { dry, relink, sinceDays, onlyChannel, invoked: 'manual' })) });
    }
    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runVideos(env, { invoked: 'cron', cron: event.cron, sinceDays: 14 }));
  },
};
