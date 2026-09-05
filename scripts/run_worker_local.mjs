/* Run the ufc-stats-ingest Worker's scheduled handler locally in Node.
 *
 *   node scripts/run_worker_local.mjs [--dates 20251214] [--max-events 1] [--ufcstats]
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DISCORD_WEBHOOK_URL from
 * the repo .env. No R2 binding (cookie persistence and raw-HTML archive are
 * skipped; the Worker handles a missing RAW binding). Same code path the
 * cron runs — this is the production proof, not a mock.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
env.UFCSTATS_BASE = env.UFCSTATS_BASE || 'http://ufcstats.com';
env.MAX_EVENTS_PER_RUN = opt('--max-events', '1');
env.UFCSTATS_ENABLED = args.includes('--ufcstats') ? 'true' : 'false';
if (opt('--dates')) env.ESPN_DATES = opt('--dates');
if (!args.includes('--discord')) delete env.DISCORD_WEBHOOK_URL;

const worker = (await import('../workers/ufc-stats-ingest/src/index.js')).default;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
console.log(`[local] scheduled() dates=${env.ESPN_DATES || '(default)'} max_events=${env.MAX_EVENTS_PER_RUN} ufcstats=${env.UFCSTATS_ENABLED}`);
await worker.scheduled({ cron: 'local' }, env, ctx);
await Promise.all(pending);
const health = await (await worker.fetch(new Request('http://local/health'), env)).json();
console.log(JSON.stringify(health.last_result, null, 2));
process.exit(health.last_result?.status === 'success' ? 0 : 1);
