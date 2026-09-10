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
 *   POST /admin/dna     Fight DNA now (?fighter=, ?as_of=, ?force=true, ?dry=true)
 *
 * Service-binding RPC (not reachable from the internet, so no token):
 *   DnaTrigger.refreshFightDna({ reason, bouts })
 *     Called by ufc-stats-ingest after it lands new round rows. Runs the same
 *     fingerprint-gated build as the 07:17 cron, so it rebuilds only when
 *     results or round stats actually moved, and fresh rounds stop waiting up
 *     to a day for Fight DNA to see them.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { main as ingestRankings } from '../../../scripts/rankings/ingest_rankings.mjs';

import { buildFightDna } from '../../../scripts/dna/build_fight_dna.mjs';

const DNA_CRON = '17 7 * * *';
const WORKER = 'ufc-intelligence';
const VERSION = 'v0.1.0';
const LANES = ['rankings', 'fight_dna'];

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
        writes: 'ufc_rankings, ufc_fighter_dna_snapshots, ufc_fighter_bout_features, ufc_fighter_stance_splits, ufc_dna_build_runs, the ufc-media storage bucket (rankings/*.json), ufc_ingest_runs.',
        crons: { rankings: env.CRON_DESCRIPTION || '25 11 * * *', fight_dna: DNA_CRON },
        fight_dna: {
          replaces: 'fight-dna-build.yml cron "17 7 * * *", previously run on a GitHub runner',
          skips_when_inputs_unchanged: Boolean(env.INTEL_STATE),
          definition_versioned: true,
          historical_snapshots_preserved: true,
        },
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const dry = url.searchParams.get('dry') === 'true';
      return json({ service: WORKER, version: VERSION, ...(await runRankings(env, { dry, invoked: 'manual' })) });
    }

    if (url.pathname === '/admin/dna') {
      const dry = url.searchParams.get('dry') === 'true';
      return json({
        service: WORKER, version: VERSION,
        ...(await runFightDna(env, {
          dry, invoked: 'manual',
          asOf: url.searchParams.get('as_of'),
          fighterId: url.searchParams.get('fighter'),
          force: url.searchParams.get('force') === 'true',
        })),
      });
    }
    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    /* Two lanes, two crons, one owner. Rankings at 11:25 and Fight DNA at
     * 07:17 -- the hour the GitHub workflow used, kept deliberately so the DNA
     * build still lands after the 06:00 stats ingest it depends on. */
    if (event.cron === DNA_CRON) ctx.waitUntil(runFightDna(env, { invoked: 'cron' }));
    else ctx.waitUntil(runRankings(env, { invoked: 'cron', cron: event.cron }));
  },
};

/* Binding-only entrypoint. The DNA owner stays the DNA owner: the caller asks,
 * this Worker decides (via its own input fingerprint) whether there is work. */
export class DnaTrigger extends WorkerEntrypoint {
  async refreshFightDna({ reason = null, bouts = [] } = {}) {
    const r = await runFightDna(this.env, { invoked: 'binding:ufc-stats-ingest' });
    console.log(`[${WORKER}] fight_dna trigger reason=${JSON.stringify(reason)} bouts=${Array.isArray(bouts) ? bouts.length : 0} status=${r?.status}`);
    return {
      status: r?.status || 'unknown', as_of: r?.as_of ?? null, fingerprint: r?.fingerprint ?? null,
      snapshots: r?.snapshots ?? null, error: r?.error ?? null,
    };
  }
}

/* ---------------------------------------------------------- fight DNA */

/**
 * The watermark that decides whether a rebuild is worth doing.
 *
 * Fight DNA is a pure function of completed bouts and their round statistics.
 * If neither has changed since the last successful build, a rebuild recomputes
 * identical snapshots and writes identical rows -- work whose only effect is a
 * new generated_at. So the inputs are fingerprinted: the newest result capture
 * plus the row counts of results and round stats. A count is included because a
 * correction that replaces a row without advancing a timestamp still changes
 * the answer, and a max() alone would miss it.
 *
 * Deliberately NOT in the fingerprint: the as-of date. A new day genuinely
 * produces a different snapshot -- bouts age out of windows -- so the daily
 * build is legitimate work even when no fight happened. The fingerprint
 * suppresses repeat builds WITHIN a day, which is what event-driven triggering
 * would otherwise create.
 */
