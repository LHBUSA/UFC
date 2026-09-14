/* Fighter status on the news-ingest host.
 *
 * ufc-news-ingest owns the freshest ufc_news_items (every two minutes), so it
 * is the natural host for availability extraction: news ingest -> status
 * extraction -> lifecycle, with no second feed fetcher anywhere. This module is
 * glue only. Extraction, fingerprints, idempotent inserts and the lifecycle are
 * the shared scripts/status code the CLI and tests already exercise; nothing
 * here calls a model or writes an article.
 *
 * Telemetry: the last pass is kept in KV for /health, and every pass that ran
 * on the period or changed anything is written to ufc_ingest_runs
 * (worker=ufc-fighter-status) as the durable record. */
import { runStatusPass } from '../../../scripts/status/status_pass.mjs';
import { Supabase } from '../../../scripts/news/lib.mjs';

export const STATUS_PERIOD_MIN = 10;
export const STATUS_WINDOW_HOURS = 6;
export const STATUS_LEDGER_WORKER = 'ufc-fighter-status';
const KV_KEY = 'fighter-status:last';

/** True on the bounded periodic slots (every STATUS_PERIOD_MIN minutes). */
export function statusDue(scheduledTime) {
  const d = new Date(Number(scheduledTime) || Date.now());
  return d.getUTCMinutes() % STATUS_PERIOD_MIN === 0;
}

/** Flatten a runStatusPass result into the counters /health and the ledger carry. */
export function summarizePass(result, { trigger, at, sinceHours }) {
  const c = result?.steps?.collect || {};
  const l = result?.steps?.lifecycle || {};
  return {
    at, trigger, status: result?.status ?? 'failed', wrote: Boolean(result?.wrote), window_hours: sinceHours,
    duration_ms: result?.duration_ms ?? null,
    items_inspected: c.items_read ?? null, candidates: c.candidates ?? null, events_emitted: c.events ?? null,
    below_confidence: c.below_confidence ?? null,
    inserted: c.inserted ?? null, duplicate_noop: c.duplicate_noop ?? null, rejected: c.rejected ?? null,
    lifecycle_resolved: l.resolved ?? null, lifecycle_expired: l.expired ?? null, lifecycle_applied: l.applied ?? null,
    failures: (result?.failures || []).map((f) => `${f.step}: ${f.detail}`).slice(0, 3),
  };
}

export async function loadStatusHealth(kv) {
  if (!kv) return { last_pass: null, freshness_minutes: null };
  try {
    const last = await kv.get(KV_KEY, 'json');
    return { last_pass: last, freshness_minutes: last?.at ? Math.round((Date.now() - Date.parse(last.at)) / 60000) : null };
  } catch {
    return { last_pass: null, freshness_minutes: null };
  }
}

/**
 * One status pass. Never throws: a status failure must not affect ingest.
 * `write:false` is a true dry run (no rows, no transitions, no ledger, no KV).
 */
export async function statusPass(env, { trigger = 'cron', write = true, sinceHours = STATUS_WINDOW_HOURS, detail = false, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  let result;
  try {
    /* ingest:false — this host just ingested; a second fetch path is exactly
     * what the architecture forbids. minConfidence left to the shared default. */
    result = await runStatusPass(env, { write, ingest: false, lifecycle: true, sinceHours, now });
  } catch (e) {
    result = { status: 'failed', steps: {}, failures: [{ step: 'status', detail: String(e?.message || e).slice(0, 200) }], wrote: write };
  }
  const summary = summarizePass(result, { trigger, at, sinceHours });

  if (write) {
    try { await env.UFC_NEWS_KV?.put(KV_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 }); } catch { /* telemetry only */ }
    const changed = (summary.inserted || 0) + (summary.lifecycle_applied || 0) + (summary.rejected || 0) > 0;
    if (trigger === 'periodic' || trigger === 'admin' || changed || summary.status !== 'success') {
      try {
        await new Supabase(env).insert('ufc_ingest_runs', [{
          worker: STATUS_LEDGER_WORKER, started_at: at, finished_at: new Date().toISOString(),
          events_new: summary.inserted ?? 0, bouts_new: 0, fighters_touched: summary.events_emitted ?? 0,
          assertion_failures: summary.failures,
          status: summary.status === 'success' || summary.status === 'degraded' ? 'success' : summary.status === 'partial' ? 'partial' : 'failed',
          notes: summary,
        }], { returning: false });
      } catch (e) {
        console.error(`[fighter-status] ledger write failed: ${String(e?.message || e).slice(0, 160)}`);
      }
    }
  }
  console.log(`[fighter-status] ${summary.status} trigger=${trigger} items=${summary.items_inspected} events=${summary.events_emitted} inserted=${summary.inserted} noop=${summary.duplicate_noop} rejected=${summary.rejected} resolved=${summary.lifecycle_resolved} expired=${summary.lifecycle_expired}`);
  return detail ? { summary, result } : { summary };
}
