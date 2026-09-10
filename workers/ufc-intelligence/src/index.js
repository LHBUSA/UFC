/* ufc-intelligence — the derived-intelligence lane.
 *
 * Owns the things computed FROM the raw record rather than scraped into it:
 * official rankings today, Fight DNA and fighter aggregates as they migrate off
 * GitHub Actions. One owner per lane; ufc-stats-ingest owns events, bouts,
 * results and fighters, and this Worker never writes those.
 *
 * WHY NOT ufc-newsroom. The newsroom is the control plane and stays that way.
 * Rankings are not newsroom work — they are a data lane that the newsroom's
 * articles happen to read, and putting them back inside it would rebuild the
 * bundle that made newsroom.yml impossible to disable without dropping two
 * unrelated jobs.
 *
 * WHAT IT REPLACES. `.github/workflows/newsroom.yml`, cron `41 11 * * 2,3`,
 * which ran `node scripts/rankings/ingest_rankings.mjs` on a GitHub runner. The
 * script itself is reused verbatim — this is a change of EXECUTION OWNERSHIP,
 * not a rewrite. It needed one refactor to be callable here: options are now an
 * argument rather than module-scope argv, and it no longer calls main() at
 * import, which previously meant that merely loading the file fetched ufc.com
 * and upserted the table.
 *
 * LEDGER. Runs are recorded in ufc_ingest_runs with worker='ufc-intelligence',
 * the same table and discriminator every other lane uses, so "when did rankings
 * last actually succeed?" has one answer in one place.
 *
 * Endpoints
 *   GET  /health        unauthenticated, no side effects
 *   POST /admin/run     run now (?dry=true to parse and link but write nothing)
 */
import { main as ingestRankings } from '../../../scripts/rankings/ingest_rankings.mjs';

const WORKER = 'ufc-intelligence';
const VERSION = 'v0.1.0';
const LANES = ['rankings'];

const health = { last_run_at: null, last_status: null, last_lane: null, last_result: null, last_error: null };

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

/* --- run ledger, on the table every other lane already uses --------------- */

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
  if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

async function openRun(env, lane, invoked) {
  const rows = await sb(env, 'POST', 'ufc_ingest_runs', {
    body: [{ worker: WORKER, status: 'running', notes: { lane, invoked } }],
    prefer: 'return=representation',
  });
  return rows?.[0]?.id || null;
}

async function closeRun(env, id, status, notes) {
  if (!id) return;
  try {
    await sb(env, 'PATCH', `ufc_ingest_runs?id=eq.${id}`, {
      body: { status, finished_at: new Date().toISOString(), notes },
      prefer: 'return=minimal',
    });
  } catch (e) {
    /* Closing is best effort BY DESIGN. Failing to OPEN means the work would be
     * unrecorded before it happens, so it must not happen. Failing to CLOSE
     * means it already happened and cannot be undone; log it loudly. */
    console.error(`[${WORKER}] failed to close run ${id}: ${String(e.message).slice(0, 200)}`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      let lastSuccess = null;
      try {
        const rows = await sb(env, 'GET',
          `ufc_ingest_runs?select=started_at,finished_at,status,notes&worker=eq.${WORKER}`
          + `&status=eq.success&order=started_at.desc&limit=1`);
        lastSuccess = rows?.[0] || null;
      } catch { /* reported as null */ }
      return json({
        service: WORKER, version: VERSION, ...health,
        lanes: LANES,
        replaces: 'newsroom.yml cron "41 11 * * 2,3" (rankings), previously run on a GitHub runner',
        cron: env.CRON_DESCRIPTION || '25 11 * * *',
        last_success: lastSuccess,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
        },
        writes: 'ufc_rankings, the ufc-media storage bucket (rankings/*.json), ufc_ingest_runs. Nothing else.',
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const dry = url.searchParams.get('dry') === 'true';
      return json({ service: WORKER, version: VERSION, ...(await runRankings(env, { dry, invoked: 'manual' })) });
    }
    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRankings(env, { invoked: 'cron', cron: event.cron }));
  },
};

async function runRankings(env, { dry = false, invoked = 'cron', cron = null } = {}) {
  health.last_run_at = new Date().toISOString();
  health.last_lane = 'rankings';

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured', error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' };
  }

  /* A dry run is a read: it parses the page and links names, and writes
   * nothing — including no ledger row, because a run that changed nothing is
   * not a run the catch-up planner should count as freshness. */
  let runId = null;
  if (!dry) {
    try {
      runId = await openRun(env, 'rankings', invoked);
    } catch (e) {
      health.last_status = 'ledger_open_failed';
      health.last_error = String(e.message).slice(0, 240);
      console.error(`[${WORKER}] LEDGER OPEN FAILED, running nothing: ${health.last_error}`);
      return { status: 'ledger_open_failed', error: health.last_error };
    }
  }

  try {
    const result = await ingestRankings(env, { dry });
    health.last_status = 'success';
    health.last_result = result;
    health.last_error = null;
    console.log(`[${WORKER}] rankings ${dry ? 'DRY ' : ''}ok snapshot=${result.snapshot_date} `
      + `divisions=${result.divisions} champions=${result.champions} entries=${result.entries} `
      + `linked=${result.linked}/${result.people} warnings=${result.warnings.length}`);
    await closeRun(env, runId, 'success', { lane: 'rankings', invoked, cron, ...result });
    return { status: 'success', dry, result };
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 400);
    health.last_status = 'failed';
    health.last_error = detail;
    console.error(`[${WORKER}] rankings FAILED: ${detail}`);
    await closeRun(env, runId, 'failed', { lane: 'rankings', invoked, cron, error: detail });
    return { status: 'failed', error: detail };
  }
}
