/* ufc-broadcast-schedule — the single production owner of UFC start times and
 * broadcast carriers.
 *
 *   Cloudflare Cron (every 30 min) -> this Worker -> UFC.com -> Supabase
 *
 * NO GitHub Actions. NO Vercel cron. The repository's .github/workflows is not
 * touched by this feature and must not be: scheduling here is a Cloudflare Cron
 * Trigger, declared in wrangler.toml, and nothing else.
 *
 * The trigger fires every 30 minutes; the pass decides whether work is due
 * (lib/window.mjs): 30 min on event day, 60 min inside 24 hours, 6 h during
 * fight week, 12 h otherwise. An idle wake costs two indexed queries and no
 * upstream fetch at all.
 *
 * The collector is the deterministic pass in scripts/broadcast/lib/pass_core.mjs
 * — this file only supplies the host: PostgREST client, network fetch with a
 * timeout, single-flight lock, and the run ledger.
 *
 * Routes:
 *   GET  /health   configuration + last run + freshness, no secrets
 *   POST /run      Authorization: Bearer <ADMIN_TOKEN>
 *                  ?dry=1 (parse and diff, write nothing)  ?force=1 (ignore cadence)
 */
import { runBroadcastPass, LOCK_ID, WORKER, TABLE } from '../../../scripts/broadcast/lib/pass_core.mjs';
import { CADENCE, WINDOW } from '../../../scripts/broadcast/lib/window.mjs';
import { PARSER, EVENTS_URL } from '../../../scripts/broadcast/lib/parse.mjs';
import { BroadcastPostgrest } from '../../../scripts/broadcast/lib/postgrest.mjs';

export const VERSION = '1.0.0';
const CRON = '*/30 * * * *';
const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeNewsBot/1.0; +https://ufc.propbetedge.ai/about)';
const LOCK_TTL_MS = 4 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

/* --------------------------------------------------------------- lock (DO) */

/* Single-flight under its OWN identity, LOCK_ID = 'broadcast-schedule'. Same
 * shape as WeighInLock, deliberately a separate class and a separate lock: a
 * weigh-in sweep and a schedule refresh have nothing to say to each other, and
 * sharing a lock would let either silence the other.
 *
 * This is also the answer to a duplicated scheduled invocation. Two overlapping
 * passes cannot both write; the second returns `locked` and does nothing. */
export class BroadcastLock {
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
  const stub = env.BROADCAST_LOCK.get(env.BROADCAST_LOCK.idFromName(LOCK_ID));
  const got = await (await stub.fetch(`https://broadcast.lock/acquire?ttl=${LOCK_TTL_MS}`, { method: 'POST' })).json();
  if (!got.acquired) return { status: 'locked', reason: `another broadcast pass holds '${LOCK_ID}' (${got.age_s}s)` };
  try {
    return await fn();
  } finally {
    await stub.fetch(`https://broadcast.lock/release?token=${encodeURIComponent(got.token)}`, { method: 'POST' }).catch(() => {});
  }
}

/* --------------------------------------------------------------- host */

function client(env) {
  return new BroadcastPostgrest({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
}

/* The Worker's network. A real fetch, our UA, a hard timeout, and redirects
 * followed only within UFC.com — the pass re-checks the allow-list before it
 * ever calls this, so the Worker cannot be turned into an open proxy by a
 * crafted request. */
function fetchImpl(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

function summarize(r) {
  return {
    status: r.status,
    mode: r.plan?.mode,
    reason: r.plan?.reason,
    counters: r.counters,
    diagnostics: r.diagnostics ?? null,
    changed: r.changed ?? [],
    duration_ms: r.duration_ms,
  };
}

async function pass(env, { write, force, trigger }) {
  return withLock(env, async () => runBroadcastPass(
    { sb: client(env), log: console },
    { write, force, fetchImpl, trigger },
  ));
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await pass(env, { write: true, force: false, trigger: `cron ${controller.cron}` });
        /* A skipped wake is the normal case and logging it 48 times a day is
         * noise. Everything else is worth a structured line. */
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
      let lastSuccess = null;
      let freshness = null;
      try {
        const sb = client(env);
        last = (await sb.select('ufc_ingest_runs', `select=started_at,finished_at,status,notes&worker=eq.${WORKER}&order=started_at.desc&limit=1`))[0] || null;
        lastSuccess = (await sb.select('ufc_ingest_runs', `select=started_at,finished_at,notes&worker=eq.${WORKER}&status=in.(success,partial)&order=started_at.desc&limit=1`))[0] || null;
        const rows = await sb.select(TABLE, 'select=ufc_slug,event_name,main_card_start_utc,verified_at,last_changed_at&order=main_card_start_utc.asc&limit=200');
        const nowMs = Date.now();
        const next = rows.find((r) => r.main_card_start_utc && Date.parse(r.main_card_start_utc) + 5 * 3600e3 > nowMs) || null;
        freshness = {
          rows: rows.length,
          next_event: next ? { slug: next.ufc_slug, name: next.event_name, main_card_start_utc: next.main_card_start_utc } : null,
          verified_age_minutes: next?.verified_at ? Math.round((nowMs - Date.parse(next.verified_at)) / 60000) : null,
        };
      } catch (e) {
        last = { error: String(e?.message || e).slice(0, 160) };
      }
      return Response.json({
        worker: WORKER,
        version: VERSION,
        runtime: 'cloudflare-workers',
        scheduler: 'cloudflare-cron',
        github_actions: false,
        cron: CRON,
        lock_id: LOCK_ID,
        source: { url: EVENTS_URL, parser: PARSER, timeout_ms: FETCH_TIMEOUT_MS },
        cadence_minutes: CADENCE,
        window_hours: WINDOW,
        bindings: {
          supabase_url: Boolean(env.SUPABASE_URL),
          supabase_service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          admin_token: Boolean(env.ADMIN_TOKEN),
          broadcast_lock: Boolean(env.BROADCAST_LOCK),
        },
        last_run: last,
        last_success: lastSuccess ? { started_at: lastSuccess.started_at, finished_at: lastSuccess.finished_at, counters: lastSuccess.notes?.counters ?? null } : null,
        freshness,
      }, { headers: { 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      const dry = url.searchParams.get('dry') === '1';
      const force = url.searchParams.get('force') === '1';
      try {
        const r = await pass(env, { write: !dry, force, trigger: dry ? 'manual dry-run' : 'manual' });
        console.log(`[${WORKER}] ${JSON.stringify(summarize(r))}`);
        return Response.json(r, { headers: { 'cache-control': 'no-store' } });
      } catch (e) {
        console.error(`[${WORKER}] manual pass failed: ${String(e?.stack || e).slice(0, 500)}`);
        return Response.json({ status: 'error', error: String(e?.message || e).slice(0, 300) }, { status: 500 });
      }
    }

    return new Response('not found', { status: 404 });
  },
};
