/* ufc-newsroom — the production scheduler for ufc.propbetedge.ai news.
 *
 * Replaces .github/workflows/newsroom.yml, which failed in a way worth naming
 * so this Worker is not quietly rebuilt into the same shape:
 *
 *   * GitHub's scheduler is best effort. The every-30-minutes cron was
 *     observed firing at 1 to 5 hour gaps, and a daily slot ran 4.4 hours late.
 *   * Jobs were selected by `github.event.schedule == '<cron>'`, so a late run
 *     executed only its own job and a dropped slot was never made up.
 *   * The writer gate additionally required an even hour and minute < 30, a
 *     window real runs frequently missed, so the writer was skipped even when
 *     ingest had just succeeded.
 *   * Every one of those outcomes reported success, so nothing ever alerted.
 *   * All jobs checked out ufc-fight-dna-v1, 28 commits behind production.
 *
 * The fixes are structural, not tuning: phases are chosen from the run ledger
 * as well as the cron (see coordinator.mjs), a single coordinator runs every
 * phase in one invocation, and a run that does nothing says so in a row a
 * human can read.
 *
 * On concurrency, precisely — earlier drafts of this file overclaimed it.
 * Within one invocation there is one writer, by construction. Across
 * invocations there are two different guards doing two different jobs:
 *
 *   Durable Object (lock.mjs, binding NEWSROOM_LOCK) serialises invocations.
 *   Requests to one object are single-threaded, so read-then-write inside it
 *   is atomic and a second run cannot start. This is what stops duplicate
 *   Anthropic spend, which no database constraint can.
 *
 *   Unique indexes (ufc_news_items.fingerprint/.url, ufc_articles.slug) stop
 *   duplicate ROWS unconditionally, including when the lock is unavailable.
 *   They cannot stop duplicate WORK: a losing writer has already built its
 *   drafts and paid for any rewrite before its INSERT is rejected.
 *
 * Without the binding the Worker falls back to the ledger's advisory check,
 * which is a read-then-insert over two round trips and therefore racy. That
 * fallback is recorded in the run row as concurrency_guard, so the ledger
 * always says which guarantee was actually in force.
 *
 * Endpoints
 *   GET  /health      unauthenticated, no side effects, no model call
 *   POST /admin/run   ADMIN_TRIGGER_TOKEN required, same path as the cron
 *
 * Configuration
 *   vars:     SUPABASE_URL
 *   secrets:  SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (optional),
 *             ADMIN_TRIGGER_TOKEN, DISCORD_WEBHOOK_URL (optional)
 *   durable:  NEWSROOM_LOCK -> NewsroomLock (single-flight; see lock.mjs)
 */
import { Supabase } from './supabase.mjs';
import { planRun, shouldWriteAfterIngest, PHASES } from './coordinator.mjs';
import { WORKER, findActiveRun, lastSuccessByPhase, openRun, closeRun } from './runlog.mjs';
import { acquire as acquireLock, release as releaseLock, MANUAL_DEADLINE_MS } from './lock.mjs';
import { runSources, runIngest, runWrite, runRefresh, runSweep, anthropicConfigured } from './phases.mjs';

/* The Durable Object class must be exported from the entry module for the
 * runtime to find it. It is the single-flight guard; see lock.mjs. */
export { NewsroomLock } from './lock.mjs';

const SERVICE = WORKER;
const VERSION = 'v0.1.0';



/* In-memory only: survives a warm isolate and nothing more. The ledger is the
 * durable record; this is a convenience for whoever curls /health. */
const health = { last_run_at: null, last_status: null, last_phases: null, last_error_class: null };
const nowIso = () => new Date().toISOString();

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/* Fails CLOSED. No token configured, wrong length, or mismatch -> 404 rather
 * than 401, so an unauthenticated caller learns nothing about whether the
 * route exists. Comparison is constant-time over the expected length. */
function adminAuthorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export default {
  /* No GET anywhere in this Worker ingests, writes, or calls a model. The
   * only side-effecting route is POST /admin/run behind the token, so a
   * crawler, a preview scanner or a curious reader cannot spend money or
   * publish anything. */
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({
        service: SERVICE,
        version: VERSION,
        ...health,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          ANTHROPIC_API_KEY: anthropicConfigured(env),
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
        },
        /* Stated plainly so a reader of /health knows the enhancement is
         * optional and its absence is not an outage. */
        editorial_provider: anthropicConfigured(env)
          ? 'anthropic (optional enhancement); deterministic templates always publish'
          : 'deterministic templates only',
      });
    }

    if (url.pathname === '/admin/run') {
      if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
      if (!adminAuthorized(req, env)) return json({ error: 'not_found' }, 404);

      /* Presence of the parameter is the signal, not its contents.
       *
       * `?phases=x` means EXACTLY x. No parameter at all means the ordinary
       * catch-up planner, which is a deliberate and different request. The two
       * are distinguished by has(), so `?phases=` is an empty explicit
       * request — an error — rather than silently becoming "run everything
       * overdue", which on an empty ledger is the entire newsroom. */
      const requestedPhases = url.searchParams.has('phases');
      const raw = (url.searchParams.get('phases') || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const valid = raw.filter((p) => PHASES.includes(p));
      const unknown = raw.filter((p) => !PHASES.includes(p));

      if (requestedPhases && !valid.length) {
        /* Nothing runs. Returning 400 before any lock, ledger row, database
         * read or model call is the point: a typo must cost nothing. */
        console.warn(`[${SERVICE}] rejected /admin/run: no valid phase in "${url.searchParams.get('phases')}"`);
        return json({
          service: SERVICE, version: VERSION,
          error: 'no_valid_phase',
          message: 'The phases parameter was supplied but named no valid phase, so nothing was run.',
          requested: raw, unknown, valid_phases: PHASES,
        }, 400);
      }

      const result = await run(env, {
        cron: null,
        invoked: 'manual',
        force: valid,
        exact: requestedPhases,
        /* Only manual runs need this; see MANUAL_DEADLINE_MS. */
        deadlineMs: MANUAL_DEADLINE_MS,
      });
      return json({ service: SERVICE, version: VERSION, requested: requestedPhases ? valid : null, unknown_ignored: unknown.length ? unknown : undefined, ...result });
    }

    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { cron: event.cron, invoked: 'cron' }));
  },
};

/**
 * One invocation. Chooses phases, takes the advisory lock, runs them in order,
 * and records what actually happened.
 *
 * A phase failure is contained: the remaining phases still run and the run
 * closes 'partial'. One dead RSS source must not stop the writer, and a failed
 * enhancement must not stop publication.
 */
export async function run(env, { cron = null, invoked = 'cron', force = [], exact = false, now = Date.now(), deadlineMs = null } = {}) {
  health.last_run_at = nowIso();
  let sb;
  try {
    sb = new Supabase(env);
  } catch (e) {
    /* Misconfiguration is loud and does nothing else. */
    health.last_status = 'misconfigured';
    health.last_error_class = 'ConfigError';
    console.error(`[${SERVICE}] ${e.message}`);
    return { status: 'misconfigured', error: e.message, phases: [] };
  }

  /* Single-flight. The Durable Object is authoritative where it exists; the
   * ledger check is the fallback and is honestly labelled as advisory. */
  const lock = await acquireLock(env, { now }).catch((e) => ({ kind: 'none', acquired: false, reason: String(e?.message || e) }));
  let guard = 'durable_object';
  if (lock.kind === 'durable') {
    if (!lock.acquired) {
      console.log(`[${SERVICE}] SKIP: lock held by ${lock.holder} for ${lock.age_minutes}m`);
      health.last_status = 'skipped_locked';
      return { status: 'skipped_locked', concurrency_guard: guard, held_by: lock.holder, age_minutes: lock.age_minutes, phases: [] };
    }
    if (lock.stole) console.log(`[${SERVICE}] took over an expired lock; the previous run did not release`);
  } else {
    guard = 'advisory_ledger';
    const active = await findActiveRun(sb, now).catch(() => null);
    if (active) {
      console.log(`[${SERVICE}] SKIP: run ${active.id} started ${active.age_minutes}m ago is still going`);
      health.last_status = 'skipped_locked';
      return { status: 'skipped_locked', concurrency_guard: guard, held_by: active.id, age_minutes: active.age_minutes, phases: [] };
    }
  }

  try {
    return await runPhases(env, sb, { cron, invoked, force, exact, now, guard, lock, deadlineMs });
  } finally {
    /* Always, including after a throw: a lock a dead run never released costs
     * everyone else the full TTL. */
    if (lock.kind === 'durable' && lock.acquired) await releaseLock(env, lock.token, { now });
  }
}

