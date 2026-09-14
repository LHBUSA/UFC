// ufc-algo: the PBE Algo scheduler (Cloudflare Worker).
//
//   GET  /health        public: service, mode, last run summary. Never a pick.
//   POST /admin/run     ADMIN_TRIGGER_TOKEN: run one cycle now and return the
//                       full card report (picks included, admin only).
//   scheduled           hourly cycle.
//
// ALGO_MODE=dry_run (default) writes only a ufc_model_runs row. ALGO_MODE=armed
// is required for any evaluation, draft, lock or grade, and even then the cycle
// refuses to write unless a registered, live, hash-verified model exists.

import { runCycle } from './cycle.js';
import { db } from './supabase.js';

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function tokenOk(req, env) {
  const expected = env.ADMIN_TRIGGER_TOKEN || '';
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
      return json({ service: 'ufc-algo', mode: env.ALGO_MODE === 'armed' ? 'armed' : 'dry_run', configured: Boolean(env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_URL), admin_enabled: Boolean(env.ADMIN_TRIGGER_TOKEN), last_run: last });
    }
    if (req.method === 'POST' && url.pathname === '/admin/run') {
      if (!(await tokenOk(req, env))) return json({ error: 'unauthorized' }, 401);
      const mode = url.searchParams.get('mode') === 'armed' ? 'armed' : 'dry_run';
      return json(await runCycle(env, { trigger: 'admin', mode }));
    }
    return json({ error: 'not_found' }, 404);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCycle(env, { trigger: 'cron' }));
  },
};
