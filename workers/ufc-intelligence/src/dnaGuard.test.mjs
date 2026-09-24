import test from 'node:test';
import assert from 'node:assert/strict';
import { dnaGuardDecision, GUARD_MAX_ATTEMPTS } from './dnaGuard.js';

const D = '2026-09-24';
const run = (status, started_at, id = status) => ({ id, as_of_date: D, status, started_at });

test('the 2026-09-24 incident: a failed 07:17 run with no success is resumed at the next hourly tick', () => {
  const r = dnaGuardDecision({ nowIso: `${D}T08:47:00Z`, runs: [run('failed', `${D}T07:17:40Z`, 'd62ef89c')] });
  assert.equal(r.action, 'resume');
  assert.equal(r.reason, 'last_run_failed');
  assert.equal(r.last_run_id, 'd62ef89c');
});

test('a partial run (reconciliation short) is resumed, never treated as done', () => {
  assert.equal(dnaGuardDecision({ nowIso: `${D}T09:47:00Z`, runs: [run('partial', `${D}T07:17:00Z`)] }).action, 'resume');
});

test('a success for today stops the guard, even after earlier failures', () => {
  const r = dnaGuardDecision({ nowIso: `${D}T23:47:00Z`, runs: [run('failed', `${D}T07:17:40Z`), run('success', `${D}T08:47:10Z`)] });
  assert.deepEqual([r.action, r.reason], ['none', 'success_recorded']);
});

test('the morning belongs to the daily cron; the guard does nothing before 08:00Z', () => {
  assert.equal(dnaGuardDecision({ nowIso: `${D}T07:47:00Z`, runs: [] }).action, 'none');
});

test('a missed cron (no run at all today) is built by the guard', () => {
  assert.deepEqual(dnaGuardDecision({ nowIso: `${D}T08:47:00Z`, runs: [] }).reason, 'no_run_today');
});

test('a run in progress is left alone; a running row older than 30 minutes is stale and resumed', () => {
  assert.equal(dnaGuardDecision({ nowIso: `${D}T08:47:00Z`, runs: [run('running', `${D}T08:40:00Z`)] }).action, 'none');
  const r = dnaGuardDecision({ nowIso: `${D}T08:47:00Z`, runs: [run('running', `${D}T07:17:00Z`)] });
  assert.deepEqual([r.action, r.reason], ['resume', 'stale_running']);
});

test('attempts are bounded; exhaustion is reported, not retried forever', () => {
  const r = dnaGuardDecision({ nowIso: `${D}T12:47:00Z`, runs: [run('failed', `${D}T11:47:00Z`)], attempts: GUARD_MAX_ATTEMPTS });
  assert.equal(r.action, 'exhausted');
});

test('runs for other dates never count as today', () => {
  const r = dnaGuardDecision({ nowIso: `${D}T08:47:00Z`, runs: [{ id: 'y', as_of_date: '2026-09-23', status: 'success', started_at: '2026-09-23T07:17:00Z' }] });
  assert.equal(r.action, 'resume');
});
