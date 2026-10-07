/* Fight DNA run lifecycle (2026-10-07 incident).
 *
 * Cloudflare analytics for the four 2026-10-07 builds: status internalError,
 * wall time 900.0 s (the Cron Trigger wall limit), CPU 1.0-1.7 s. The database
 * was saturated, the single all-or-nothing build ran out of wall clock, the
 * isolate was terminated, and each ufc_dna_build_runs row stayed `running`
 * forever. Three rules prevent a repeat:
 *
 *   BUDGET   every build gets a deadline well inside the wall limit; the
 *            builder closes its row `partial` with a cursor when it passes
 *   REAPER   a `running` row older than the wall limit cannot still be alive;
 *            it is closed `failed` with the reason, so no row is orphaned
 *   SINGLE   one build at a time: a KV lease (TTL = wall limit) plus the
 *            run table's live rows; a second trigger is skipped, not queued
 */

/** Cloudflare Cron Trigger wall-clock limit. */
export const CRON_WALL_LIMIT_MS = 15 * 60 * 1000;
/** Build budget: stop writing with 3 minutes left for closing the row and the division-context step. */
export const BUILD_BUDGET_MS = 12 * 60 * 1000;
/** A running row older than this was terminated by the platform. */
export const ABANDONED_AFTER_MS = CRON_WALL_LIMIT_MS + 60 * 1000;
export const LOCK_KEY = 'dna:build_lock';

export const buildDeadline = (startedMs) => startedMs + BUILD_BUDGET_MS;

/** Close every `running` row that is older than the wall limit. Returns the ids closed. */
export async function reapAbandonedRuns(sb, nowMs) {
  const cutoff = new Date(nowMs - ABANDONED_AFTER_MS).toISOString();
  const rows = await sb('PATCH', `ufc_dna_build_runs?status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`, {
    body: {
      status: 'failed',
      finished_at: new Date(nowMs).toISOString(),
      errors: ['abandoned: no finish within the 15-minute Cron Trigger wall limit (isolate terminated); closed by the run reaper'],
    },
    prefer: 'return=representation',
  });
  return (rows || []).map((r) => r.id);
}

/** A run that is genuinely still in flight (started inside the wall limit and not closed). */
export function liveRun(runs, nowMs) {
  return runs.find((r) => r.status === 'running' && nowMs - Date.parse(r.started_at) < ABANDONED_AFTER_MS) || null;
}

/** KV lease. Returns a release function, or null when another build holds the lease. */
export async function acquireLease(kv, nowMs, owner) {
  if (!kv) return async () => {};
  try {
    const held = await kv.get(LOCK_KEY);
    if (held) {
      const h = JSON.parse(held);
      if (nowMs - Date.parse(h.at) < CRON_WALL_LIMIT_MS) return null;
    }
    await kv.put(LOCK_KEY, JSON.stringify({ owner, at: new Date(nowMs).toISOString() }), { expirationTtl: Math.ceil(CRON_WALL_LIMIT_MS / 1000) });
  } catch { /* KV unavailable: the run-table check still applies */ }
  return async () => { try { await kv.delete(LOCK_KEY); } catch { /* expires on its own */ } };
}
