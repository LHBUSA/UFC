#!/usr/bin/env node
// Per-window progress summary for the backfill queue.
//
// The worker's own [end] line is a flat counter dump. This turns one window
// into the shape a human actually asks about: what was attempted, what was
// created, what was already there, and - just as important - what was missed
// and why. Gaps and assertions are reported next to the wins, because a
// window that "finished" while silently recording 40 archive gaps is not the
// same result as one that finished clean.
//
// Counts come from the window log. Referee assignments come from the database
// for that window's year, since the worker does not log them; each window is
// one calendar year, so the mapping is exact.
//
//   node scripts/backfill/window_summary.mjs [--label B-2016] [--json out.json]
//
// With no --label every window that has run is summarised.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const LOGS = path.join(HERE, 'logs');

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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, accept: 'application/json' };

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

/* PowerShell's redirect writes UTF-16LE, with a byte-order mark on the files
 * it creates itself and without one on text appended later, so both shapes
 * have to be recognised or the whole log silently parses as zeroes. */
function readMaybeUtf16(p) {
  if (!fs.existsSync(p)) return '';
  const b = fs.readFileSync(p);
  if (b.length < 2) return b.toString('utf8');
  const bom = b[0] === 0xff && b[1] === 0xfe;
  if (bom) return b.subarray(2).toString('utf16le');
  if (b[1] === 0) return b.toString('utf16le');
  return b.toString('utf8');
}

