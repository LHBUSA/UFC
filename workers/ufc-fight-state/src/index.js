/* ufc-fight-state — the production owner of fight state.
 *
 * WHAT IT OWNS
 *   bout status, cancellations, replacements and opponent changes,
 *   fight-week checkpoints, weigh-in state once ingestion exists, and the
 *   transition to a completed/final result.
 *
 * All of it lands in ufc_fight_state_ledger as append-only rows. This Worker is
 * the ONLY production writer of that table; the GitHub workflow that used to
 * hold the schedule is disabled, and the CLI in scripts/ledger is for local
 * inspection and bounded replay.
 *
 * WHY THE SCHEDULE MOVED HERE
 *
 * GitHub is source control, not a scheduler. A cron living in a workflow file
 * means production behaviour changes on merge, runs on a runner nobody watches,
 * needs the service-role key handed to CI, and reports failure into a tab. The
 * ledger's whole purpose is recording state that cannot be recreated later, so
 * a missed window is permanent -- that deserves the same platform, health
 * endpoint and observability as everything else in the lane.
 *
 * WHY THE LOGIC IS NOT IN THIS FILE
 *
 * It is imported from scripts/ledger/capture_fight_state.mjs, unchanged. Two
 * implementations of "what is the state of this fight" would drift, and the
 * ledger would then hold rows built by two different definitions with no way to
 * tell them apart after the fact.
 *
 * IDEMPOTENCE
 *
 * A checkpoint is captured once per bout: the run reads what the ledger already
 * holds for the events in the window and skips those pairs. Re-running the cron,
 * replaying by hand, or two runs overlapping produces no duplicate rows, and the
 * table's trigger rejects updates outright.
 *
 * Endpoints
 *   GET  /health          unauthenticated, no writes
 *   POST /admin/run       capture what is due now      (?dry=true to preview)
 *   POST /admin/replay    one named checkpoint         (?checkpoint=&event=&dry=)
 */
import { captureFightState, LEDGER_VERSION, BUILDER, LATE_HOURS } from '../../../scripts/ledger/capture_fight_state.mjs';

const WORKER = 'ufc-fight-state';
const VERSION = 'v0.1.0';
const CHECKPOINT_NAMES = ['t_minus_7d', 't_minus_72h', 'post_weigh_in', 't_minus_24h', 't_minus_3h', 'close', 'post_result', 'ad_hoc'];

const health = { last_run_at: null, last_status: null, last_inserted: null, last_error: null, runs: 0 };

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

const cfgFrom = (env, extra = {}) => ({
  supabaseUrl: env.SUPABASE_URL,
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
  ...extra,
});

async function run(env, extra = {}) {
  health.last_run_at = new Date().toISOString();
  health.runs += 1;
  try {
    const summary = await captureFightState(cfgFrom(env, { now: new Date(), ...extra }));
    health.last_status = 'ok';
    health.last_inserted = summary.inserted ?? 0;
    health.last_error = null;
    console.log(`[${WORKER}] ${JSON.stringify({ events: summary.events, bouts: summary.bouts, inserted: summary.inserted, missed: summary.missed_windows })}`);
    return summary;
  } catch (e) {
    /* A capture failure is loud but never fatal to the isolate: the next hour
     * retries, and a checkpoint whose window has closed is recorded as missed
     * rather than back-filled with reconstructed state. */
    health.last_status = 'failed';
    health.last_error = String(e?.message || e).slice(0, 300);
    console.error(`[${WORKER}] capture failed: ${health.last_error}`);
    throw e;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({
        service: WORKER,
        version: VERSION,
        owns: ['bout status', 'cancellations', 'replacements', 'opponent changes',
          'fight-week checkpoints', 'weigh-in state', 'completed/final transitions'],
        writes: ['ufc_fight_state_ledger'],
        ledger_version: LEDGER_VERSION,
        builder: BUILDER,
        checkpoints: CHECKPOINT_NAMES,
        late_window_hours: LATE_HOURS,
        append_only: true,
        schedule: 'cloudflare cron 23 * * * *',
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
        },
        ...health,
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    const dry = url.searchParams.get('dry') === 'true';

    if (url.pathname === '/admin/run') {
      try { return json({ service: WORKER, dry, ...(await run(env, { auto: true, dry })) }); }
      catch (e) { return json({ service: WORKER, status: 'failed', error: String(e.message).slice(0, 300) }, 500); }
    }

    if (url.pathname === '/admin/replay') {
      /* Bounded replay. A named checkpoint only, optionally narrowed to one
       * event -- never "recapture everything". Replay cannot rewrite history:
       * a (bout, checkpoint) already in the ledger is reported as skipped, so
       * the safe move when unsure is simply to run it. */
      const checkpoint = url.searchParams.get('checkpoint');
      if (!checkpoint || !CHECKPOINT_NAMES.includes(checkpoint)) {
        return json({ error: 'checkpoint_required', allowed: CHECKPOINT_NAMES }, 400);
      }
      try {
        return json({
          service: WORKER, dry, checkpoint,
          ...(await run(env, { checkpoint, dry, eventFilter: url.searchParams.get('event') || '' })),
        });
      } catch (e) { return json({ service: WORKER, status: 'failed', error: String(e.message).slice(0, 300) }, 500); }
    }

    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { auto: true }).catch(() => {}));
  },
};