async function runPhases(env, sb, { cron, invoked, force, exact, now, guard, lock, deadlineMs }) {
  /* An exact request does not consult the ledger, so it is not read. */
  const lastSuccess = exact ? {} : await lastSuccessByPhase(sb).catch(() => ({}));
  const { phases, reasons } = planRun({ cron, now, lastSuccessByPhase: lastSuccess, force, exact });

  if (!phases.length) {
    console.log(`[${SERVICE}] nothing due (cron=${cron})`);
    health.last_status = 'idle';
    health.last_phases = [];
    return { status: 'idle', concurrency_guard: guard, phases: [], reasons };
  }

  /* FAIL CLOSED without a durable run row.
   *
   * The ledger is not a log here, it is an input: catch-up scheduling reads it
   * to decide what is overdue, and the concurrency fallback reads it to decide
   * whether a run is already in flight. A side-effecting run with no row is
   * therefore invisible to the next invocation in both of those decisions —
   * it would ingest, publish and spend on Anthropic while leaving the system
   * believing nothing had happened, which is worse than not running at all.
   * Previously this was `.catch(() => null)` and continued regardless. */
  let runId = null;
  let openError = null;
  try {
    runId = await openRun(sb, { cron, invoked, phases, reasons });
  } catch (e) {
    openError = e;
  }
  if (!runId) {
    const detail = String(openError?.message || openError || 'openRun returned no id').slice(0, 300);
    console.error(`[${SERVICE}] LEDGER OPEN FAILED, running nothing: ${detail}`);
    health.last_status = 'ledger_open_failed';
    health.last_error_class = openError?.name || 'LedgerError';
    /* No phase runs, so no source is fetched, no article is written and no
     * model is called. The caller releases the lock in its finally block. */
    return {
      status: 'ledger_open_failed',
      concurrency_guard: guard,
      error: detail,
      planned: phases,
      phases: [],
      reasons,
    };
  }

  const counters = {};
  const succeeded = [];
  const failures = [];
  console.log(`[${SERVICE}] START ${invoked} cron=${cron} phases=${phases.join(',')}`);

  const deadlineAt = deadlineMs ? now + deadlineMs : null;
  const abandoned = [];

  for (const phase of phases) {
    /* Checked between phases, never inside one: a phase already talking to
     * Supabase or Anthropic is left to finish, which is why the deadline sits
     * well under the lease rather than at it. */
    if (deadlineAt && Date.now() > deadlineAt) {
      abandoned.push(phase);
      console.warn(`[${SERVICE}] deadline reached; abandoning ${phase}`);
      continue;
    }
    try {
      if (phase === 'write') {
        /* The single decision point for writing within this invocation.
         * Nothing else here may start a writer; two CONCURRENT invocations are
         * excluded by the lock above, not by this. */
        const decision = shouldWriteAfterIngest({
          insertedNew: counters.ingest?.inserted ?? 0,
          plannedPhases: phases.filter((p) => p !== 'write'),
          lastSuccessByPhase: lastSuccess,
          now,
        });
        counters.write_decision = decision;
        if (!decision.write) {
          console.log(`[${SERVICE}] write skipped: ${decision.reason}`);
          continue;
        }
      }
      const fn = { sources: runSources, ingest: runIngest, write: runWrite, refresh: runRefresh, sweep: runSweep }[phase];
      counters[phase] = await fn(env, sb, { now });
      succeeded.push(phase);
    } catch (e) {
      const cls = e?.name || 'Error';
      health.last_error_class = cls;
      const detail = String(e?.message || e).slice(0, 300);
      failures.push({ phase, class: cls, detail, at: nowIso() });
      console.error(`[${SERVICE}] phase ${phase} failed: ${cls}: ${detail}`);
    }
  }

  /* Abandoning work is not success even when nothing failed: the run did less
   * than it planned and the ledger must say so, or the next catch-up will
   * believe those phases are fresh. */
  const status = failures.length
    ? (succeeded.length ? 'partial' : 'failed')
    : (abandoned.length ? 'partial' : 'success');
  const notes = {
    cron,
    invoked,
    phases_planned: phases,
    phases_succeeded: succeeded,
    phase_reasons: reasons,
    counters,
    anthropic_configured: anthropicConfigured(env),
    /* Which guarantee was actually in force for this run. A reader of the
     * ledger should never have to infer it from the deployment. */
    concurrency_guard: guard,
    exact: Boolean(exact),
    /* Named, because a phase abandoned to a deadline is not a phase that was
     * never planned, and the difference matters to whoever reads this next. */
    phases_abandoned: abandoned,
  };

  /* Closing the row is best effort BY DESIGN, and the asymmetry with opening
   * it is deliberate. Failing to OPEN means the work is unrecorded before it
   * happens, so it must not happen. Failing to CLOSE means work that already
   * happened cannot be un-happened, so the result is still returned to the
   * caller — losing it would be a second failure on top of the first. It is
   * loud in the log and leaves a row stuck 'running' that the lock's staleness
   * window later reclaims. */
  await closeRun(sb, runId, { status, notes, failures });

  health.last_status = status;
  health.last_phases = succeeded;
  console.log(`[${SERVICE}] END status=${status} ran=${succeeded.join(',') || 'none'}${abandoned.length ? ` abandoned=${abandoned.join(',')}` : ''}`);
  return { status, run_id: runId, concurrency_guard: guard, phases: succeeded, planned: phases, abandoned, reasons, counters, failures };
}
