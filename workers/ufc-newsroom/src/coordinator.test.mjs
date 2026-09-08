/* The scheduling coordinator. Run: node --test src/coordinator.test.mjs
 *
 * These tests exist because the previous scheduler failed silently. Each one
 * names the GitHub Actions behaviour it is preventing from coming back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRun, shouldWriteAfterIngest, PHASES, MAX_AGE_MINUTES, CRON_PHASES } from './coordinator.mjs';

const NOW = Date.parse('2026-09-08T14:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
/* A ledger where everything just ran, so nothing is overdue and each test
   only exercises the one thing it is about. */
const fresh = { sources: ago(1), ingest: ago(1), write: ago(1), refresh: ago(1), sweep: ago(1) };

test('the 30-minute cron runs ingest', () => {
  const { phases, reasons } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(phases, ['ingest']);
  assert.match(reasons.ingest, /scheduled/);
});

test('the two-hour cron runs the baseline refresh', () => {
  const { phases } = planRun({ cron: '15 */2 * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.ok(phases.includes('refresh'), 'refresh is the point of this slot');
  assert.ok(phases.includes('ingest'), 'and it ingests first, so the refresh sees current news');
  assert.ok(!phases.includes('sweep'), 'the daily sweep is not a two-hourly job');
});

test('the daily cron verifies sources and runs the editorial sweep', () => {
  const { phases } = planRun({ cron: '20 10 * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.ok(phases.includes('sweep'));
  assert.ok(phases.includes('sources'), 'feeds move; a source that is never re-verified stays enabled and silent');
  assert.ok(phases.indexOf('sources') < phases.indexOf('ingest'), 'and they are reconciled before ingest reads them');
  assert.ok(!phases.includes('refresh'), 'sweep and refresh are different jobs');
});

test('one invocation never runs a phase twice', () => {
  /* The dedupe that matters: a cron asks for ingest AND ingest is overdue. */
  const { phases } = planRun({
    cron: '15 */2 * * *', now: NOW,
    lastSuccessByPhase: { ...fresh, ingest: ago(600), refresh: ago(600) },
  });
  assert.deepEqual(phases, [...new Set(phases)], 'no duplicates');
  assert.equal(phases.filter((p) => p === 'ingest').length, 1);
  assert.equal(phases.filter((p) => p === 'refresh').length, 1);
});

test('phases always execute in dependency order', () => {
  const { phases } = planRun({ cron: '20 10 * * *', now: NOW, lastSuccessByPhase: {} });
  const idx = phases.map((p) => PHASES.indexOf(p));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b),
    'sources before ingest before write before refresh before sweep');
});

/* ---- the regression the whole module exists for ------------------------- */

test('a dropped slot is made up on the next invocation, whatever woke it', () => {
  /* GitHub delayed the daily portraits cron by 4.4 hours; because job
     selection keyed on the exact cron string, that run skipped news and
     reported success, and the missed slot was never made up. Here the
     every-30-minutes cron picks up everything that has gone overdue. */
  const stale = { sources: ago(1), ingest: ago(300), write: ago(400), refresh: ago(700), sweep: ago(3000) };
  const { phases, reasons } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: stale });
  assert.deepEqual(phases, ['ingest', 'write', 'refresh', 'sweep']);
  assert.match(reasons.refresh, /catch-up/);
  assert.match(reasons.sweep, /catch-up/);
});

test('a phase that has never run is overdue', () => {
  const { phases, reasons } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: {} });
  assert.deepEqual(phases, ['sources', 'ingest', 'write', 'refresh', 'sweep']);
  assert.match(reasons.sweep, /no recorded success/);
  assert.match(reasons.sources, /no recorded success/,
    'a newsroom that has never verified a feed should not wait a day to start');
});

test('an on-time schedule never triggers catch-up', () => {
  /* Each max-age must exceed its cadence, or every run would drag in every
     phase and the cadence would mean nothing. */
  for (const [phase, cadence] of [['ingest', 30], ['refresh', 120], ['sweep', 1440], ['sources', 1440]]) {
    assert.ok(MAX_AGE_MINUTES[phase] > cadence,
      `${phase} max age ${MAX_AGE_MINUTES[phase]}m must exceed its ${cadence}m cadence`);
    const { phases } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: { ...fresh, [phase]: ago(cadence) } });
    assert.ok(!phases.includes(phase) || phase === 'ingest', `${phase} is not overdue when on time`);
  }
});

test('an unknown cron still runs whatever is overdue rather than nothing', () => {
  /* Failing closed here would mean silence, which is the outage we are
     fixing. An unrecognised trigger does no harm; doing nothing does. */
  const { phases } = planRun({ cron: '0 0 31 2 *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(phases, [], 'nothing overdue, so nothing runs');
  const stale = planRun({ cron: '0 0 31 2 *', now: NOW, lastSuccessByPhase: { ...fresh, sweep: ago(5000) } });
  assert.deepEqual(stale.phases, ['sweep']);
  const noSources = planRun({ cron: '0 0 31 2 *', now: NOW, lastSuccessByPhase: { ...fresh, sources: ago(5000) } });
  assert.deepEqual(noSources.phases, ['sources'], 'overdue source verification is picked up by any trigger too');
});

test('every declared cron maps to phases, and every phase has a max age', () => {
  for (const [cron, phases] of Object.entries(CRON_PHASES)) {
    assert.ok(phases.length, `${cron} does something`);
    for (const p of phases) assert.ok(PHASES.includes(p), `${cron} -> ${p} is a real phase`);
  }
  for (const p of PHASES) assert.equal(typeof MAX_AGE_MINUTES[p], 'number', `${p} has a max age`);
});

/* ---- the writer gate ---------------------------------------------------- */

test('new items always write; nothing new plus a fresh baseline does not', () => {
  assert.equal(shouldWriteAfterIngest({ insertedNew: 3, lastSuccessByPhase: fresh, now: NOW }).write, true);
  assert.equal(shouldWriteAfterIngest({ insertedNew: 0, lastSuccessByPhase: fresh, now: NOW }).write, false);
});

test('the baseline is an age, not a 30-minute window', () => {
  /* The old gate was `even hour && minute < 30`. A run landing at 11:38 or
     13:29 - both real - missed it, so the writer was skipped even though the
     news job had just succeeded. An age cannot be missed by being late. */
  const overdue = shouldWriteAfterIngest({ insertedNew: 0, lastSuccessByPhase: { ...fresh, write: ago(200) }, now: NOW });
  assert.equal(overdue.write, true);
  assert.match(overdue.reason, /200m since last write/);

  for (const clock of ['2026-09-08T11:38:00Z', '2026-09-08T13:29:00Z', '2026-09-08T03:47:00Z']) {
    const at = Date.parse(clock);
    const r = shouldWriteAfterIngest({
      insertedNew: 0, now: at,
      lastSuccessByPhase: { write: new Date(at - 200 * 60000).toISOString() },
    });
    assert.equal(r.write, true, `${clock} is not an excuse to skip an overdue write`);
  }
});
