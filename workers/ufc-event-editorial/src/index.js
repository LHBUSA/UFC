/* ufc-event-editorial — the production owner of event-level articles.
 *
 * WHAT IT OWNS, AND WHY IT EXISTS SEPARATELY
 *
 * PropBetEdge writes two genuinely different kinds of article, and until now
 * both were produced by a Worker described as "control plane only":
 *
 *   WIRE-TRIGGERED  a development is reported, we analyse it. That is
 *                   ufc-news-enrich, and it owns story_type='external'.
 *   EVENT-LEVEL     a card exists, so it deserves a preview; a card finishes,
 *                   so it deserves a results read; a booking changes, so it
 *                   deserves a note. Nothing on the wire triggers these -- the
 *                   schedule does. That is this Worker.
 *
 * They share a table and nothing else. One starts from somebody else's
 * reporting and must attribute it; the other starts from our own fixture list
 * and attributes nobody. Keeping them in one Worker meant "who wrote this
 * article" had no single answer, and the ownership audit found exactly that:
 * ufc_articles had two live writers of story_type='external'.
 *
 * OWNS   fight_preview, results, card_change, rankings articles;
 *        the automated feature layer (card guides, market resets);
 *        the editorial polish pass over recently changed published packets.
 * NEVER  story_type='external'. That belongs to ufc-news-enrich, which has the
 *        wire item, the source fetch, the two-class number gate and the green
 *        path. A second writer of that type is the bug this split fixes.
 *
 * WHY THE LOGIC IS NOT IN THIS FILE
 *
 * It is imported from scripts/news/*, unchanged and shared. This Worker is a
 * schedule, a health endpoint and an admin surface around writers that already
 * existed; moving a cron is not a reason to fork an article writer.
 *
 * Endpoints
 *   GET  /health        unauthenticated, no writes
 *   POST /admin/write   write due event articles      (?dry=true)
 *   POST /admin/polish  editorial pass only           (?limit=&recent_hours=&force=)
 */
import { main as writeArticles } from '../../../scripts/news/write_articles.mjs';
import { main as writeFeatures } from '../../../scripts/news/write_features.mjs';
import { main as polishArticles } from '../../../scripts/news/polish_world_class.mjs';

const WORKER = 'ufc-event-editorial';
const VERSION = 'v0.1.0';

/* The story types this Worker owns. `external` is deliberately absent and must
 * stay absent: it is ufc-news-enrich's, and this list is the enforcement. */
const OWNED_TYPES = 'preview,results,card_change';

const health = { last_run_at: null, last_status: null, last_created: null, last_error: null, runs: 0 };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

