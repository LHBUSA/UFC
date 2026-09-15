// Lock-time market comparison. Run: node --test src/market.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketComparison, officialMarketColumns, comparisonRows, americanFromImplied, MARKET_FRESH_MINUTES } from './market.js';
import { impliedFromAmerican } from '../../../scripts/model/market_baseline.mjs';

const A = 'fighter-a', B = 'fighter-b';
const q = (run, observedAt, book, fighter, price, upd = observedAt) => ({ run_id: run, market_key: 'h2h', bookmaker_key: book, outcome_fighter_id: fighter, price, observed_at: observedAt, source_last_update: upd });
const snap = (run, at, pa = -150, pb = 130) => [q(run, at, 'dk', A, pa), q(run, at, 'dk', B, pb), q(run, at, 'fd', A, pa - 10), q(run, at, 'fd', B, pb + 5)];
const LOCK_PASS = '2026-09-18T16:41:00.000Z';
const EVENT = '2026-09-19';

test('lock pass (final 24h): FRESH <= 60 min, the delta is the official comparison', () => {
  const m = marketComparison({ snapshots: snap(9, '2026-09-18T16:26:00.000Z'), pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS, eventDate: EVENT });
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
  const m = marketComparison({ snapshots: snap(8, '2026-09-18T15:26:00.000Z'), pickFighterId: A, pickProbability: 0.64, nowIso: LOCK_PASS, eventDate: EVENT });
  assert.equal(m.status, 'STALE');
  assert.equal(m.freshness_band, 'T-24h');
  assert.equal(m.age_minutes, 75);
  assert.equal(m.pbe_delta_pts, null, 'a stale delta is never published as current');
  assert.ok(Number.isFinite(m.stale_delta_pts), 'but it is kept for audit under a separate name');
  assert.deepEqual(officialMarketColumns(m), { market_implied_prob_pick: null, market_books: null, model_edge_pts: null, market_snapshot_at: null });
  /* The production case: the only prices on file were a 2026-09-08 snapshot. */
  const old = marketComparison({ observations: snap(null, '2026-09-08T12:25:03.000Z'), pickFighterId: A, pickProbability: 0.57, nowIso: LOCK_PASS, eventDate: EVENT });
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

/* ---- fight-week freshness (owner decision 2026-09-15) and presentation prices ---- */

const T7 = '2026-09-14T15:41:09.000Z';   // UFC 331, T-7d band
const T72 = '2026-09-16T20:41:00.000Z';  // T-72h band
const T24 = '2026-09-18T12:41:00.000Z';  // final 24h
const at = (nowIso, minutes) => new Date(Date.parse(nowIso) - minutes * 60000).toISOString();
const cmp = (nowIso, rows, extra = {}) => marketComparison({ snapshots: rows, pickFighterId: A, pickProbability: 0.64, nowIso, eventDate: EVENT, ...extra });

test('phase-aware status: T-7d <= 730, T-72h <= 370, T-24h <= 60; overdue -> STALE with no edge', () => {
  for (const [now, ok, over, band] of [[T7, 730, 731, 'T-7d'], [T72, 370, 371, 'T-72h'], [T24, 60, 61, 'T-24h']]) {
    const cur = cmp(now, snap(1, at(now, ok)));
    assert.equal(cur.status, 'FRESH', `${band} at ${ok} min`);
    assert.equal(cur.freshness_band, band);
    assert.ok(Number.isFinite(cur.pbe_delta_pts));
    assert.ok(cur.current_until >= now);
    const late = cmp(now, snap(1, at(now, over)));
    assert.equal(late.status, 'STALE', `${band} at ${over} min`);
    assert.equal(late.pbe_delta_pts, null);
    assert.equal(late.current_until, null);
    assert.deepEqual(officialMarketColumns(late), { market_implied_prob_pick: null, market_books: null, model_edge_pts: null, market_snapshot_at: null });
    /* The last observed odds stay visible (LAST OBSERVED), never as a current edge. */
    assert.ok(late.pick_consensus_odds != null && late.pick_best_odds != null);
  }
});

test('an unchanged sportsbook price re-checked by a new capture is current: observed_at decides, not source_last_update', () => {
  const rows = [q(2, at(T24, 10), 'dk', A, -150, '2026-09-10T00:00:00Z'), q(2, at(T24, 10), 'dk', B, 130, '2026-09-10T00:00:00Z')];
  const m = cmp(T24, rows);
  assert.equal(m.status, 'FRESH');
  assert.equal(m.age_minutes, 10);
  assert.equal(m.newest_book_update, '2026-09-10T00:00:00Z', 'book repricing time stays visible provenance');
});

test('American odds: negative favourite, positive underdog, exactly +100', () => {
  assert.equal(americanFromImplied(impliedFromAmerican(-150)), -150);
  assert.equal(americanFromImplied(impliedFromAmerican(130)), 130);
  assert.equal(americanFromImplied(impliedFromAmerican(100)), 100);
  assert.equal(americanFromImplied(impliedFromAmerican(-100)), 100, 'an even market is written +100');
  assert.equal(americanFromImplied(0.5), 100);
  assert.equal(americanFromImplied(1), null);
  const even = cmp(T24, [q(3, at(T24, 5), 'dk', A, 100), q(3, at(T24, 5), 'dk', B, 100)]);
  assert.equal(even.pick_consensus_odds, 100);
  assert.equal(even.opponent_consensus_odds, 100);
  assert.equal(even.devigged_pick, 0.5);
});

test('consensus = median implied across books converted back (never a mean of American numbers); an outlier book cannot drag it', () => {
  const t = at(T24, 5);
  const rows = [
    q(4, t, 'dk', A, -150), q(4, t, 'dk', B, 130),
    q(4, t, 'fd', A, -160), q(4, t, 'fd', B, 135),
    q(4, t, 'mgm', A, -155), q(4, t, 'mgm', B, 130),
    q(4, t, 'outlier', A, 900), q(4, t, 'outlier', B, -2000),
  ];
  const m = cmp(T24, rows);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return (s[1] + s[2]) / 2; };
  const iA = med([-150, -160, -155, 900].map(impliedFromAmerican));
  assert.equal(m.pick_consensus_odds, americanFromImplied(iA));
  assert.ok(m.pick_consensus_odds <= -150 && m.pick_consensus_odds >= -160, `consensus ${m.pick_consensus_odds} stays with the pack`);
  assert.notEqual(m.pick_consensus_odds, Math.round((-150 - 160 - 155 + 900) / 4), 'not an average of American numbers');
  assert.equal(m.books, 4);
  /* Best price = most favourable to the bettor = lowest implied probability, with its book. */
  assert.equal(m.pick_best_odds, 900);
  assert.equal(m.pick_best_book, 'outlier');
  assert.equal(m.opponent_best_odds, 135);
  assert.equal(m.opponent_best_book, 'fd');
});

test('best price and book come only from the newest complete snapshot; a book absent from it is not carried forward', () => {
  const older = [q(5, at(T24, 50), 'dk', A, -150), q(5, at(T24, 50), 'dk', B, 130), q(5, at(T24, 50), 'gone', A, 250), q(5, at(T24, 50), 'gone', B, -300)];
  const newer = [q(6, at(T24, 5), 'dk', A, -140), q(6, at(T24, 5), 'dk', B, 120), q(6, at(T24, 5), 'fd', A, -145), q(6, at(T24, 5), 'fd', B, 125)];
  const m = cmp(T24, [...older, ...newer]);
  assert.equal(m.books, 2);
  assert.equal(m.pick_best_odds, -140);
  assert.equal(m.pick_best_book, 'dk');
  assert.notEqual(m.pick_best_book, 'gone');
  assert.equal(m.observed_at, at(T24, 5));
});

test('prices resolve to the right fighter ids, and reversing orientation gives the same market truth', () => {
  const t = at(T24, 5);
  const rows = [q(7, t, 'dk', A, -700), q(7, t, 'dk', B, 500), q(7, t, 'fd', A, -850), q(7, t, 'fd', B, 480)];
  const asA = marketComparison({ snapshots: rows, pickFighterId: A, pickProbability: 0.43, nowIso: T24, eventDate: EVENT });
  const asB = marketComparison({ snapshots: [...rows].reverse(), pickFighterId: B, pickProbability: 0.57, nowIso: T24, eventDate: EVENT });
  assert.equal(asA.opponent_fighter_id, B);
  assert.equal(asB.opponent_fighter_id, A);
  assert.equal(asA.pick_consensus_odds, asB.opponent_consensus_odds);
  assert.equal(asA.opponent_consensus_odds, asB.pick_consensus_odds);
  assert.equal(asA.pick_best_odds, asB.opponent_best_odds);
  assert.equal(asA.devigged_pick, asB.devigged_opponent);
  assert.ok(asA.pick_consensus_odds < 0 && asB.pick_consensus_odds > 0, 'A is the favourite on both views');
});

test('de-vigged sides sum to 1; PBE Edge uses the de-vigged probability, never raw implied', () => {
  const t = at(T24, 5);
  const m = marketComparison({ snapshots: [q(8, t, 'dk', A, -700), q(8, t, 'dk', B, 500)], pickFighterId: B, pickProbability: 0.5719, nowIso: T24, eventDate: EVENT });
  assert.ok(Math.abs(m.devigged_pick + m.devigged_opponent - 1) < 1e-3);
  assert.ok(m.raw_implied_pick + m.raw_implied_opponent > 1, 'raw sides carry the vig');
  const rawB = impliedFromAmerican(500), rawA = impliedFromAmerican(-700);
  assert.equal(m.pbe_delta_pts, Math.round((0.5719 - rawB / (rawA + rawB)) * 10000) / 100);
  assert.notEqual(m.pbe_delta_pts, Math.round((0.5719 - rawB) * 10000) / 100);
});

test('unavailable market: no odds, no edge, never dressed as stale', () => {
  const m = cmp(T7, [q(9, at(T7, 5), 'dk', A, -150)]);
  assert.equal(m.status, 'UNAVAILABLE');
  assert.equal(m.pick_consensus_odds, undefined);
  assert.equal(m.pbe_delta_pts, undefined);
});
