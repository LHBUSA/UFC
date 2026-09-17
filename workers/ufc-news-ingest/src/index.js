/* ufc-news-ingest — detection for the real-time UFC newsroom.
 *
 * The half of the pipeline that turns "a publisher posted something" into "a
 * row exists, and we know when we first saw it". It ends there. Nothing in this
 * Worker calls a model, fetches an article body, writes ufc_articles, or
 * changes anything the public can see.
 *
 * WHY IT EXISTS SEPARATELY FROM ufc-newsroom
 *
 * Detection cadence and editorial cadence are different problems. ufc-newsroom
 * ingests every 30 minutes under a global 20-minute Durable Object lock, which
 * is correct for batch editorial work and fatal for a 10-minute
 * detection-to-publish target: half the budget is gone before anything is even
 * noticed. This Worker runs every two minutes, holds no global lock, and is
 * safe to run concurrently with anything because it only ever offers rows to
 * two unique constraints and lets the database arbitrate.
 *
 * QUEUE PRODUCER
 *
 * When QUEUE_PRODUCER_ENABLED=true and UFC_NEWS_QUEUE is bound, runIngest
 * sends newly inserted scoreable items to ufc-news-enrich immediately. The
 * database row remains the durable source of truth; queue delivery is best
 * effort because the enricher's claim loop can recover anything a queue outage
 * misses. /health reports both the flag and binding so the production state is
 * observable instead of inferred from deployment history.
 *
 * ENDPOINTS
 *   GET  /health          unauthenticated, no side effects, no writes
 *   GET  /feeds           enabled source inventory
 *   GET  /feeds/health    per-feed circuit state and latency
 *   POST /admin/run       run an ingest now  (?dry=true to change nothing)
 *   POST /admin/verify    probe every candidate feed (?apply=true to reconcile)
 *   POST /admin/probe     probe one arbitrary URL, changing nothing
 *   POST /feeds/reset     clear one feed's circuit
 *
 * Every mutating route is POST behind ADMIN_TRIGGER_TOKEN, so a crawler or a
 * preview scanner cannot cause a write. Missing token means the route 404s
 * rather than 401s: an unauthenticated caller learns nothing about what exists.
 */
import { Supabase } from './supabase.mjs';
import { runIngest, WORKER, FETCH_TIMEOUT_MS, MAX_AGE_DAYS } from './ingest.mjs';
import { verifySources, probeUrl, CANDIDATES, MIN_ITEMS, MIN_DATED_RATIO, MIN_UFC_RATIO } from './sources.mjs';
import { loadHealth, resetHealth, summarize, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS } from './feed_health.mjs';
import { statusPass, statusDue, loadStatusHealth, STATUS_PERIOD_MIN, STATUS_WINDOW_HOURS } from './status.mjs';

const VERSION = 'v0.2.1';

/* In-memory only: survives a warm isolate and nothing more. The durable record
 * is ufc_news_pipeline_events; this is a convenience for whoever curls it. */
const health = { last_run_at: null, last_status: null, last_inserted: null, last_duration_ms: null, last_error: null };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

/* Fails CLOSED. No token configured, wrong length, or mismatch -> 404.
 * Constant-time over the expected length. */
