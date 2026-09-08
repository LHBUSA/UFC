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
 * ON THE LOCK, honestly: it is advisory. Reading for a running row and then
 * inserting one is not atomic, so two invocations landing in the same instant
 * could both proceed. That is tolerable because it is not what protects the
 * product. Duplicate publication is prevented by unique indexes on
 * ufc_news_items.fingerprint, ufc_news_items.url and ufc_articles.slug: two
 * concurrent writers produce one row and one conflict, not two articles. The
 * lock exists to stop two runs wasting work and confusing the ledger, and it
 * is described as advisory so nobody later mistakes it for the guarantee.
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
