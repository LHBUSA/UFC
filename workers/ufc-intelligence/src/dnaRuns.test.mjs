import test from 'node:test';
import assert from 'node:assert/strict';
import { reapAbandonedRuns, liveRun, acquireLease, buildDeadline, BUILD_BUDGET_MS, CRON_WALL_LIMIT_MS, ABANDONED_AFTER_MS, LOCK_KEY } from './dnaRuns.js';
import { STALE_RUNNING_MS } from './dnaGuard.js';

const T = Date.parse('2026-10-07T07:17:00Z');

test('the 2026-10-07 incident: the four orphaned running rows are closed failed by the reaper, a live one is not', async () => {
  const calls = [];
  const sb = async (method, path, opts) => { calls.push({ method, path, opts }); return [{ id: 'a' }, { id: 'b' }]; };
  const ids = await reapAbandonedRuns(sb, T);
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].path, /status=eq\.running&started_at=lt\./);
  const cutoff = decodeURIComponent(calls[0].path.split('started_at=lt.')[1]);
  assert.equal(Date.parse(cutoff), T - ABANDONED_AFTER_MS, 'only rows older than the wall limit');
  assert.equal(calls[0].opts.body.status, 'failed');
  assert.match(calls[0].opts.body.errors[0], /abandoned/);
});

test('the budget leaves headroom inside the Cron wall limit; the guard and reaper agree on staleness', () => {
  assert.ok(BUILD_BUDGET_MS <= CRON_WALL_LIMIT_MS - 2 * 60 * 1000);
  assert.equal(buildDeadline(T), T + BUILD_BUDGET_MS);
  assert.equal(STALE_RUNNING_MS, ABANDONED_AFTER_MS);
});

test('single flight: a live run row blocks a second build; a dead one does not', () => {
  const runs = [{ id: 'old', status: 'running', started_at: new Date(T - 20 * 60e3).toISOString() }, { id: 'done', status: 'success', started_at: new Date(T - 60e3).toISOString() }];
  assert.equal(liveRun(runs, T), null);
  assert.equal(liveRun([...runs, { id: 'now', status: 'running', started_at: new Date(T - 5 * 60e3).toISOString() }], T).id, 'now');
});

test('single flight: the KV lease admits one holder until released or expired', async () => {
  const store = new Map();
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
  const release = await acquireLease(kv, T, 'cron');
  assert.equal(typeof release, 'function');
  assert.equal(await acquireLease(kv, T + 60e3, 'guard'), null, 'second trigger refused while held');
  assert.equal(typeof (await acquireLease(kv, T + CRON_WALL_LIMIT_MS + 1, 'guard')), 'function', 'an expired lease is taken over');
  await release();
  assert.equal(store.has(LOCK_KEY), false);
});
