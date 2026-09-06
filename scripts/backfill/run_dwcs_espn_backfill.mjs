#!/usr/bin/env node
/* Historical Dana White's Contender Series repair.
 *
 * Reuses the production ufc-stats-ingest implementation without forking its
 * identity/result rules. The worker's runIngest() is intentionally private in
 * production, so this script creates a temporary sibling module that exports
 * it and adds a single event-name filter before invoking it. The temporary
 * module is deleted after the run and is never committed.
 *
 * Usage:
 *   node scripts/backfill/run_dwcs_espn_backfill.mjs --year 2017
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const year = Number(opt('--year'));
if (!Number.isInteger(year) || year < 2017 || year > new Date().getUTCFullYear()) {
  throw new Error('--year must be an integer from 2017 through the current year');
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const sourcePath = resolve('workers/ufc-stats-ingest/src/index.js');
const runtimePath = resolve(dirname(sourcePath), `.dwcs-backfill-runtime-${process.pid}.mjs`);
let source = await readFile(sourcePath, 'utf8');
const driverNeedle = 'async function runIngest(env) {';
const eventNeedle = '    const ev = await espn.event(ref);\n    const espnId = String(ev.raw.id);';
if (!source.includes(driverNeedle)) throw new Error('worker runIngest signature changed; refusing runtime patch');
if (!source.includes(eventNeedle)) throw new Error('worker ESPN event loop changed; refusing runtime patch');
source = source.replace(driverNeedle, 'export async function runIngest(env) {');
source = source.replace(eventNeedle, `    const ev = await espn.event(ref);\n    const eventFilter = String(env.EVENT_NAME_FILTER || '').trim().toLowerCase();\n    if (eventFilter && !String(ev.raw.name || '').toLowerCase().includes(eventFilter)) continue;\n    const espnId = String(ev.raw.id);`);

await writeFile(runtimePath, source, 'utf8');
try {
  const mod = await import(`${pathToFileURL(runtimePath).href}?v=${Date.now()}`);
  if (typeof mod.runIngest !== 'function') throw new Error('runtime worker did not export runIngest');
  const env = {
    ...process.env,
    ESPN_DATES: String(year),
    EVENT_NAME_FILTER: 'contender series',
    MAX_EVENTS_PER_RUN: '30',
    UFCSTATS_ENABLED: 'false',
    DISCORD_WEBHOOK_URL: '',
  };
  console.log(`DWCS backfill START year=${year}`);
  const result = await mod.runIngest(env);
  console.log(`DWCS backfill END year=${year} status=${result?.status} events_new=${result?.events_new || 0} bouts_new=${result?.bouts_new || 0}`);
  if (result?.status !== 'success') throw new Error(`worker returned ${result?.status || 'unknown status'}`);

  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const qs = new URLSearchParams({
    select: 'id,name,event_date,card_status',
    event_date: `gte.${year}-01-01`,
    and: `(event_date.lt.${year + 1}-01-01,name.ilike.*Contender*Series*)`,
    order: 'event_date.asc',
  });
  const verify = await fetch(`${base}/rest/v1/ufc_events?${qs}`, { headers });
  if (!verify.ok) throw new Error(`verification HTTP ${verify.status}`);
  const rows = await verify.json();
  console.log(`DWCS verification year=${year} events=${rows.length}`);
  if (!rows.length) throw new Error(`no Contender Series events found after ${year} backfill`);
} finally {
  await unlink(runtimePath).catch(() => {});
}