/* Cheap exact count: PostgREST returns it in content-range, no rows fetched. */
async function count(q) {
  if (!URL_ || !KEY) return null;
  const sep = q.includes('?') ? '&' : '?';
  const r = await fetch(`${URL_}/rest/v1/${q}${sep}select=*&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
  if (!r.ok) return null;
  return Number((r.headers.get('content-range') || '/0').split('/')[1]) || 0;
}

const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : 0; };
const occurrences = (s, needle) => s.split(needle).length - 1;

/* A window that failed and is being retried appears twice in the log. Taking
 * the last [window_done] alone would report the previous run's exit code for
 * a window that is currently running, which reads as a fresh failure. The
 * completion only belongs to this attempt if it came after the latest start. */
function windowTimes(label) {
  const lines = readMaybeUtf16(path.join(LOGS, 'queue_status.txt')).split(/\r?\n/);
  let start = null, done = null, exit = null;
  for (const l of lines) {
    let m = l.match(/^\s*\[window_start\]\s+(\S+)\s+(\S+)/);
    if (m && m[2] === label) { start = m[1]; done = null; exit = null; }
    m = l.match(/^\s*\[window_done\]\s+(\S+)\s+(\S+)\s+exit=(\S+)/);
    if (m && m[2] === label) { done = m[1]; exit = m[3]; }
  }
  return { start, done, exit };
}

function fmtElapsed(start, done) {
  if (!start) return '—';
  const a = new Date(start), b = done ? new Date(done) : new Date();
  const s = Math.max(0, Math.round((b - a) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h ` : ''}${m}m${done ? '' : ' (running)'}`;
}

async function summarise(label) {
  const p = path.join(LOGS, `${label}.out`);
  const t = readMaybeUtf16(p);
  const { start, done, exit } = windowTimes(label);
  const year = label.replace(/^[AB]-/, '');

  const planned = num(t, /\[fights_phase\]\s+events=(\d+)/);
  const enriched = occurrences(t, '[event_done]');
  const skipped = occurrences(t, '[event_skip]');
  const gapsMissing = occurrences(t, '[wayback_missing]');
  const gapsPreview = occurrences(t, '[fight_preview_capture]');
  const preEvent = occurrences(t, '[wayback_pre_event_captures]');
  const retries = occurrences(t, '[wayback_retry]');
  const assertions = occurrences(t, 'ASSERTION_FAILURE');
  const mismatches = occurrences(t, 'RESULT_MISMATCH');
  const review = num(t, /review_queued=(\d+)/);

  const refs = await count(`ufc_referee_bouts?event_date=gte.${year}-01-01&event_date=lte.${year}-12-31`);

  /* The worker only prints its counters in the [end] line, so a window still
   * running would report 0 for everything it has actually written. A zero
   * that means "not summarised yet" is exactly the kind of number this
   * codebase refuses to show, so mid-flight totals are summed from the upsert
   * log instead and the completed run uses the authoritative counters. */
  const running = exit === null;
  const sumUpserts = (table) => {
    let n = 0;
    for (const m of t.matchAll(new RegExp(`\\[upsert\\] table=${table} rows=(\\d+)`, 'g'))) n += Number(m[1]);
    return n;
  };
  const liveRounds = running ? sumUpserts('ufc_bout_round_stats') : null;
  const liveResults = running ? sumUpserts('ufc_bout_results') : null;

  return {
    window: label,
    lane: label.startsWith('A') ? 'A round-stat depth' : 'B structural breadth',
    status: exit === null ? 'running' : exit === '0' ? 'ok' : `exit ${exit}`,
    events_attempted: planned || enriched + skipped,
    events_enriched: enriched,
    events_skipped: skipped,
    bouts_created: num(t, /bouts_new=(\d+)/),
    bouts_linked: num(t, /bouts_linked=(\d+)/),
    fighters_created: num(t, /fighters_inserted=(\d+)/),
    fighters_linked: num(t, /fighters_linked=(\d+)/),
    fighters_stubbed: num(t, /fighters_stubbed=(\d+)/),
    referee_assignments_year: refs,
    round_rows: liveRounds ?? num(t, /round_rows=(\d+)/),
    results_written: liveResults ?? num(t, /results_written=(\d+)/),
    results_enriched: num(t, /results_enriched=(\d+)/),
    gaps_archive_missing: gapsMissing,
    gaps_prefight_capture: gapsPreview,
    pre_event_captures_dropped: preEvent,
    retries,
    assertions,
    result_mismatches: mismatches,
    identity_review_queued: review,
    elapsed: fmtElapsed(start, done),
  };
}

const main = async () => {
  let labels = [];
  if (opt('--label')) labels = [opt('--label')];
  else {
    labels = fs.existsSync(LOGS)
      ? fs.readdirSync(LOGS).filter((f) => /^[AB]-\d{4}\.out$/.test(f)).map((f) => f.replace('.out', ''))
      : [];
    const order = JSON.parse(fs.readFileSync(path.join(HERE, 'windows.json'), 'utf8')).windows.map((w) => w.label);
    labels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  if (!labels.length) { console.log('no window logs yet'); return; }

  const rows = [];
  for (const l of labels) rows.push(await summarise(l));

  for (const r of rows) {
    console.log(`\n=== ${r.window}  (${r.lane})  ${r.status}  ${r.elapsed} ===`);
    console.log(`  events        attempted ${r.events_attempted}  enriched ${r.events_enriched}  skipped ${r.events_skipped}`);
    console.log(`  bouts         created ${r.bouts_created}  linked ${r.bouts_linked}`);
    console.log(`  fighters      created ${r.fighters_created}  linked ${r.fighters_linked}  stubbed ${r.fighters_stubbed}`);
    console.log(`  results       ${r.status === 'running' ? `${r.results_written} written so far` : `written ${r.results_written}  enriched ${r.results_enriched}`}`);
    console.log(`  referees      ${r.referee_assignments_year === null ? 'n/a' : `${r.referee_assignments_year} assignments loaded for ${r.window.slice(2)}`}`);
    console.log(`  round rows    ${r.round_rows}${r.status === 'running' ? ' so far' : ''}`);
    console.log(`  gaps          archive missing ${r.gaps_archive_missing}  pre-fight capture ${r.gaps_prefight_capture}  pre-event dropped ${r.pre_event_captures_dropped}`);
    console.log(`  integrity     retries ${r.retries}  assertions ${r.assertions}  result mismatches ${r.result_mismatches}  identity review ${r.identity_review_queued}`);
  }

  const tot = rows.reduce((a, r) => {
    for (const k of ['events_enriched', 'events_skipped', 'bouts_created', 'fighters_created', 'fighters_linked', 'round_rows', 'gaps_archive_missing', 'retries', 'assertions']) a[k] = (a[k] || 0) + r[k];
    return a;
  }, {});
  console.log(`\n=== TOTAL across ${rows.length} window(s) ===`);
  console.log(`  events enriched ${tot.events_enriched}  skipped ${tot.events_skipped}`);
  console.log(`  bouts created ${tot.bouts_created}  fighters created ${tot.fighters_created}  linked ${tot.fighters_linked}`);
  console.log(`  round rows ${tot.round_rows}  gaps ${tot.gaps_archive_missing}  retries ${tot.retries}  assertions ${tot.assertions}`);

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({ generated_at: new Date().toISOString(), windows: rows, totals: tot }, null, 2) + '\n');
    console.log(`\njson -> ${opt('--json')}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
