// ufc-algo: the PBE Algo scheduler (Cloudflare Worker).
//
//   GET  /health              public: service, mode, last run summary. Never a pick.
//   POST /admin/run           ADMIN_TRIGGER_TOKEN: run one cycle now and return the
//                             full card report (picks included, admin only).
//   GET  /admin/learning      ADMIN_TRIGGER_TOKEN: champion, challenger, training
//                             runs, shadow record and the latest review.
//   POST /admin/learn/run     ADMIN_TRIGGER_TOKEN: start one LearnDaily Workflow
//                             instance (?rebuild=1 forces the weekly full rebuild).
//   GET  /admin/learn/status  ADMIN_TRIGGER_TOKEN: ?id= Workflow instance status.
//   POST /admin/review/run    ADMIN_TRIGGER_TOKEN: run this week's promotion review.
//   POST /admin/promote       OWNER_PROMOTE_TOKEN only: record the owner decision on
//                             a PROPOSE review; APPROVED promotes via ufc_model_promote().
//   scheduled  41 * * * *     hourly cycle (champion + shadow)
//              17 12 * * *    LearnDaily Workflow
//              23 13 * * 1    weekly promotion review
//   RPC entrypoint MarketRefresh.refresh({ runId, observedAt })
//                             service binding only (ufc-live-odds), never an HTTP
//                             route: after a successful pre-fight snapshot, refresh
//                             sample_context.market on unlocked champion predictions
//                             (src/marketRefresh.js, migration 030). Presentation only.
//
// ALGO_MODE=dry_run (default) writes only a ufc_model_runs row from the cycle.
// ALGO_MODE=armed is required for any evaluation, draft, lock, grade or shadow
// write, and even then the cycle refuses to write unless a registered, live,
// hash-verified champion exists. Learning never changes the champion; only the
// owner-approved promote route can.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { runCycle } from './cycle.js';
import { refreshMarketContext } from './marketRefresh.js';
import { db } from './supabase.js';
import { resolveChampion } from './champion.js';
import { activeChallenger } from './learning/daily.js';
import { ownerDecision, runReview, shadowPairs } from './learning/review.js';

export { LearnDaily } from './learning/workflow.js';

/* Reachable only through a Cloudflare service binding that names this entrypoint;
 * it has no URL. The caller supplies which market run succeeded, never a price,
 * probability or edge. Armed only: dry_run never writes. */
export class MarketRefresh extends WorkerEntrypoint {
  async refresh({ runId, observedAt } = {}) {
    if (this.env.ALGO_MODE !== 'armed') return { refused: 'dry_run', run_id: runId ?? null };
    const out = await refreshMarketContext(db(this.env), { runId, observedAt });
    console.log(`[market-refresh] ${JSON.stringify({ run_id: out.run_id, observed_at: out.observed_at, bouts: out.bouts, predictions: out.predictions, refreshed: out.refreshed, results: out.results, refused: out.refused, errors: out.errors.length })}`);
    return out;
  }
}

