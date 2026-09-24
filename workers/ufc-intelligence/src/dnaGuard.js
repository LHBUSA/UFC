/* Fight DNA completion guard (2026-09-24 incident).
 *
 * The 07:17 build for 2026-09-24 died on one Postgres statement timeout after
 * 700 of 3,180 snapshots. Nothing retried it: the next build was the next day's
 * cron. This decides, once an hour, whether TODAY's build is owed a resume.
 *
 * Pure: no I/O and no clock. `runs` are today's ufc_dna_build_runs rows
 * (as_of_date = today), `attempts` the guard resumes already made today.
 *
 *   none       before 08:00Z (the daily cron owns the morning), a success
 *              exists, or a run is genuinely in progress
 *   resume     no success for today: failed, partial, a stale `running` row,
 *              or no run at all (a missed cron)
 *   exhausted  resume attempts used up; the caller must surface it loudly
 */
export const GUARD_EARLIEST_UTC_HOUR = 8;
export const GUARD_MAX_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 30 * 60 * 1000;

export function dnaGuardDecision({ nowIso, runs = [], attempts = 0 }) {
  const now = Date.parse(nowIso);
  const today = nowIso.slice(0, 10);
  if (new Date(now).getUTCHours() < GUARD_EARLIEST_UTC_HOUR) return { action: 'none', reason: 'before_daily_window', as_of: today };
  const mine = runs.filter((r) => r.as_of_date === today);
  if (mine.some((r) => r.status === 'success')) return { action: 'none', reason: 'success_recorded', as_of: today };
  const live = mine.find((r) => r.status === 'running' && now - Date.parse(r.started_at) < STALE_RUNNING_MS);
  if (live) return { action: 'none', reason: 'in_progress', as_of: today, run_id: live.id };
  const last = mine.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] || null;
  const reason = !last ? 'no_run_today' : last.status === 'running' ? 'stale_running' : `last_run_${last.status}`;
  if (attempts >= GUARD_MAX_ATTEMPTS) return { action: 'exhausted', reason, as_of: today, attempts, last_run_id: last?.id ?? null };
  return { action: 'resume', reason, as_of: today, attempts, last_run_id: last?.id ?? null };
}