function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export const queueProducerEnabled = (env) => String(env.QUEUE_PRODUCER_ENABLED || 'false').toLowerCase() === 'true';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/health') {
      let sourceCount = null;
      try { sourceCount = await new Supabase(env).count('ufc_news_sources', 'kind=eq.rss&enabled=is.true'); } catch { /* reported as null */ }
      return json({
        service: WORKER,
        version: VERSION,
        ...health,
        cron: '*/2 * * * *',
        queue_producer_enabled: queueProducerEnabled(env),
        queue_binding_present: Boolean(env.UFC_NEWS_QUEUE),
        enabled_rss_sources: sourceCount,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          UFC_NEWS_KV: Boolean(env.UFC_NEWS_KV),
        },
        defenses: {
          per_fetch_timeout_ms: FETCH_TIMEOUT_MS,
          circuit_failure_threshold: CIRCUIT_FAILURE_THRESHOLD,
          circuit_cooldown_hours: CIRCUIT_COOLDOWN_MS / 3600e3,
          conditional_fetching: 'etag + if-modified-since',
          max_item_age_days: MAX_AGE_DAYS,
          ufc_focus_filter: 'foreign promotion named with no UFC anchor -> skipped, never scored',
        },
        verification_standard: { min_items: MIN_ITEMS, min_dated_ratio: MIN_DATED_RATIO, min_ufc_ratio: MIN_UFC_RATIO },
        /* Fighter availability: extraction + lifecycle over the items this
         * Worker just stored. Deterministic rules, no model, no articles. */
        fighter_status: {
          trigger: `after any ingest that inserted items, and every ${STATUS_PERIOD_MIN} minutes regardless`,
          window_hours: STATUS_WINDOW_HOURS,
          ...(await loadStatusHealth(env.UFC_NEWS_KV)),
        },
        writes: 'ufc_news_items, ufc_news_pipeline_events(detect), ufc_news_sources(via /admin/verify?apply), ufc_fighter_status_events(status pass), ufc_ingest_runs(worker=ufc-fighter-status). Never ufc_articles.',
      });
    }

    if (path === '/feeds') {
      const sb = new Supabase(env);
      const rows = await sb.select('ufc_news_sources', 'select=name,url,kind,enabled,weight&order=kind.asc,name.asc');
      return json({
        service: WORKER,
        enabled: rows.filter((r) => r.enabled),
        disabled: rows.filter((r) => !r.enabled),
        candidates_known: CANDIDATES.map((c) => c.name),
      });
    }

    if (path === '/feeds/health') {
      const sb = new Supabase(env);
      const rows = await sb.select('ufc_news_sources', 'select=name,url&kind=eq.rss&enabled=is.true&order=name.asc');
      const now = Date.now();
      const out = [];
      for (const r of rows) out.push(summarize(r.name, await loadHealth(env.UFC_NEWS_KV, r.name), now));
      return json({ service: WORKER, kv_bound: Boolean(env.UFC_NEWS_KV), feeds: out });
    }

    /* ---- mutating routes ------------------------------------------------ */
    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (path === '/admin/run') {
      const dry = url.searchParams.get('dry') === 'true';
      const result = await run(env, { dry });
      return json({ service: WORKER, version: VERSION, ...result });
    }

    if (path === '/admin/status') {
      /* Manual status pass. Dry by default; ?write=true stores and transitions.
       * ?since_hours widens the window (max 720) for a reviewed backfill. */
      const write = url.searchParams.get('write') === 'true';
      const sinceHours = Math.min(720, Number(url.searchParams.get('since_hours')) || STATUS_WINDOW_HOURS);
      return json({ service: WORKER, version: VERSION, ...(await statusPass(env, { trigger: 'admin', write, sinceHours, detail: true })) });
    }

    if (path === '/admin/verify') {
      const sb = new Supabase(env);
      const apply = url.searchParams.get('apply') === 'true';
      const only = url.searchParams.get('only');
      return json({ service: WORKER, ...(await verifySources(env, sb, { dry: !apply, only })) });
    }

    if (path === '/admin/probe') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'url_required' }, 400);
      return json({ service: WORKER, probe: await probeUrl(target) });
    }

    if (path === '/feeds/reset') {
      const source = url.searchParams.get('source');
      if (!source) return json({ error: 'source_required' }, 400);
      return json({ service: WORKER, source, reset: await resetHealth(env.UFC_NEWS_KV, source) });
    }

    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await run(env, { cron: event.cron });
      /* news ingest -> status extraction -> lifecycle. Immediately when new
       * items landed, and on a bounded period even when none did, so the
       * lifecycle still ages statuses on a quiet news day. A status failure is
       * contained here and never touches the ingest result. */
      const inserted = Number(result?.totals?.inserted || 0);
      if (inserted > 0 || statusDue(event.scheduledTime)) {
        await statusPass(env, { trigger: inserted > 0 ? `ingest(+${inserted})` : 'periodic', write: true });
      }
    })());
  },
};

async function run(env, { dry = false, cron = null } = {}) {
  health.last_run_at = new Date().toISOString();
  let sb;
  try {
    sb = new Supabase(env);
  } catch (e) {
    health.last_status = 'misconfigured';
    health.last_error = e.message;
    console.error(`[${WORKER}] ${e.message}`);
    return { status: 'misconfigured', error: e.message };
  }

  try {
    const result = await runIngest(env, sb, { dry });
    health.last_status = result.status;
    health.last_inserted = result.totals?.inserted ?? null;
    health.last_duration_ms = result.duration_ms ?? null;
    health.last_error = null;
    const t = result.totals || {};
    console.log(`[${WORKER}] ${result.status} cron=${cron} ${result.duration_ms}ms sources=${t.sources} ok=${t.fetched_ok} 304=${t.not_modified} fail=${t.failed} parsed=${t.parsed} candidates=${t.candidates} focus_rejected=${t.focus_rejected} inserted=${t.inserted} enqueued=${t.enqueued || 0}`);
    if (t.enqueue_error) console.error(`[${WORKER}] queue enqueue failed: ${t.enqueue_error}`);
    return result;
  } catch (e) {
    health.last_status = 'failed';
    health.last_error = String(e?.message || e).slice(0, 300);
    console.error(`[${WORKER}] run failed: ${health.last_error}`);
    return { status: 'failed', error: health.last_error };
  }
}
