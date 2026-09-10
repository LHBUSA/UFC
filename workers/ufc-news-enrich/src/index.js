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
import { processItem, pickCandidates, reclaimStalled, resolveVideosFor, WORKER } from './pipeline.mjs';
import { buildContentPlan, loadDna } from './content_plan.mjs';
import { pickHero } from './pipeline.mjs';
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

    if (url.pathname === '/cost') {
      /* What the newsroom spent, and on what.
       *
       * Unauthenticated on purpose: it reports aggregates over our own
       * operations and holds nothing sensitive, and a cost report that needs a
       * token is a cost report nobody reads. The number that matters is not
       * total spend -- it is the share of spend that bought nothing.
       */
      const sb = new Supabase(env);
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const since = new Date(Date.now() - hours * 3600e3).toISOString();
      const rows = await sb.select('ufc_news_pipeline_events',
        /* The timestamp column is `at`, not created_at, and cost records are
         * marked by detail.kind because the stage vocabulary is constrained. */
        `select=stage,status,detail,at&detail->>kind=eq.cost&at=gte.${encodeURIComponent(since)}`
        + `&order=at.desc&limit=1000`);
      const agg = {
        window_hours: hours, candidates: rows.length,
        rejected_before_model: 0, sol_calls: 0, published: 0, held: 0,
        sol_input_tokens: 0, sol_output_tokens: 0, retry_input_tokens: 0, retry_output_tokens: 0,
        spend_usd: 0, spend_on_published_usd: 0, spend_wasted_usd: 0,
      };
      const byStage = {};
      for (const r of rows) {
        const d = r.detail || {};
        const usd = Number(d.estimated_model_cost_usd) || 0;
        agg.sol_calls += Number(d.model_calls) || 0;
        agg.sol_input_tokens += Number(d.sol_input_tokens) || 0;
        agg.sol_output_tokens += Number(d.sol_output_tokens) || 0;
        agg.retry_input_tokens += Number(d.retry_input_tokens) || 0;
        agg.retry_output_tokens += Number(d.retry_output_tokens) || 0;
        agg.spend_usd += usd;
        if (d.outcome === 'rejected_before_model') agg.rejected_before_model += 1;
        if (d.outcome === 'published') { agg.published += 1; agg.spend_on_published_usd += usd; }
        else { agg.held += 1; agg.spend_wasted_usd += usd; }
        const k = d.stage || 'unknown';
        byStage[k] = byStage[k] || { items: 0, sol_calls: 0, spend_usd: 0 };
        byStage[k].items += 1;
        byStage[k].sol_calls += Number(d.model_calls) || 0;
        byStage[k].spend_usd = Math.round((byStage[k].spend_usd + usd) * 1e6) / 1e6;
      }
      const round = (n) => Math.round(n * 1e6) / 1e6;
      return json({
        service: WORKER,
        ...agg,
        spend_usd: round(agg.spend_usd),
        spend_on_published_usd: round(agg.spend_on_published_usd),
        spend_wasted_usd: round(agg.spend_wasted_usd),
        /* The two headline numbers. */
        cost_per_published_article_usd: agg.published ? round(agg.spend_usd / agg.published) : null,
        wasted_spend_pct: agg.spend_usd > 0 ? Math.round((agg.spend_wasted_usd / agg.spend_usd) * 100) : null,
        by_stage: byStage,
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 3));
      return json({ service: WORKER, ...(await runBatch(env, { limit })) });
    }
    if (url.pathname === '/admin/replan') {
      /* Build or rebuild the content plan for articles this Worker wrote,
       * WITHOUT touching their prose. The narrative already passed the gate;
       * re-running the model to gain a chart would risk a worse article for a
       * richer one, and the plan is deterministic anyway — it can be derived
       * from the stored packet at any time. */
      const sb = new Supabase(env);
      const n = Math.min(20, Math.max(1, Number(url.searchParams.get('n')) || 3));
      const rows = await sb.select('ufc_articles',
        `select=id,slug,headline,body_md,status,fact_block,hero_image_ref,primary_fighter_id,bout_id,event_id,validation,model_version`
        + `&model_version=like.*${DESK_VERSION}&order=created_at.desc&limit=${n}`);
      const out = [];
      for (const a of rows) {
        const packet = a.fact_block || {};
        if (!packet.primary) { out.push({ slug: a.slug, skipped: 'no stored packet' }); continue; }
        const ids = [a.primary_fighter_id].filter(Boolean);
        const dna = await loadDna(sb, ids).catch(() => new Map());
        const videos = await resolveVideosFor(env, {
          fighterId: a.primary_fighter_id,
          boutId: packet.bout?.bout_id || a.bout_id || null,
          eventId: packet.bout?.event?.id || a.event_id || null,
          articleId: a.id,
        });
        const hero = a.primary_fighter_id ? await pickHero(sb, a.primary_fighter_id) : null;
        const plan = await buildContentPlan(sb, {
          packet,
          article: { bettor_angle: packet.bettor_angle, model: a.model_version, validation: a.validation },
          hero, videos, dna,
        });
        await sb.patch('ufc_articles', `id=eq.${a.id}`, {
          fact_block: { ...packet, content_plan: plan },
          hero_image_ref: a.hero_image_ref || hero?.id || null,
          hero_credit: a.hero_image_ref ? undefined : (hero?.credit || undefined),
          updated_at: new Date().toISOString(),
        });
        out.push({
          slug: a.slug, headline: a.headline, status: a.status,
          words: String(a.body_md || '').trim().split(/\s+/).length,
          modules: plan.module_ids, charts: plan.chart_count,
          video_tier: plan.video_tier, videos: (videos.videos || []).length,
          omitted: plan.omitted,
        });
      }
      return json({ service: WORKER, replanned: out.length, articles: out });
    }

    if (url.pathname === '/admin/requeue') {
      /* Send held items back through the pipeline. UNCHANGED PIPELINE.
       *
       * A hold is terminal by design: state='held' is a decision point, and
       * pickCandidates only claims new/scored, so nothing retries by itself.
       * That is right when the hold was a judgement about the story, and wrong
       * when it was our fault -- a credential outage, or a gate defect. Live
       * traffic produced both: 19 items held during a 90-minute 401 window on
       * 2026-09-10, and a long tail held because factNumbers could not see
       * numbers inside packet strings and called a fighter's own record
       * invented. Those items were correct all along and had no way back.
       *
       * This does NOT bypass anything. It resets state to 'new' so the item is
       * claimed and re-run through the identical gate: same validators, same
       * provenance classes, same entity thresholds, same freshness rule. An
       * item that deserved its hold is simply held again, with a fresh reason.
       *
       * ?reason= is a required LIKE filter, so a requeue always names the
       * defect it is recovering from and can never mean "release everything".
       */
      const like = url.searchParams.get('reason');
      if (!like) return json({ error: 'reason_required', hint: 'pass ?reason=<state_reason LIKE pattern> so the requeue names what it is recovering from' }, 400);
      const n = Math.min(50, Math.max(1, Number(url.searchParams.get('n')) || 10));
      const maxAgeH = Math.min(72, Math.max(1, Number(url.searchParams.get('max_source_age_h')) || 24));
      const sb = new Supabase(env);
      const since = new Date(Date.now() - maxAgeH * 3600e3).toISOString();
      const rows = await sb.select('ufc_news_items',
        `select=id,title,state_reason,published_at&state=eq.held`
        + `&state_reason=like.${encodeURIComponent(like)}`
        + `&published_at=gte.${since}&order=published_at.desc&limit=${n}`);
      const out = [];
      for (const r of rows) {
        /* Conditional on state, so a concurrent consumer cannot be raced. */
        await sb.patch('ufc_news_items', `id=eq.${r.id}&state=eq.held`, {
          state: 'new', state_reason: `requeued after fix (was: ${String(r.state_reason || '').slice(0, 160)})`,
          state_changed_at: new Date().toISOString(), attempts: 0, lease_token: null, lease_expires_at: null,
        });
        out.push({ id: r.id, title: r.title, was: String(r.state_reason || '').slice(0, 100) });
      }
      return json({ service: WORKER, requeued: out.length, filter: like, max_source_age_h: maxAgeH, items: out });
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
