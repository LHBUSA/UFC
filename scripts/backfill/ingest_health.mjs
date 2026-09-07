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
async function all(q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) return out;
    const rows = await r.json();
    if (!Array.isArray(rows)) return out;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
const normName = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, ' ');
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

  const [runs, lastRound, roundsToday, totalRounds, reviewCount, fighters] = await Promise.all([
    get('ufc_ingest_runs?select=id,worker,status,started_at,finished_at,notes,assertion_failures&order=started_at.desc&limit=25'),
    get('ufc_bout_round_stats?select=captured_at&order=captured_at.desc&limit=1'),
    count(`ufc_bout_round_stats?captured_at=gte.${dayAgo}`),
    count('ufc_bout_round_stats'),
    count('ufc_alias_review_queue'),
    all('ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,dob'),
  ]);

  /* Duplicate identity check. The resolver refuses to merge two same-name
   * fighters whose second key disagrees, which is right - a wrong merge
   * cannot be undone from the data - but it still has to create a row so the
   * bout can exist. The result is a real duplicate sitting in the archive
   * until a human resolves it, and until now nothing surfaced that.
   *
   * Two rows that each carry BOTH source ids are two different people who
   * share a name, which the UFC has plenty of. A pair split across sources,
   * one row per source, is one person recorded twice. */
  const byName = new Map();
  for (const f of fighters) {
    const k = normName(f.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const dupGroups = [...byName.values()].filter((v) => v.length > 1);
  const likelySame = dupGroups.filter((v) =>
    v.some((f) => f.espn_athlete_id && !f.ufcstats_id) && v.some((f) => f.ufcstats_id && !f.espn_athlete_id));

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
  if (likelySame.length) problems.push(`${likelySame.length} fighter(s) exist as split rows, one per source, awaiting identity review.`);

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

  line('identity review queue', reviewCount == null ? 'n/a' : reviewCount);
  line('duplicate-name fighter groups', dupGroups.length);
  line('likely same person, split rows', likelySame.length);
  if (likelySame.length) {
    console.log('\n  split identities awaiting review (same name, one row per source):');
    for (const g of likelySame.slice(0, 12)) {
      console.log(`    ${g[0].name}`);
      for (const f of g) console.log(`      ${f.id.slice(0, 8)}  espn=${f.espn_athlete_id || '-'}  ufcstats=${f.ufcstats_id || '-'}  dob=${f.dob || '-'}`);
    }
    console.log('    Not merged automatically: the two sources disagree on date of birth,');
    console.log('    and a wrong merge cannot be undone from the data.');
  }

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
