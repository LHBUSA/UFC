/* ufc-news-enrich — the article factory.
 *
 * Takes a detected wire item and turns it into a PropBetEdge UFC article:
 * relevance, primary-entity resolution, full source fetch, first-party
 * intelligence packet, GPT-5.6 Sol, deterministic validation, dedupe, hero,
 * and a private row.
 *
 * PUBLICATION IS DISABLED. PUBLISH_ENABLED is "false" and everything written
 * lands at status='review', which the site and API already treat as private.
 * The pipeline is complete to the last step on purpose: the quality of what it
 * produces can then be judged on real articles rather than argued about, and
 * turning it on is a config change with a visible blast radius rather than new
 * code written under pressure.
 *
 * TWO WAYS IN, ONE PATH THROUGH.
 *   queue     ufc-news-candidates, produced by ufc-news-ingest. The fast path.
 *   cron      a claim loop that also reclaims items whose consumer died. This
 *             is not a backup for the queue, it is how the backlog drains and
 *             how a stalled lease is recovered.
 * Both call processItem, which owns the state machine, so there is no second
 * implementation to drift.
 *
 * Endpoints
 *   GET  /health          unauthenticated, no side effects, no model call
 *   GET  /recent          the last articles this Worker produced, with proof
 *   POST /admin/run       run the claim loop now  (?limit=N)
 *   POST /admin/item      run one specific item   (?id=UUID)
 */
import { Supabase } from './supabase.mjs';
import { processItem, pickCandidates, reclaimStalled, WORKER } from './pipeline.mjs';
import { isConfigured, DEFAULT_MODEL, DESK_VERSION } from './editorial.mjs';
import { SCORER_MODEL } from './relevance.mjs';

const VERSION = 'v0.1.0';
const health = { last_run_at: null, last_status: null, last_written: null, last_error: null };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const publishEnabled = (env) => String(env.PUBLISH_ENABLED || 'false').toLowerCase() === 'true';

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      let counts = null;
      try {
        const sb = new Supabase(env);
        counts = {
          scoreable: await sb.count('ufc_news_items', 'state=eq.new'),
          enriching: await sb.count('ufc_news_items', 'state=eq.enriching'),
          held: await sb.count('ufc_news_items', 'state=eq.held'),
          duplicate: await sb.count('ufc_news_items', 'state=eq.duplicate'),
          failed: await sb.count('ufc_news_items', 'state=eq.failed'),
          articles_by_this_worker: await sb.count('ufc_articles', `model_version=like.*${DESK_VERSION}`),
        };
      } catch (e) { counts = { error: String(e.message).slice(0, 160) }; }
      return json({
        service: WORKER, version: VERSION, ...health,
        /* The single most important fact about this deployment. */
        publish_enabled: publishEnabled(env),
        writes_articles_as: publishEnabled(env) ? 'published' : 'review (private)',
        editorial_model: env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL,
        relevance_model: env.UFC_RELEVANCE_MODEL || SCORER_MODEL,
        gate: DESK_VERSION,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          OPENAI_API_KEY: isConfigured(env),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
        },
        pipeline_states: counts,
      });
    }

    if (url.pathname === '/recent') {
      const sb = new Supabase(env);
      const n = Math.min(20, Math.max(1, Number(url.searchParams.get('n')) || 5));
      const rows = await sb.select('ufc_articles',
        `select=slug,headline,dek,status,story_type,model_version,relevance_score,primary_fighter_id,`
        + `validation,news_item_id,created_at,body_md,fact_block,hero_image_ref`
        + `&model_version=like.*${DESK_VERSION}&order=created_at.desc&limit=${n}`);
      return json({
        service: WORKER,
        articles: rows.map((a) => ({
          slug: a.slug, headline: a.headline, dek: a.dek, status: a.status,
          words: String(a.body_md || '').trim().split(/\s+/).length,
          model: a.model_version, relevance: a.relevance_score,
          primary: a.fact_block?.primary?.name || null,
          source: a.fact_block?.source?.publisher || null,
          bettor_angle: a.fact_block?.bettor_angle || null,
          validation: a.validation, hero: Boolean(a.hero_image_ref),
          created_at: a.created_at,
        })),
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 3));
      return json({ service: WORKER, ...(await runBatch(env, { limit })) });
    }
    if (url.pathname === '/admin/item') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id_required' }, 400);
      const sb = new Supabase(env);
      return json({ service: WORKER, result: await processItem(sb, env, id, { publish: publishEnabled(env) }) });
    }
    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env, { limit: 3 }));
  },

  /**
   * Queue consumer. One message per item; an item that throws is retried by the
   * platform, and the state machine makes that safe - a redelivery of an item
   * already settled claims nothing and returns immediately.
   */
  async queue(batch, env, ctx) {
    const sb = new Supabase(env);
    for (const msg of batch.messages) {
      try {
        const id = msg.body?.news_item_id;
        if (!id) { msg.ack(); continue; }
        const result = await processItem(sb, env, id, { publish: publishEnabled(env) });
        console.log(`[${WORKER}] queue ${id} -> ${result.status}${result.slug ? ` ${result.slug}` : ''}`);
        msg.ack();
      } catch (e) {
        console.error(`[${WORKER}] queue message failed: ${String(e?.message || e).slice(0, 240)}`);
        msg.retry();
      }
    }
  },
};

async function runBatch(env, { limit = 3 } = {}) {
  health.last_run_at = new Date().toISOString();
  let sb;
  try { sb = new Supabase(env); }
  catch (e) {
    health.last_status = 'misconfigured'; health.last_error = e.message;
    return { status: 'misconfigured', error: e.message };
  }
  try {
    const reclaimed = await reclaimStalled(sb);
    const candidates = await pickCandidates(sb, { limit });
    const results = [];
    for (const c of candidates) {
      results.push(await processItem(sb, env, c.id, { publish: publishEnabled(env) }));
    }
    const written = results.filter((r) => r.status === 'written').length;
    health.last_status = 'ran';
    health.last_written = written;
    health.last_error = null;
    console.log(`[${WORKER}] ran candidates=${candidates.length} written=${written} reclaimed=${reclaimed}`);
    return { status: 'ran', reclaimed, candidates: candidates.length, written, results };
  } catch (e) {
    health.last_status = 'failed';
    health.last_error = String(e?.message || e).slice(0, 300);
    console.error(`[${WORKER}] batch failed: ${health.last_error}`);
    return { status: 'failed', error: health.last_error };
  }
}