async function articleCount(env) {
  try {
    const base = String(env.SUPABASE_URL).replace(/[/]+$/, '');
    const res = await fetch(`${base}/rest/v1/ufc_articles?select=*`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact', Range: '0-0',
      },
    });
    const cr = res.headers.get('content-range') || '';
    const i = cr.lastIndexOf('/');
    const n = i >= 0 ? Number(cr.slice(i + 1)) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function runWrite(env, { dry = false, invoked = 'cron' } = {}) {
  health.last_run_at = new Date().toISOString();
  health.runs += 1;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured' };
  }
  /* FAIL CLOSED WITHOUT AN EDITORIAL PROVIDER.
   *
   * The shared writer falls back to a deterministic template whenever no model
   * is configured, and for these story types those templates PUBLISH -- unlike
   * external drafts, which are held private. Running this lane without a key
   * would therefore quietly replace Sol-written previews and results with
   * template prose on the live site, which is exactly the thin-article outcome
   * this project refuses.
   *
   * So no provider means no articles, loudly, rather than worse articles
   * silently. The lane activates the moment OPENAI_API_KEY is set. */
  if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY) {
    health.last_status = 'no_editorial_provider';
    console.warn(`[${WORKER}] refusing to write: no editorial provider configured; template articles would publish`);
    return {
      status: 'no_editorial_provider',
      wrote: 0,
      reason: 'OPENAI_API_KEY (or ANTHROPIC_API_KEY) is not set on this Worker. The deterministic template '
        + 'fallback publishes for these story types, so writing without a model would replace Sol-written '
        + 'previews and results with template prose. Set the secret to activate the lane.',
    };
  }

  const before = await articleCount(env);
  try {
    const opts = { now: Date.now(), types: OWNED_TYPES, dry };
    const articles = await writeArticles(env, opts);
    const features = await writeFeatures(env, { now: Date.now() });
    const after = await articleCount(env);
    health.last_status = 'ok';
    health.last_created = before != null && after != null ? Math.max(0, after - before) : null;
    health.last_error = null;
    console.log(`[${WORKER}] write ${JSON.stringify({ created: health.last_created, types: OWNED_TYPES })}`);
    return {
      status: 'ok', invoked, dry, types: OWNED_TYPES,
      created: health.last_created,
      refreshed: articles?.refreshed ?? null,
      held_for_review: articles?.held_for_review ?? null,
      features: {
        candidates: features?.candidates ?? 0, created: features?.created ?? 0,
        refreshed: features?.refreshed ?? 0, held: features?.held ?? 0,
      },
    };
  } catch (e) {
    health.last_status = 'failed';
    health.last_error = String(e?.message || e).slice(0, 300);
    console.error(`[${WORKER}] write failed: ${health.last_error}`);
    return { status: 'failed', error: health.last_error };
  }
}

async function runPolish(env, { limit = 12, recentHours = 72, force = false, invoked = 'cron' } = {}) {
  health.last_run_at = new Date().toISOString();
  try {
    const desk = await polishArticles(env, { limit, recentHours, force, maxPolish: 1 });
    health.last_status = 'ok'; health.last_error = null;
    return { status: 'ok', invoked, ...desk };
  } catch (e) {
    /* The polish layer is not on the publication path: an article publishes
     * without it. So a provider outage here degrades quality, never
     * availability, and must not be reported as a pipeline failure. */
    health.last_status = 'degraded';
    health.last_error = String(e?.message || e).slice(0, 300);
    console.warn(`[${WORKER}] polish unavailable: ${health.last_error}`);
    return { status: 'degraded', error: health.last_error };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({
        service: WORKER,
        version: VERSION,
        owns: {
          story_types: ['fight_preview', 'results', 'card_change', 'rankings'],
          also: ['automated feature layer (card guides, market resets)', 'editorial polish pass'],
        },
        never_writes: {
          story_types: ['external'],
          reason: 'story_type=external is owned solely by ufc-news-enrich, which holds the wire item, '
            + 'the fetched source, the two-class number gate and the green path',
        },
        writes: ['ufc_articles (event-level story types only)'],
        writer_types: OWNED_TYPES,
        schedule: 'cloudflare cron 15 */2 * * * (write) and 20 10 * * * (write + polish)',
        replaces: 'the write/refresh/sweep phases of ufc-newsroom, which is now control plane only',
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          OPENAI_API_KEY: Boolean(env.OPENAI_API_KEY),
          ANTHROPIC_API_KEY: Boolean(env.ANTHROPIC_API_KEY),
        },
        ...health,
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/write') {
      return json({ service: WORKER, ...(await runWrite(env, { dry: url.searchParams.get('dry') === 'true', invoked: 'manual' })) });
    }
    if (url.pathname === '/admin/polish') {
      return json({
        service: WORKER,
        ...(await runPolish(env, {
          limit: Number(url.searchParams.get('limit')) || 12,
          recentHours: Number(url.searchParams.get('recent_hours')) || 72,
          force: url.searchParams.get('force') === 'true',
          invoked: 'manual',
        })),
      });
    }
    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    /* The two-hourly slot writes; the daily slot writes and then polishes. */
    ctx.waitUntil((async () => {
      await runWrite(env, { invoked: 'cron' });
      if (event.cron === '20 10 * * *') await runPolish(env, { invoked: 'cron' });
    })());
  },
};
