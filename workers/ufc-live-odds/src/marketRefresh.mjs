/* Post-capture market context refresh notification (owner decision 2026-09-15, "A+").
 *
 * After a successful PRE-FIGHT snapshot is written, tell ufc-algo which market
 * run succeeded so the PBE Picks card reflects it within seconds. The only
 * payload is identity/provenance (run id + observed_at): ufc-algo owns every
 * market comparison, probability and PBE Edge.
 *
 * Best-effort and isolated. A missing binding, a timeout or an error is
 * reported and swallowed: the stored odds capture has already succeeded and
 * stays successful, and the next hourly model cycle recovers the card. */

export async function notifyMarketRefresh(binding, { runId, observedAt, snapshotRows }, { timeoutMs = 20_000 } = {}) {
  if (!binding || typeof binding.refresh !== 'function') return { notified: false, reason: 'no_binding' };
  if (!runId || !snapshotRows) return { notified: false, reason: 'nothing_written' };
  let timer;
  try {
    const out = await Promise.race([
      binding.refresh({ runId, observedAt }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`market refresh timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    return {
      notified: true,
      refused: out?.refused ?? null,
      bouts: out?.bouts ?? null,
      predictions: out?.predictions ?? null,
      refreshed: out?.refreshed ?? null,
      results: out?.results ?? null,
      errors: Array.isArray(out?.errors) ? out.errors.length : null,
      finished_at: out?.finished_at ?? null,
    };
  } catch (e) {
    return { notified: false, reason: 'error', error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
