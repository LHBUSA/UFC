#!/usr/bin/env node
/* The live weigh-in pass — operator CLI.
 *
 *   node scripts/weighins/weighin_pass.mjs [--write] [--fetch] [--event <id>] [--force]
 *
 * PRODUCTION DOES NOT RUN THIS FILE. The production owner of weigh-in
 * collection is the Cloudflare Worker `ufc-weigh-ins` (workers/ufc-weigh-ins),
 * fired by a one-minute Cloudflare cron and gated by lib/window.mjs. This CLI
 * runs the SAME pass (lib/pass_core.mjs) for an operator: dry by default, and
 * it only contacts UFC.com when --fetch is given.
 *
 * WHAT IT MUST NEVER DO: call Anthropic, generate an article, trigger a Fight
 * DNA or model build. pass.test.mjs walks the transitive import graph of both
 * this file and the pass core and fails if any of them appear.
 *
 * LOCK_ID is 'weigh-ins', not the newsroom's. See lib/pass_core.mjs.
 */
import { Supabase, loadEnv } from '../news/lib.mjs';
import { runWeighInPass as runCore, storeReadings as storeCore, mirrorMisses as mirrorCore, resolveOptions, LOCK_ID, WORKER } from './lib/pass_core.mjs';
import { planWindow, CADENCE } from './lib/window.mjs';
import { SOURCE_ADAPTERS } from './lib/sources.mjs';

export { LOCK_ID, WORKER, resolveOptions, planWindow };

export function parseCliOptions(argv = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return { write: flag('--write'), force: flag('--force'), eventId: opt('--event', null), verbose: flag('--verbose'), fetchImpl: flag('--fetch') ? fetch : null };
}

/** Same signature as before the Worker existed: (env, options). */
export async function runWeighInPass(injectedEnv, options = {}) {
  const env = injectedEnv || loadEnv();
  return runCore({ sb: new Supabase(env), log: console }, { trigger: 'cli', ...options });
}

export const storeReadings = (sb, readings, opts) => storeCore(sb, readings, opts);
export const mirrorMisses = (sb, rows, readings, opts) => mirrorCore(sb, rows, readings, opts);

export { SOURCE_ADAPTERS, CADENCE };

/* CLI only. Importing this module must never fetch, write, or mirror. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('weighin_pass.mjs');
if (isCli) {
  runWeighInPass(undefined, parseCliOptions(process.argv.slice(2)))
    .then((r) => console.log(JSON.stringify({ status: r.status, plan: r.plan, event: r.event?.name, coverage: r.coverage, counters: r.counters, sources: r.sources }, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