export const CRON = Object.freeze({ cycle: '41 * * * *', learn: '17 12 * * *', review: '23 13 * * 1' });

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function tokenMatches(req, expected) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !got) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [a, b] = await Promise.all([crypto.subtle.sign('HMAC', key, enc.encode(got)), crypto.subtle.sign('HMAC', key, enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const adminOk = (req, env) => tokenMatches(req, env.ADMIN_TRIGGER_TOKEN || '');
/* The owner token is separate from the admin token and must differ from it: the admin token can never promote. */
const ownerOk = (req, env) => (env.OWNER_PROMOTE_TOKEN && env.OWNER_PROMOTE_TOKEN !== env.ADMIN_TRIGGER_TOKEN ? tokenMatches(req, env.OWNER_PROMOTE_TOKEN) : Promise.resolve(false));

async function startLearn(env, { trigger, rebuild = null }) {
  const params = { trigger };
  if (rebuild != null) params.rebuild = rebuild;
  const instance = await env.LEARN_DAILY.create({ params });
  return { id: instance.id, status: await instance.status() };
}

export async function learningReport(env) {
  const q = db(env);
  const champion = await resolveChampion(q);
  const challenger = champion.live ? await activeChallenger(q, champion.model_version) : null;
  const runs = await q.get('ufc_model_training_runs?select=id,created_at,run_date,trigger,status,parent_model_version,dataset_sha256,spec_sha256,training_bouts,newly_graded_bouts,superseded_at,gate->decision,coefficient_drift->max_abs_move,coefficient_drift->material_sign_flips,benchmark_drift,error&order=created_at.desc&limit=14');
  const [review] = await q.get('ufc_model_promotion_reviews?select=id,created_at,week_start,champion_model_version,challenger_run_id,verdict,reasons,owner_decision,promoted_model_version&order=created_at.desc&limit=1');
  let shadow = null;
  if (challenger) {
    const pairs = await shadowPairs(q, challenger.id, champion.model_version);
    const graded = pairs.filter((p) => ['WIN', 'LOSS'].includes(p.shadow.result) && ['WIN', 'LOSS'].includes(p.champion.result));
    const bs = (side) => (graded.length ? graded.reduce((a, p) => a + (p[side].p_pick - (p[side].result === 'WIN' ? 1 : 0)) ** 2, 0) / graded.length : null);
    const wl = (side) => `${graded.filter((p) => p[side].result === 'WIN').length}-${graded.filter((p) => p[side].result === 'LOSS').length}`;
    shadow = { paired_locked: pairs.length, paired_graded: graded.length, challenger_record: wl('shadow'), champion_record: wl('champion'), challenger_brier: bs('shadow'), champion_brier: bs('champion') };
  }
  return {
    champion: champion.live ? { model_version: champion.model_version, spec_sha256: champion.spec_sha256, verified: true } : { blocked: champion.blocked },
    challenger: challenger ? {
      training_run_id: challenger.id, created_at: challenger.created_at, spec_sha256: challenger.spec_sha256, dataset_sha256: challenger.dataset_sha256, training_bouts: challenger.training_bouts,
      walk_forward: { challenger: challenger.walk_forward?.pooled, baseline: challenger.walk_forward?.baseline?.pooled },
      calibration: { challenger: { ece: challenger.calibration?.ece, slope: challenger.calibration?.slope }, baseline: challenger.calibration?.baseline },
      coefficient_drift: challenger.coefficient_drift, benchmark_drift: challenger.benchmark_drift,
    } : null,
    shadow,
    latest_review: review || null,
    runs,
    promotion: 'owner-approved only: POST /admin/promote with the owner token on a PROPOSE review',
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      let last = null;
      try {
        const rows = await db(env).get('ufc_model_runs?select=started_at,finished_at,trigger,mode,status,counts,error&order=started_at.desc&limit=1');
        const r = rows[0];
        if (r) last = { started_at: r.started_at, finished_at: r.finished_at, trigger: r.trigger, mode: r.mode, status: r.status, cards: r.counts?.cards ?? null, bouts: r.counts?.bouts ?? null, model_source: r.counts?.model_source ?? null, error: r.error ? 'see ufc_model_runs' : null };
      } catch { last = { error: 'run ledger unreadable' }; }
      return json({ service: 'ufc-algo', mode: env.ALGO_MODE === 'armed' ? 'armed' : 'dry_run', configured: Boolean(env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_URL), admin_enabled: Boolean(env.ADMIN_TRIGGER_TOKEN), learning_enabled: Boolean(env.LEARN_DAILY && env.ARTIFACTS), last_run: last });
    }
    if (req.method === 'POST' && url.pathname === '/admin/promote') {
      if (!(await ownerOk(req, env))) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await req.json(); } catch { return json({ error: 'json body required' }, 400); }
      const out = await ownerDecision(db(env), { reviewId: String(body.review_id || ''), decision: body.decision, modelVersion: body.model_version, note: body.note });
      return json(out.body, out.status);
    }
    if (!url.pathname.startsWith('/admin/')) return json({ error: 'not_found' }, 404);
    if (!(await adminOk(req, env))) return json({ error: 'unauthorized' }, 401);

    if (req.method === 'POST' && url.pathname === '/admin/run') {
      const mode = url.searchParams.get('mode') === 'armed' ? 'armed' : 'dry_run';
      return json(await runCycle(env, { trigger: 'admin', mode }));
    }
    if (req.method === 'GET' && url.pathname === '/admin/learning') return json(await learningReport(env));
    if (req.method === 'POST' && url.pathname === '/admin/learn/run') {
      const r = url.searchParams.get('rebuild');
      return json(await startLearn(env, { trigger: 'admin', rebuild: r === '1' ? true : r === '0' ? false : null }));
    }
    if (req.method === 'GET' && url.pathname === '/admin/learn/status') {
      const instance = await env.LEARN_DAILY.get(url.searchParams.get('id') || '');
      return json({ id: instance.id, status: await instance.status() });
    }
    if (req.method === 'POST' && url.pathname === '/admin/review/run') return json(await runReview({ q: db(env), bucket: env.ARTIFACTS }));
    return json({ error: 'not_found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    if (controller.cron === CRON.learn) {
      ctx.waitUntil(startLearn(env, { trigger: 'cron' }).then((r) => console.log(`[learn] started ${r.id}`)).catch((e) => console.log(`[learn] start failed: ${e?.message || e}`)));
      return;
    }
    if (controller.cron === CRON.review) {
      ctx.waitUntil(runReview({ q: db(env), bucket: env.ARTIFACTS }).then((r) => console.log(`[review] ${r.created ? 'created' : 'exists'} ${r.review?.id} ${r.review?.verdict}`)).catch((e) => console.log(`[review] failed: ${e?.message || e}`)));
      return;
    }
    ctx.waitUntil(runCycle(env, { trigger: 'cron' }));
  },
};
