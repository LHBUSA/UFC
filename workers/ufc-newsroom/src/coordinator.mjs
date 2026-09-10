/* Which phases one invocation runs, and why.
 *
 * This module is the answer to how the GitHub Actions newsroom failed, so the
 * failure is worth stating before the fix.
 *
 * The workflow selected jobs with `if: github.event.schedule == '<cron>'`.
 * That makes a phase run only when its own cron string fires, and GitHub's
 * scheduler is best effort: observed on this repository, the every-30-minutes
 * cron actually fired at gaps of 1 to 5 hours, and the daily "5 9 * * *" slot ran
 * at 13:29 UTC, 4.4 hours late. A late run still carries its own cron string,
 * so it ran portraits and skipped news - and reported success. A slot that is
 * dropped entirely is never made up, because nothing anywhere asks "when did
 * this last actually happen?".
 *
 * So schedule alone is not a contract, and this coordinator does not treat it
 * as one. A cron string proposes; the run ledger disposes. Every phase carries
 * a maximum age, and a phase that is overdue runs on the next invocation
 * whatever woke it. Cadence is then a floor on freshness rather than a hope
 * about timers.
 *
 * The second rule is that ONE INVOCATION runs at most one writer. Phases are
 * computed once, deduplicated, and executed in a fixed order, so nothing here
 * can schedule two writers against each other. That is a statement about this
 * module and not about the world: two concurrent invocations are excluded by
 * the Durable Object in lock.mjs where its binding exists, and by unique
 * indexes on the rows themselves in every case. See lock.mjs for what each of
 * those actually guarantees.
 */

/** Phases, in the only order they may execute. */
/* Phases, in the only order they may execute.
 *
 * ARTICLE GENERATION LEFT THIS WORKER on 2026-09-10. `write`, `refresh` and
 * `sweep` produced fight_preview, results, card_change and rankings articles,
 * plus the feature layer and the editorial polish pass -- inside a Worker whose
 * stated role is the control plane. That is now ufc-event-editorial, which owns
 * those story types and nothing else.
 *
 * What remains here is orchestration: verify the feed registry, OBSERVE the
 * wire (ufc-news-ingest fills it), and report catch-up and pipeline status.
 * This Worker no longer writes ufc_articles at all. */
export const PHASES = ['sources', 'ingest'];

/* Maximum age before a phase is overdue regardless of which cron fired.
 * Each is the intended cadence plus room for one late run, so an on-time
 * schedule never triggers catch-up and a skipped slot always does. */
export const MAX_AGE_MINUTES = {
  sources: 1560,     // intended daily, 26h; feeds move on the scale of months
  ingest: 45,        // intended every 30
};

/* What each cron is FOR. Catch-up can still add phases beyond these. */
export const CRON_PHASES = {
  '*/30 * * * *': ['ingest'],
  '15 */2 * * *': ['ingest'],
  /* Source verification rides the daily slot, before ingest reads the table it
   * reconciles. Verifying every 30 minutes would fetch five feeds we already
   * know are healthy; verifying never is how a dead feed stays enabled. */
  '20 10 * * *': ['sources', 'ingest'],
};

const minutesSince = (iso, now) => {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 60000 : Infinity;
};

/**
 * Decide the phases for one invocation.
 *
 * `lastSuccessByPhase` comes from the run ledger, so "overdue" is measured
 * against what actually completed, not against what was scheduled. A phase
 * whose last success cannot be established is treated as overdue: never
 * having run is the strongest possible case for running.
 *
 * `ingestedNew` is only known after ingest, so `write` is decided in two
 * places - here for the overdue case, and by `shouldWriteAfterIngest` once
 * the ingest result exists. Both funnel into the same single writer.
 */
export function planRun({ cron, now = Date.now(), lastSuccessByPhase = {}, force = [], exact = false } = {}) {
  /* EXACT mode: run precisely what was asked for and nothing else.
   *
   * This exists because catch-up and an operator's explicit request are
   * opposite intentions, and conflating them made the canary a lie. Overdue
   * phases are added below on the reasoning that a phase which has not run is
   * always worth running — sound for a cron, wrong for a human. Production's
   * ledger holds ZERO ufc-newsroom rows, so every phase reads as never having
   * succeeded, so `?phases=sources` planned sources, ingest, write, refresh
   * and sweep: the first careful step of a canary would have been the whole
   * newsroom, against production, on its first ever run.
   *
   * So exactness is a separate path rather than a stronger `force`. Nothing
   * here consults the ledger or the cron at all: what the caller named is what
   * runs, ordered canonically and deduplicated by the filter over PHASES.
   * An unrecognised name is simply not in PHASES and therefore cannot appear;
   * the caller is responsible for rejecting a request that names nothing
   * valid, which is a client error rather than a licence to do something else.
   */
  if (exact) {
    const requested = new Set(force.filter((p) => PHASES.includes(p)));
    const reasons = {};
    for (const p of requested) reasons[p] = 'requested explicitly (exact)';
    return { phases: PHASES.filter((p) => requested.has(p)), reasons, exact: true };
  }

  const intended = CRON_PHASES[cron] || [];
  const reasons = {};
  const chosen = new Set();

  for (const p of intended) { chosen.add(p); reasons[p] = `scheduled (${cron})`; }

  for (const p of PHASES) {
    if (chosen.has(p)) continue;
    const age = minutesSince(lastSuccessByPhase[p], now);
    if (age > MAX_AGE_MINUTES[p]) {
      chosen.add(p);
      reasons[p] = age === Infinity
        ? 'catch-up (no recorded success)'
        : `catch-up (${Math.round(age)}m since last success, max ${MAX_AGE_MINUTES[p]}m)`;
    }
  }

  /* Non-exact force: an addition to a normal plan, used by nothing today but
   * kept distinct from `exact` so the two intentions never share a field. */
  for (const p of force) {
    if (PHASES.includes(p)) { chosen.add(p); reasons[p] = 'forced'; }
  }

  /* Fixed order, each phase at most once. The ordering is not cosmetic:
   * verifying sources after ingest would reconcile a table ingest has already
   * read, writing before ingesting would publish against yesterday's news, and
   * sweeping before writing would skip the articles just created. */
  return { phases: PHASES.filter((p) => chosen.has(p)), reasons };
}

/**
 * Whether the writer runs after an ingest that has already happened.
 *
 * The GitHub gate was `inserted != 0 || (even hour && minute < 30)`, which
 * made the baseline depend on a run landing inside a specific 30-minute
 * window. Runs did not land reliably, so the baseline was frequently missed
 * entirely - the direct cause of articles going 18 hours without a create.
 * Here the baseline is an age, not a window, so it cannot be missed by being
 * late.
 */
export function shouldWriteAfterIngest({ insertedNew, plannedPhases = [], lastSuccessByPhase = {}, now = Date.now() }) {
  if (insertedNew > 0) return { write: true, reason: `${insertedNew} new item(s) ingested` };
  if (plannedPhases.includes('write')) return { write: true, reason: 'write phase already planned' };
  const age = minutesSince(lastSuccessByPhase.write, now);
  if (age > MAX_AGE_MINUTES.write) {
    return { write: true, reason: age === Infinity ? 'no recorded write' : `${Math.round(age)}m since last write` };
  }
  return { write: false, reason: 'nothing new and baseline not due' };
}
