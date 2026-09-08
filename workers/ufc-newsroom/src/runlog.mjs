/* Run ledger and concurrency guard, on the existing ufc_ingest_runs table.
 *
 * No schema change: that table already carries a `worker` discriminator, a
 * status enum including 'partial', and a free-form notes jsonb. The newsroom
 * writes rows with worker='ufc-newsroom' and keeps its counters in notes.
 *
 * The ledger is not bookkeeping here, it is the input to scheduling. The
 * coordinator asks "when did this phase last succeed?" and that question can
 * only be answered by rows like these, which is precisely what the GitHub
 * workflow had no way to ask - and why a dropped cron slot was never made up.
 *
 * ON THIS LOCK, honestly: it is advisory and it is the FALLBACK. Reading for a
 * running row and then inserting one is two round trips with no transaction,
 * so two invocations landing in the same instant both read "nothing running"
 * and both proceed. Nothing here makes that unconstructible.
 *
 * What each guard actually buys, kept apart because they are not
 * interchangeable:
 *
 *   lock.mjs (Durable Object)   excludes concurrent runs outright, and is
 *                               therefore the only thing that prevents two
 *                               invocations both paying Anthropic for the same
 *                               rewrite. Used whenever NEWSROOM_LOCK is bound.
 *   unique indexes              prevent duplicate ROWS unconditionally —
 *                               ufc_news_items.fingerprint, .url and
 *                               ufc_articles.slug mean two concurrent writers
 *                               produce one row and one conflict. They cannot
 *                               prevent duplicate WORK or duplicate spend: the
 *                               losing writer has already built its drafts and
 *                               paid for its rewrite before the INSERT fails.
 *   this file                   reduces wasted work and keeps the ledger
 *                               legible when the Durable Object is not bound.
 *
 * So: duplicate publication is impossible in every configuration; duplicate
 * execution is impossible only with the Durable Object, and merely unlikely
 * without it. index.js records which of the two was in force as
 * notes.concurrency_guard, so the ledger never leaves that to be guessed.
 */

export const WORKER = 'ufc-newsroom';

/* A run still 'running' after this long did not finish, it died - a Worker
 * that is CPU-killed or times out never gets to write its closing row. Past
 * this the lock is ignored, or one crash would stop the newsroom forever. */
export const STALE_RUN_MINUTES = 20;

export async function findActiveRun(sb, now = Date.now()) {
  const rows = await sb.select('ufc_ingest_runs',
    `select=id,started_at,status&worker=eq.${WORKER}&status=eq.running&order=started_at.desc&limit=5`);
  for (const r of rows || []) {
    const age = (now - Date.parse(r.started_at)) / 60000;
    if (Number.isFinite(age) && age < STALE_RUN_MINUTES) return { ...r, age_minutes: Math.round(age) };
  }
  return null;
}

/**
 * When each phase last SUCCEEDED, from the ledger.
 *
 * Read from completed runs only. A phase inside a run that crashed did not
 * succeed, and treating it as if it had would suppress the catch-up that is
 * the entire point of recording this.
 */
export async function lastSuccessByPhase(sb) {
  const rows = await sb.select('ufc_ingest_runs',
    `select=finished_at,status,notes&worker=eq.${WORKER}&status=in.(success,partial)&order=finished_at.desc&limit=60`);
  const out = {};
  for (const r of rows || []) {
    const done = r?.notes?.phases_succeeded;
    if (!Array.isArray(done) || !r.finished_at) continue;
    for (const p of done) if (!out[p]) out[p] = r.finished_at;
  }
  return out;
}

export async function openRun(sb, { cron, invoked, phases, reasons }) {
  const created = await sb.insert('ufc_ingest_runs', {
    worker: WORKER,
    status: 'running',
    notes: { cron: cron || null, invoked, phases_planned: phases, phase_reasons: reasons },
  });
  return created?.[0]?.id || null;
}

export async function closeRun(sb, runId, { status, notes, failures = [] }) {
  if (!runId) return;
  try {
    await sb.patch('ufc_ingest_runs', `id=eq.${runId}`, {
      finished_at: new Date().toISOString(),
      status,
      assertion_failures: failures,
      notes,
    });
  } catch (e) {
    /* Losing the closing row is bad - it leaves a phantom lock and hides a
     * phase's success from the next coordinator - but it must not mask the
     * original outcome, so it is logged and swallowed. */
    console.error(`[${WORKER}] could not close run ${runId}: ${String(e?.message || e).slice(0, 160)}`);
  }
}
