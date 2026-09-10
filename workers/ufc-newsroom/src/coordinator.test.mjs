/* The scheduling coordinator. Run: node --test src/coordinator.test.mjs
 *
 * These tests exist because the previous scheduler failed silently. Each one
 * names the GitHub Actions behaviour it is preventing from coming back.
 *
 * REVISED 2026-09-10, when article generation left this Worker. The suite used
 * to assert a five-phase plan -- sources, ingest, write, refresh, sweep --
 * because this Worker both orchestrated the pipeline and wrote the event-level
 * articles. Those three phases are now ufc-event-editorial's, so the assertions
 * describing them were not failures to fix: they specified behaviour that moved.
 * What remains, and is still the reason a coordinator exists at all, is
 * catch-up: a dropped slot must be made up on whatever wakes the Worker next.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRun, PHASES, MAX_AGE_MINUTES, CRON_PHASES } from './coordinator.mjs';

const NOW = Date.parse('2026-09-08T14:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
/* A ledger where everything just ran, so nothing is overdue and each test
   only exercises the one thing it is about. */
const fresh = { sources: ago(1), ingest: ago(1) };

test('the phase set is the control plane only', () => {
  assert.deepEqual(PHASES, ['sources', 'ingest'],
    'a write/refresh/sweep phase reappearing here means article generation came back to the control plane');
  assert.deepEqual(Object.keys(MAX_AGE_MINUTES).sort(), ['ingest', 'sources']);
});

test('the 30-minute cron runs ingest', () => {
  const { phases, reasons } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(phases, ['ingest']);
  assert.match(reasons.ingest, /scheduled/);
});

test('the two-hour cron observes the wire and nothing more', () => {
  const { phases } = planRun({ cron: '15 */2 * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(phases, ['ingest'], 'the article slot moved to ufc-event-editorial');
});

test('the daily cron verifies the feed registry before observing the wire', () => {
  const { phases } = planRun({ cron: '20 10 * * *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(phases, ['sources', 'ingest'],
    'sources first: ingest reads the table sources reconciles');
});

test('one invocation never runs a phase twice', () => {
  /* The dedupe that matters: a cron asks for ingest AND ingest is overdue. */
  const { phases } = planRun({
    cron: '15 */2 * * *', now: NOW,
    lastSuccessByPhase: { ...fresh, ingest: ago(600) },
  });
  assert.deepEqual(phases, [...new Set(phases)], 'no duplicates');
  assert.equal(phases.filter((p) => p === 'ingest').length, 1);
});

test('phases always execute in dependency order', () => {
  const { phases } = planRun({ cron: '20 10 * * *', now: NOW, lastSuccessByPhase: {} });
  const idx = phases.map((p) => PHASES.indexOf(p));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'sources before ingest, always');
});

test('a dropped slot is made up on the next invocation, whatever woke it', () => {
  /* A cron that does NOT schedule ingest, with ingest overdue. That is the
   * real case: the slot that should have run it was dropped, so some other
   * trigger has to notice. Using the half-hour cron here would prove
   * nothing: it schedules ingest anyway, so the reason would read scheduled. */
  const stale = { sources: ago(1), ingest: ago(300) };
  const { phases, reasons } = planRun({ cron: '0 0 31 2 *', now: NOW, lastSuccessByPhase: stale });
  assert.deepEqual(phases, ['ingest']);
  assert.match(reasons.ingest, /catch-up/);
});

test('a phase that has never run is overdue', () => {
  const { phases, reasons } = planRun({ cron: '*/30 * * * *', now: NOW, lastSuccessByPhase: {} });
  assert.deepEqual(phases, ['sources', 'ingest']);
  assert.match(reasons.sources, /no recorded success/);
});

test('an on-time schedule never triggers catch-up', () => {
  for (const [phase, cadence] of [['ingest', 30], ['sources', 1440]]) {
    const on = planRun({
      cron: '*/30 * * * *', now: NOW,
      lastSuccessByPhase: { ...fresh, [phase]: ago(cadence) },
    });
    assert.ok(!/catch-up/.test(on.reasons[phase] || ''),
      `${phase} at its intended cadence must not look overdue`);
  }
});

test('an unknown cron still runs whatever is overdue rather than nothing', () => {
  const quiet = planRun({ cron: '0 0 31 2 *', now: NOW, lastSuccessByPhase: fresh });
  assert.deepEqual(quiet.phases, [], 'nothing overdue, nothing to do');
  const noSources = planRun({
    cron: '0 0 31 2 *', now: NOW,
    lastSuccessByPhase: { ...fresh, sources: ago(5000) },
  });
  assert.deepEqual(noSources.phases, ['sources'], 'overdue source verification is picked up by any trigger too');
});

test('the baseline is an age, not a 30-minute window', () => {
  /* The original GitHub bug: the gate required an even hour and a minute under
   * 30, a window real runs frequently missed, so work was skipped even when it
   * was plainly due. Overdue is measured against what last SUCCEEDED. */
  const late = planRun({
    cron: '*/30 * * * *', now: Date.parse('2026-09-08T14:47:00Z'),
    lastSuccessByPhase: { sources: ago(1), ingest: ago(200) },
  });
  assert.ok(late.phases.includes('ingest'), 'a late invocation still catches up');
});

test('every declared cron maps to phases, and every phase has a max age', () => {
  for (const [cron, phases] of Object.entries(CRON_PHASES)) {
    assert.ok(phases.length, `${cron} does something`);
    for (const p of phases) assert.ok(PHASES.includes(p), `${cron} -> ${p} is a real phase`);
  }
  for (const p of PHASES) assert.equal(typeof MAX_AGE_MINUTES[p], 'number', `${p} has a max age`);
});
