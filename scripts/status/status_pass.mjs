#!/usr/bin/env node
/* The ten-minute status pass. One call, three cheap steps, no model, no articles.
 *
 *   node scripts/status/status_pass.mjs [--write] [--since-hours 6] [--no-ingest]
 *
 * WHY THIS EXISTS
 *
 * The collector reads ufc_news_items. If news ingest only runs every thirty
 * minutes then a ten-minute status check is theatre: it re-reads a table that
 * has not changed, and the real SLA on learning that a main event is off is
 * whatever the ingest cadence is. Worst case a withdrawal sits unseen for
 * twenty-nine minutes while a job that "runs every ten minutes" reports
 * success three times.
 *
 * So the pass owns its own freshness. It ingests, then extracts, then ages the
 * table — and each of those is cheap enough to do six times an hour:
 *
 *   1. ingest    five RSS fetches, parse, dedupe, link, insert. INJECTED, not
 *                imported — see below.
 *   2. extract   regexes over the items whose taxonomy makes them worth
 *                opening, then an idempotent insert.
 *   3. lifecycle expire what its card outlived, resolve what a source ended.
 *
 * WHY INGEST IS INJECTED RATHER THAN IMPORTED
 *
 * It must be the SAME scripts/news/ingest_news.mjs the newsroom runs, because
 * fighter/event/bout linking is decided policy and a second implementation
 * would answer differently. But on this branch that module still calls main()
 * at import time with no CLI guard, so importing it here would start a live
 * ingest as a side effect of loading this file. The Worker-callable version —
 * `main(injectedEnv, options)` behind an isCli guard — lives on
 * ufc-newsroom-worker-v1, and forking it here would leave two branches editing
 * the same lines, which is precisely the integration collision this review
 * already caught once with the migration version.
 *
 * So the capability is declared and passed in. The newsroom Worker supplies
 * its own callable ingest in one line; this branch runs the other two steps
 * and reports the ingest step as unavailable rather than pretending. A pass
 * that silently skipped it would claim ten-minute freshness it does not have.
 *
 * WHAT IT MUST NEVER DO
 *
 * Call a model, or write an article. Publication is expensive, occasionally
 * pays Anthropic per story, and is entirely fine on a two-hourly cadence;
 * running it six times an hour to learn about a withdrawal would be paying for
 * a newspaper to find out the time. The two also fail differently — a desk
 * outage must not stop the newsroom knowing who is out, and a malformed feed
 * item must not stop the day's articles — so they are separate entry points
 * with separate failure containment.
 *
 * That is not a promise in a comment: status_pass.test.mjs walks this module's
 * transitive import graph and fails if write_articles, polish_world_class or
 * any Anthropic transport ever appears in it.
 */
import { loadEnv } from '../news/lib.mjs';
import { collectStatusEvents } from './collect_status_events.mjs';
import { runLifecycle } from './lifecycle_pass.mjs';

export function parseCliOptions(argv = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    write: flag('--write'),
    ingest: !flag('--no-ingest'),
    lifecycle: !flag('--no-lifecycle'),
    sinceHours: Number(opt('--since-hours', 6)) || 6,
    minConfidence: Number(opt('--min-confidence', 0.6)) || 0.6,
  };
}

export function resolveOptions(options = {}) {
  return {
    write: Boolean(options.write),
    /* A function (env) => Promise, supplied by the host. Absent means this
     * host has no callable ingest, which is reported, not skipped silently. */
    ingestFn: typeof options.ingestFn === 'function' ? options.ingestFn : null,
    ingest: options.ingest !== false,
    lifecycle: options.lifecycle !== false,
    /* A nonsense window falls back to the default rather than clamping to the
     * nearest legal value: a caller passing -5 has a bug, and silently reading
     * one hour instead of six would narrow the window at exactly the moment
     * somebody is confused about it. Too wide is clamped; not-a-window is
     * replaced. */
    sinceHours: Math.min(24 * 7, Number(options.sinceHours) > 0 ? Number(options.sinceHours) : 6),
    minConfidence: Math.min(1, Math.max(0, Number(options.minConfidence) ?? 0.6)),
    now: options.now ?? Date.now(),
  };
}

/**
 * One pass. Never throws for a failure in one step.
 *
 * Each step is contained on its own: if ingest cannot reach a feed, extraction
 * still runs over what is already stored; if extraction throws, the lifecycle
 * still ages the table so a stale withdrawal does not survive a bad regex.
 * A status system whose three parts can only work together has the
 * availability of the least reliable one.
 */
export async function runStatusPass(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const env = injectedEnv || loadEnv();
  const started = Date.now();
  const steps = {};
  const failures = [];

  if (opts.ingest) {
    if (!opts.ingestFn) {
      /* Said out loud, because this is the difference between a ten-minute SLA
       * and a ten-minute job reading a thirty-minute table. */
      steps.ingest = {
        ok: false, available: false,
        note: 'no callable ingest supplied; status freshness is bounded by whatever else writes ufc_news_items',
      };
    } else {
      try {
        /* The host's own ingest. It performs no model call and writes only
         * ufc_news_items. */
        await opts.ingestFn(env);
        steps.ingest = { ok: true, available: true };
      } catch (e) {
        steps.ingest = { ok: false, available: true };
        failures.push({ step: 'ingest', detail: String(e?.message || e).slice(0, 200) });
      }
    }
  }

  try {
    const c = await collectStatusEvents(env, {
      write: opts.write, sinceHours: opts.sinceHours, minConfidence: opts.minConfidence, now: opts.now,
    });
    steps.collect = {
      ok: true,
      candidates: c.candidates, events: c.events.length,
      offered: c.offered, inserted: c.inserted, duplicate_noop: c.duplicate_noop, rejected: c.rejected,
    };
  } catch (e) {
    steps.collect = { ok: false };
    failures.push({ step: 'collect', detail: String(e?.message || e).slice(0, 200) });
  }

  if (opts.lifecycle) {
    try {
      const l = await runLifecycle(env, { write: opts.write, now: opts.now });
      steps.lifecycle = { ok: true, resolved: l.resolve.length, expired: l.expire.length, ambiguous: l.ambiguous.length, applied: l.applied };
    } catch (e) {
      steps.lifecycle = { ok: false };
      failures.push({ step: 'lifecycle', detail: String(e?.message || e).slice(0, 200) });
    }
  }

  const ms = Date.now() - started;
  /* 'degraded' is not cosmetic. A pass that cannot ingest still extracts and
   * still ages the table, so it did useful work and 'failed' would be wrong —
   * but it cannot meet the freshness the ten-minute cadence exists for, and
   * recording that as 'success' is exactly the silent-success pattern that let
   * the previous scheduler drop slots for weeks while reporting green. */
  const degraded = Object.values(steps).some((x) => x.available === false);
  const status = failures.length
    ? (Object.values(steps).some((x) => x.ok) ? 'partial' : 'failed')
    : (degraded ? 'degraded' : 'success');
  console.log(`[status-pass] ${status} in ${ms}ms  ${JSON.stringify(steps)}`);
  for (const f of failures) console.error(`[status-pass] ${f.step} failed: ${f.detail}`);
  return { status, steps, failures, duration_ms: ms, wrote: opts.write };
}

/* CLI only. Importing this module must never fetch, write, or transition. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('status_pass.mjs');
if (isCli) runStatusPass(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
