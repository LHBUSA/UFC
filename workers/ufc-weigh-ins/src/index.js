/* ufc-weigh-ins — the single production owner of weigh-in collection.
 *
 *   Cloudflare Cron (every minute) -> this Worker -> Supabase
 *
 * The cron fires every minute; the pass decides whether work is due
 * (lib/window.mjs): live weigh-in window ~3 min, fight-week watch ~30 min,
 * idle = one indexed query and no source fetch. The collector itself is the
 * existing deterministic pass (scripts/weighins/lib/pass_core.mjs) — this file
 * only supplies the host: PostgREST client, network fetch, lock and ledger.
 *
 *   FAST lane      reads weigh-in stories the newsroom already stored in
 *                  ufc_news_items (no publisher is re-fetched).
 *   OFFICIAL lane  fetches the UFC.com "Official Weigh-In Results" article the
 *                  newsroom discovered for this card (verified URL, never a
 *                  constructed slug).
 *
 * No model, no articles, no DNA. No GitHub Actions, no Vercel cron.
 *
 * Routes:
 *   GET  /health   configuration + last run, no secrets
 *   POST /run      Authorization: Bearer <ADMIN_TOKEN>
 *                  ?dry=1 (no writes)  ?force=1 (ignore cadence)  ?event=<uuid>
 */
import { runWeighInPass, LOCK_ID, WORKER } from '../../../scripts/weighins/lib/pass_core.mjs';
import { CADENCE, WINDOW } from '../../../scripts/weighins/lib/window.mjs';
import { PostgrestClient } from '../../../scripts/weighins/lib/postgrest.mjs';

export const VERSION = '1.0.0';
const CRON = '* * * * *';
const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeNewsBot/1.0; +https://ufc.propbetedge.ai/about)';
const LOCK_TTL_MS = 5 * 60 * 1000;

/* --------------------------------------------------------------- lock (DO) */

/* Single-flight under its OWN identity, LOCK_ID = 'weigh-ins' — never the
 * newsroom's lock. A four-minute editorial sweep must not silence the desk
 * during the ninety minutes it exists for. Same shape as NewsroomLock. */
export class WeighInLock {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url);
    const now = Number(url.searchParams.get('now')) || Date.now();
    if (url.pathname === '/acquire') {
      const ttlMs = Number(url.searchParams.get('ttl')) || LOCK_TTL_MS;
      const held = await this.ctx.storage.get('holder');
      if (held && now - held.at < held.ttlMs) return Response.json({ acquired: false, age_s: Math.round((now - held.at) / 1000) });
      const token = crypto.randomUUID();
      await this.ctx.storage.put('holder', { token, at: now, ttlMs });
      return Response.json({ acquired: true, token, stole: Boolean(held) });
    }
    if (url.pathname === '/release') {
      const token = url.searchParams.get('token');
      const held = await this.ctx.storage.get('holder');
      if (held && held.token === token) { await this.ctx.storage.delete('holder'); return Response.json({ released: true }); }
      return Response.json({ released: false });
    }
    if (url.pathname === '/state') {
      const held = await this.ctx.storage.get('holder');
      return Response.json({ held: Boolean(held), at: held?.at ?? null });
    }
    return new Response('not found', { status: 404 });
  }
}

async function withLock(env, fn) {
  const stub = env.WEIGH_IN_LOCK.get(env.WEIGH_IN_LOCK.idFromName(LOCK_ID));
  const got = await (await stub.fetch(`https://weigh-ins.lock/acquire?ttl=${LOCK_TTL_MS}`, { method: 'POST' })).json();
  if (!got.acquired) return { status: 'locked', reason: `another weigh-in pass holds '${LOCK_ID}' (${got.age_s}s)` };
  try {
    return await fn();
  } finally {
    await stub.fetch(`https://weigh-ins.lock/release?token=${encodeURIComponent(got.token)}`, { method: 'POST' }).catch(() => {});
  }
}

/* --------------------------------------------------------------- host */

function client(env) {
  return new PostgrestClient({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
}

/* The Worker's network: a real fetch, with our UA and a timeout. Only the
 * official lane calls it — the fast lane reads stored newsroom text. */
function fetchImpl(url) {
  return fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
}

function summarize(r) {
  return {
    status: r.status,
    mode: r.plan?.mode,
    reason: r.plan?.reason,
    event: r.event ? { id: r.event.id, name: r.event.name, event_date: r.event.event_date } : null,
    coverage: r.coverage ?? null,
    counters: r.counters,
    sources: r.sources ?? null,
    duration_ms: r.duration_ms,
  };
}

async function pass(env, { write, force, eventId, trigger }) {
  return withLock(env, async () => {
    const r = await runWeighInPass({ sb: client(env), log: console }, { write, force, eventId, fetchImpl, ledger: write, trigger });
    return r;
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await pass(env, { write: true, force: false, eventId: null, trigger: `cron ${controller.cron}` });
        if (r.status !== 'skipped') console.log(`[${WORKER}] ${JSON.stringify(summarize(r))}`);
      } catch (e) {
        console.error(`[${WORKER}] pass failed: ${String(e?.stack || e).slice(0, 500)}`);
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      let last = null;
      try {
        last = (await client(env).select('ufc_ingest_runs', `select=started_at,finished_at,status,notes&worker=eq.${WORKER}&order=started_at.desc&limit=1`))[0] || null;
      } catch (e) {
        last = { error: String(e?.message || e).slice(0, 120) };
      }
      return Response.json({
        worker: WORKER,
        version: VERSION,
        runtime: 'cloudflare-workers',
        scheduler: 'cloudflare-cron',
        cron: CRON,
        lock_id: LOCK_ID,
        cadence_minutes: CADENCE,
        window_hours: WINDOW,
        bindings: {
          supabase_url: Boolean(env.SUPABASE_URL),
          supabase_service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          admin_token: Boolean(env.ADMIN_TOKEN),
          lock: Boolean(env.WEIGH_IN_LOCK),
        },
        lanes: { fast: 'ufc_news_items stored source_body (no publisher refetch)', official: 'UFC.com official weigh-in results article discovered by the newsroom', commission: 'configured, inert until a verified jurisdiction URL exists' },
        last_run: last,
      }, { headers: { 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const dry = url.searchParams.get('dry') === '1';
      const force = url.searchParams.get('force') === '1';
      const eventId = url.searchParams.get('event');
      if (eventId && !/^[0-9a-f-]{36}$/i.test(eventId)) return Response.json({ error: 'bad event id' }, { status: 400 });
      try {
        const r = await pass(env, { write: !dry, force, eventId, trigger: dry ? 'manual dry' : 'manual' });
        const out = summarize(r);
        if (dry && Array.isArray(r.readings)) {
          out.readings = r.readings.map((x) => ({ fighter: x._fighter_name, weight: x.official_weight_lbs, result: x.result, limit_basis: x.limit_basis, applicable_limit: x.contracted_limit_lbs == null ? null : Number(x.contracted_limit_lbs) + Number(x.allowance_lbs || 0), source: x.source_name, kind: x.source_kind }));
        }
        return Response.json(out, { headers: { 'cache-control': 'no-store' } });
      } catch (e) {
        return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
      }
    }

    return Response.json({ error: 'not_found', routes: ['GET /health', 'POST /run'] }, { status: 404 });
  },
};
