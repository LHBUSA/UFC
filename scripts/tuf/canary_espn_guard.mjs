#!/usr/bin/env node
/**
 * Canary for the TUF in-house event guard in ufc-stats-ingest.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/canary_espn_guard.mjs [--dates 20210727,20260919]
 *
 * Runs the Worker's own ESPN pass (the code that is deployed) against LIVE
 * ESPN and a READ-ONLY view of the production database. Every Supabase write
 * the pass attempts is intercepted, recorded and answered synthetically; none
 * reaches the database. The script refuses to run if a write slips past the
 * interceptor.
 *
 * What it proves, per date:
 *   - an ESPN "The Ultimate Fighter N Semifinal" event is skipped before any
 *     write: no ufc_events / ufc_bouts / ufc_bout_results / ufc_fighters write
 *     carries its ESPN event id or any of its competition ids, and the run notes
 *     name it under tuf_in_house_events_skipped
 *   - a real professional card on another date still produces its event write
 *     (and bout writes when the card is due a pass)
 *
 * Exit code 1 on any violation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const TUF_DATES = ['20171129', '20210727', '20210803', '20210810', '20210817', '20220628', '20220705', '20220712', '20220719'];
/* ESPN files the TUF 31 semifinals under different calendar days than their
 * listed dates, so they are fetched with a month range that also contains
 * real professional cards: both halves of the guard in one run. */
const MIXED_RANGES = ['20230720-20230820'];
const PRO_DATES = ['20210710', '20260919'];
const dates = argv.includes('--dates') ? argv[argv.indexOf('--dates') + 1].split(',') : [...TUF_DATES, ...MIXED_RANGES, ...PRO_DATES];

function loadEnv() {
  const file = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = { ...loadEnv(), UFCSTATS_ENABLED: 'false', DISCORD_WEBHOOK_URL: '' };
const SB = String(env.SUPABASE_URL).replace(/\/$/, '');

/* ---- the interceptor ------------------------------------------------------ */
const writes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = String(init.method || 'GET').toUpperCase();
  if (url.startsWith(SB)) {
    if (method !== 'GET' && method !== 'HEAD') {
      const table = new URL(url).pathname.replace('/rest/v1/', '');
      let body = null;
      try { body = JSON.parse(init.body); } catch { body = init.body ?? null; }
      writes.push({ method, table, query: new URL(url).search, body });
      const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
      const echo = rows.map((r, i) => ({ id: r.id || `canary-${table}-${writes.length}-${i}`, ...r }));
      return new Response(JSON.stringify(echo), { status: 201, headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, echo.length - 1)}/*` } });
    }
    return realFetch(input, init);
  }
  if (!/espn\.com/.test(url)) {
    /* Nothing but ESPN and read-only Supabase is allowed out of the canary. */
    throw new Error(`canary: blocked outbound request to ${new URL(url).host}`);
  }
  return realFetch(input, init);
};

const { __test } = await import(pathToWorker());
function pathToWorker() { return new URL(`file:///${path.join(ROOT, 'workers', 'ufc-stats-ingest', 'src', 'index.js').replace(/\\/g, '/')}`).href; }
const { Espn } = await import(new URL(`file:///${path.join(ROOT, 'workers', 'ufc-stats-ingest', 'src', 'espn.mjs').replace(/\\/g, '/')}`).href);

const ctx = await __test.loadContext(env);
const scout = JSON.parse(fs.readFileSync('D:/Workers/ufc-tuf-scout-2026-09-12/external/espn_tuf_semifinal_events.json', 'utf8'));
const tufEventIds = new Set(scout.map((e) => String(e.event_id)));
const tufCompIds = new Set(scout.flatMap((e) => e.competitions.map((c) => String(c.id))));

const report = [];
let violations = 0;
for (const d of dates) {
  const before = writes.length;
  const run = { events_new: 0, bouts_new: 0, fighters_touched: 0, assertion_failures: [], notes: {} };
  let error = null;
  try {
    await __test.espnPass(env, new Espn({ minIntervalMs: 300 }), ctx, run, { dates: [d], scope: 'fight-night' });
  } catch (e) {
    error = String(e?.message || e).slice(0, 160);
  }
  const mine = writes.slice(before);
  const text = JSON.stringify(mine);
  const leakedEvent = [...tufEventIds].filter((id) => text.includes(`"${id}"`));
  const leakedComp = [...tufCompIds].filter((id) => text.includes(`"${id}"`));
  const skipped = run.notes.tuf_in_house_events_skipped || [];
  const eventWrites = mine.filter((w) => w.table === 'ufc_events');
  const boutWrites = mine.filter((w) => w.table === 'ufc_bouts');
  const isTufDate = TUF_DATES.includes(d);
  const isMixed = MIXED_RANGES.includes(d);
  let ok;
  if (isMixed) ok = !error && skipped.length >= 4 && leakedEvent.length === 0 && leakedComp.length === 0 && eventWrites.length > 0 && eventWrites.every((w) => !/ultimate fighter \d+ semifinal/i.test(JSON.stringify(w.body)));
  else if (isTufDate) ok = !error && skipped.length > 0 && leakedEvent.length === 0 && leakedComp.length === 0 && eventWrites.every((w) => !/ultimate fighter/i.test(JSON.stringify(w.body)));
  else ok = !error && skipped.length === 0 && eventWrites.length > 0;
  if (!ok) violations += 1;
  report.push({
    date: d, kind: isMixed ? 'mixed_range' : isTufDate ? 'tuf_in_house' : 'professional', ok, error,
    listed: run.notes.espn_events_listed ?? null,
    skipped: skipped.map((s) => `${s.espn_event_id} ${s.name}`),
    intercepted_writes: mine.length,
    event_writes: eventWrites.map((w) => `${w.method} ${(Array.isArray(w.body) ? w.body[0] : w.body)?.name || w.query}`),
    bout_writes: boutWrites.length,
    leaked_tuf_ids: [...leakedEvent, ...leakedComp],
  });
}

for (const r of report) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.date} ${r.kind.padEnd(13)} listed=${r.listed} skipped=${r.skipped.length} writes=${r.intercepted_writes} events=${r.event_writes.length} bouts=${r.bout_writes}${r.error ? ` error=${r.error}` : ''}`);
  for (const s of r.skipped) console.log(`       skipped ${s}`);
  for (const e of r.event_writes) console.log(`       event write (intercepted) ${e}`);
  if (r.leaked_tuf_ids.length) console.log(`       LEAKED ${r.leaked_tuf_ids.join(', ')}`);
}
console.log(`\nintercepted writes total: ${writes.length}; none sent to the database`);
if (process.env.CANARY_OUT) fs.writeFileSync(process.env.CANARY_OUT, JSON.stringify({ at: new Date().toISOString(), report }, null, 1));
process.exitCode = violations ? 1 : 0;
