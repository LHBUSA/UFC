// Lock-time market comparison. Run: node --test src/market.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketComparison, officialMarketColumns, comparisonRows, MARKET_FRESH_MINUTES } from './market.js';

const A = 'fighter-a', B = 'fighter-b';
const q = (run, observedAt, book, fighter, price, upd = observedAt) => ({ run_id: run, market_key: 'h2h', bookmaker_key: book, outcome_fighter_id: fighter, price, observed_at: observedAt, source_last_update: upd });
const snap = (run, at, pa = -150, pb = 130) => [q(run, at, 'dk', A, pa), q(run, at, 'dk', B, pb), q(run, at, 'fd', A, pa - 10), q(run, at, 'fd', B, pb + 5)];
const LOCK_PASS = '2026-09-18T16:41:00.000Z';

test('FRESH (<= 60 min): the delta is the official comparison', () => {
  const m = marketComparison({ snapshots: snap(9, '2026-09-18T16:26:00.000Z'), pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS });
  assert.equal(MARKET_FRESH_MINUTES, 60);
  assert.equal(m.status, 'FRESH');
  assert.equal(m.age_minutes, 15);
  assert.equal(m.source, 'snapshot');
  assert.ok(Number.isFinite(m.pbe_delta_pts));
  assert.equal(m.stale_delta_pts, null);
  const cols = officialMarketColumns(m);
  assert.equal(cols.model_edge_pts, m.pbe_delta_pts);
  assert.equal(cols.market_snapshot_at, '2026-09-18T16:26:00.000Z');
});

test('STALE: age visible, no current delta, no official comparison columns', () => {
  const m = marketComparison({ snapshots: snap(8, '2026-09-18T15:26:00.000Z'), pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS });
  assert.equal(m.status, 'STALE');
  assert.equal(m.age_minutes, 75);
  assert.equal(m.pbe_delta_pts, null, 'a stale delta is never published as current');
  assert.ok(Number.isFinite(m.stale_delta_pts), 'but it is kept for audit under a separate name');
  assert.deepEqual(officialMarketColumns(m), { market_implied_prob_pick: null, market_books: null, model_edge_pts: null, market_snapshot_at: null });
  /* The production case: the only prices on file were a 2026-09-08 snapshot. */
  const old = marketComparison({ observations: snap(null, '2026-09-08T12:25:03.000Z'), pickFighterId: A, pickProbability: 0.57, nowIso: LOCK_PASS });
  assert.equal(old.status, 'STALE');
  assert.equal(old.source, 'change_history');
  assert.ok(old.age_minutes > 60 * 24 * 10);
});

test('no observation after the lock pass can influence the comparison', () => {
  const before = snap(8, '2026-09-18T16:30:00.000Z', -150, 130);
  const after = snap(10, '2026-09-18T16:45:00.000Z', -400, 300); // wildly different, observed after the pass
  const m = marketComparison({ snapshots: [...before, ...after], pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS });
  const onlyBefore = marketComparison({ snapshots: before, pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS });
  assert.deepEqual(m, onlyBefore);
  assert.equal(m.observed_at, '2026-09-18T16:30:00.000Z');
  assert.deepEqual(comparisonRows({ snapshots: after, nowIso: LOCK_PASS }).rows, [], 'a post-lock snapshot alone gives nothing');
});

test('the newest complete snapshot is used, never a blend of runs', () => {
  const rows = comparisonRows({ snapshots: [...snap(7, '2026-09-18T10:00:00.000Z', -500, 350), ...snap(8, '2026-09-18T16:30:00.000Z')], nowIso: LOCK_PASS });
  assert.equal(new Set(rows.rows.map((r) => r.run_id)).size, 1);
  assert.equal(rows.rows[0].run_id, 8);
});

test('UNAVAILABLE when no two-sided price exists; null when there is no pick', () => {
  assert.equal(marketComparison({ snapshots: [q(1, '2026-09-18T16:30:00.000Z', 'dk', A, -150)], pickFighterId: A, pickProbability: 0.6, nowIso: LOCK_PASS }).status, 'UNAVAILABLE');
  assert.equal(marketComparison({ snapshots: [], observations: [], pickFighterId: A, pickProbability: 0.6, nowIso: LOCK_PASS }).status, 'UNAVAILABLE');
  assert.equal(marketComparison({ snapshots: snap(1, LOCK_PASS), pickFighterId: null, pickProbability: null, nowIso: LOCK_PASS }), null);
  assert.deepEqual(officialMarketColumns({ status: 'UNAVAILABLE' }).model_edge_pts, null);
});