async function dnaInputFingerprint(env) {
  const newest = await sb(env, 'GET',
    'ufc_bout_results?select=captured_at&order=captured_at.desc.nullslast&limit=1').catch(() => null);
  const [rc, roc] = await Promise.all([
    sbCount(env, 'ufc_bout_results'),
    sbCount(env, 'ufc_bout_round_stats'),
  ]);
  return [newest?.[0]?.captured_at || 'none', String(rc), String(roc)].join('|');
}

/** Exact row count via PostgREST's content-range, without pulling the table. */
async function sbCount(env, table) {
  try {
    const base = String(env.SUPABASE_URL).replace(/[/]+$/, '');
    /* select=* rather than a named column. Asking for select=id returned
     * PostgREST 42703 (undefined column) on ufc_bout_results, whose key is
     * bout_id -- and the failure was swallowed into '?', which silently
     * degraded the fingerprint to a timestamp alone. A count needs no
     * particular column, so it should not name one. */
    const res = await fetch(`${base}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const cr = res.headers.get('content-range') || '';
    const slash = cr.lastIndexOf('/');
    const total = slash >= 0 ? Number(cr.slice(slash + 1)) : NaN;
    return Number.isFinite(total) ? total : '?';
  } catch { return '?'; }
}

/**
 * Build Fight DNA, skipping the work when nothing it depends on has moved.
 *
 * Reacts to authoritative state rather than only to the clock: ufc-fight-state
 * records a bout reaching post_result, ufc-stats-ingest lands the round rows,
 * and the fingerprint above notices. A completed bout therefore refreshes the
 * fighters involved on the next tick instead of waiting for a calendar day.
 *
 * Historical snapshots are preserved. The builder upserts on the versioned key
 * (fighter, as-of date, definition version), so rebuilding today can never
 * touch yesterday's row, and a definition change writes a new row beside the
 * old one rather than silently restating history under a new meaning.
 */
async function runFightDna(env, { dry = false, invoked = 'cron', asOf = null, fighterId = null, force = false } = {}) {
  health.last_run_at = new Date().toISOString();
  health.last_lane = 'fight_dna';
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { lane: 'fight_dna', status: 'misconfigured' };
  }

  const fingerprint = await dnaInputFingerprint(env).catch(() => null);
  const today = asOf || new Date().toISOString().slice(0, 10);
  const stateKey = `dna:last_build:${today}`;
  let previous = null;
  try { previous = env.INTEL_STATE ? await env.INTEL_STATE.get(stateKey) : null; } catch { /* treated as a miss */ }

  if (!force && !fighterId && fingerprint && previous === fingerprint) {
    health.last_status = 'skipped_unchanged';
    console.log(`[${WORKER}] fight_dna skipped: inputs unchanged for ${today}`);
    return { lane: 'fight_dna', status: 'skipped_unchanged', as_of: today, fingerprint, invoked };
  }

  try {
    const summary = await buildFightDna({
      supabaseUrl: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
      asOf: asOf || undefined,
      fighterId: fighterId || undefined,
      dry,
    });
    if (!dry && fingerprint && env.INTEL_STATE) {
      /* Written only after a successful build, so a crash mid-run leaves the
       * next tick to retry rather than marking the day done. */
      try { await env.INTEL_STATE.put(stateKey, fingerprint, { expirationTtl: 172800 }); } catch { /* best effort */ }
    }
    health.last_status = summary && summary.ok === false ? 'skipped' : 'ok';
    health.last_error = null;
    console.log(`[${WORKER}] fight_dna ${JSON.stringify({ as_of: summary && summary.as_of, snapshots: summary && summary.snapshots })}`);
    return { lane: 'fight_dna', status: 'ok', dry, invoked, fingerprint, ...summary };
  } catch (e) {
    health.last_status = 'failed';
    health.last_error = String((e && e.message) || e).slice(0, 300);
    console.error(`[${WORKER}] fight_dna failed: ${health.last_error}`);
    return { lane: 'fight_dna', status: 'failed', error: health.last_error };
  }
}

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
