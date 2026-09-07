#!/usr/bin/env node
// Ingest health. Answers one question: is round-level data actually arriving?
//
// This exists because the round-stat pass was switched off in production and
// nothing said so. ESPN kept writing events, results and fighters, so every
// surface looked healthy while no round data landed at all. A green run row
// meant "the worker ran", not "the data arrived".
//
// So the checks here are about arrival, not execution: when a round row was
// last written, how many landed in the last day, and whether the flag that
// controls all of it is on. A run that completes successfully while writing
// zero round rows is reported as a problem, not a success.
//
//   node scripts/backfill/ingest_health.mjs [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, accept: 'application/json' };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const get = async (q) => {
  const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: H });
  return r.ok ? r.json() : null;
};
const count = async (q) => {
  const r = await fetch(`${URL_}/rest/v1/${q}${q.includes('?') ? '&' : '?'}select=*&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
  return r.ok ? Number((r.headers.get('content-range') || '/0').split('/')[1]) || 0 : null;
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

const main = async () => {
  const dayAgo = new Date(Date.now() - 86400000).toISOString();

  const [runs, lastRound, roundsToday, totalRounds] = await Promise.all([
    get('ufc_ingest_runs?select=id,worker,status,started_at,finished_at,notes,assertion_failures&order=started_at.desc&limit=25'),
    get('ufc_bout_round_stats?select=captured_at&order=captured_at.desc&limit=1'),
    count(`ufc_bout_round_stats?captured_at=gte.${dayAgo}`),
    count('ufc_bout_round_stats'),
  ]);

  const ingestRuns = (runs || []).filter((r) => r.worker && r.worker !== 'backfill_ufcstats');
  const lastIngest = ingestRuns[0] || null;
  const lastOk = ingestRuns.find((r) => r.status === 'success') || null;
  /* The flag is recorded per run now, but older rows predate that, so fall
   * back to the skip note rather than reporting the state as unknown. */
  const flagOf = (r) => {
    if (!r) return null;
    if (typeof r.notes?.ufcstats_enabled === 'boolean') return r.notes.ufcstats_enabled;
    if (typeof r.notes?.ufcstats_pass === 'string' && r.notes.ufcstats_pass.includes('UFCSTATS_ENABLED=false')) return false;
    return null;
  };
  const flag = flagOf(lastIngest) ?? flagOf(lastOk);
  const lastRoundsWritten = lastOk?.notes?.round_rows ?? null;

  const lastAssert = ingestRuns.find((r) => Array.isArray(r.assertion_failures) && r.assertion_failures.length);
  const lastError = ingestRuns.find((r) => r.status === 'failed');

  const problems = [];
  if (flag === false) problems.push('UFCSTATS_ENABLED is false: no round-level data is being ingested at all.');
  if (flag === null) problems.push('UFCSTATS_ENABLED state is not recorded on any recent run.');
  if (!lastRound?.[0]?.captured_at) problems.push('No round-stat row has ever been written.');
  else if (Date.now() - new Date(lastRound[0].captured_at) > 14 * 86400000) problems.push('No round-stat row written in over 14 days.');
  if (lastIngest && lastIngest.status === 'failed') problems.push('The most recent ingest run failed.');
  if (!lastIngest) problems.push('No scheduled ingest run found at all.');

  const line = (l, v) => console.log(`  ${l.padEnd(34)} ${v}`);
  console.log('\n=== UFC STATS INGEST HEALTH ===');
  line('UFCSTATS_ENABLED', flag === null ? 'unknown' : flag ? 'true' : 'FALSE — round stats off');
  line('last scheduled run', lastIngest ? `${lastIngest.status} · ${ago(lastIngest.started_at)}` : 'none');
  line('last successful run', lastOk ? ago(lastOk.started_at) : 'none');
  line('last completed event processed', lastOk?.notes?.ufcstats_events_targeted != null ? `${lastOk.notes.ufcstats_events_targeted} targeted` : 'n/a');
  line('forward cutoff', lastOk?.notes?.ufcstats_forward_cutoff || 'n/a');
  line('round rows last run', lastRoundsWritten == null ? 'n/a' : lastRoundsWritten);
  line('round rows last 24h', roundsToday == null ? 'n/a' : roundsToday);
  line('last round-stat write', ago(lastRound?.[0]?.captured_at));
  line('round rows total', totalRounds == null ? 'n/a' : totalRounds.toLocaleString());
  line('last source error', lastError ? `${ago(lastError.started_at)} · ${String(lastError.notes?.last_error?.error || lastError.notes?.error || 'see run row').slice(0, 60)}` : 'none in last 25 runs');
  line('last schema assertion', lastAssert ? `${ago(lastAssert.started_at)} · ${String(lastAssert.assertion_failures[0]?.detail || '').slice(0, 60)}` : 'none in last 25 runs');

  console.log(problems.length ? '\nPROBLEMS' : '\nNo problems detected.');
  for (const p of problems) console.log(`  ! ${p}`);

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      ufcstats_enabled: flag,
      last_run: lastIngest && { status: lastIngest.status, started_at: lastIngest.started_at },
      last_success_at: lastOk?.started_at || null,
      round_rows_last_run: lastRoundsWritten,
      round_rows_last_24h: roundsToday,
      last_round_write_at: lastRound?.[0]?.captured_at || null,
      round_rows_total: totalRounds,
      problems,
    }, null, 2) + '\n');
    console.log(`\njson -> ${opt('--json')}`);
  }
  process.exit(problems.length ? 1 : 0);
};
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
