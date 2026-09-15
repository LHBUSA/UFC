// Fight-week contract. Run: node --test scripts/odds/fight_week_cadence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIGHT_WEEK_BANDS, fightWeekBand, lockDeadlineFor, lockWindowOpensFor, marketFreshness } from './fight_week_cadence.mjs';

const EVENT = '2026-09-19';                       // UFC 331
const LOCK = lockDeadlineFor(EVENT);              // 2026-09-18T18:00Z
const H = 3_600_000, M = 60_000;
const iso = (ms) => new Date(ms).toISOString();

test('lock authority: deadline event 00:00Z - 6h, window opens - 8h', () => {
  assert.equal(iso(LOCK), '2026-09-18T18:00:00.000Z');
  assert.equal(iso(lockWindowOpensFor(EVENT)), '2026-09-18T16:00:00.000Z');
});

test('bands and limits: 720+10, 360+10, 60 with no tolerance', () => {
  assert.deepEqual(FIGHT_WEEK_BANDS.map((b) => [b.band, b.intervalMinutes, b.currentMinutes]), [['T-7d', 720, 730], ['T-72h', 360, 370], ['T-24h', 60, 60]]);
  assert.equal(fightWeekBand(EVENT, LOCK - 5 * 24 * H).band, 'T-7d');
  assert.equal(fightWeekBand(EVENT, LOCK - 72 * H - 1).band, 'T-7d');
  assert.equal(fightWeekBand(EVENT, LOCK - 72 * H).band, 'T-72h', 'boundary belongs to the stricter band');
  assert.equal(fightWeekBand(EVENT, LOCK - 24 * H).band, 'T-24h');
  assert.equal(fightWeekBand(EVENT, Date.parse('2026-09-18T16:41:00Z')).band, 'T-24h', 'first lock pass');
  assert.equal(fightWeekBand(EVENT, Date.parse('2026-09-18T17:41:00Z')).band, 'T-24h', 'second lock pass');
});

test('T-7d current iff age <= 730 min', () => {
  const now = LOCK - 4 * 24 * H;
  assert.equal(marketFreshness(EVENT, iso(now - 730 * M), now).current, true);
  assert.equal(marketFreshness(EVENT, iso(now - 730 * M - 1000), now).current, false);
});

test('T-72h current iff age <= 370 min', () => {
  const now = LOCK - 48 * H;
  assert.equal(marketFreshness(EVENT, iso(now - 370 * M), now).current, true);
  assert.equal(marketFreshness(EVENT, iso(now - 371 * M), now).current, false);
});

test('T-24h current iff age <= 60 min (lock passes keep the strict rule)', () => {
  const now = Date.parse('2026-09-18T16:41:00Z');
  assert.equal(marketFreshness(EVENT, '2026-09-18T15:41:00.000Z', now).current, true);
  assert.equal(marketFreshness(EVENT, '2026-09-18T15:40:59.000Z', now).current, false);
  assert.equal(marketFreshness(EVENT, '2026-09-18T16:25:30.000Z', now).current, true);
});

test('current_until: own limit inside a band, clipped at a band boundary when the next limit is shorter', () => {
  const now = LOCK - 4 * 24 * H;
  const obs = now - 60 * M;
  assert.equal(marketFreshness(EVENT, iso(obs), now).current_until, iso(obs + 730 * M));
  /* 3h before the T-72h boundary, observed 5h ago: at the boundary it is 8h old > 370 min. */
  const nearBoundary = LOCK - 75 * H;
  assert.equal(marketFreshness(EVENT, iso(nearBoundary - 5 * H), nearBoundary).current_until, iso(LOCK - 72 * H));
  /* Observed 1h before the T-72h boundary: still inside 370 min after it. */
  const justBefore = LOCK - 73 * H;
  assert.equal(marketFreshness(EVENT, iso(justBefore), justBefore).current_until, iso(justBefore + 370 * M));
});

test('fails closed: unknown card date uses the 60-minute rule; bad timestamp is not current', () => {
  const now = Date.parse('2026-09-15T15:41:00Z');
  assert.equal(marketFreshness(null, '2026-09-15T13:06:08Z', now).current, false);
  assert.equal(marketFreshness(null, '2026-09-15T14:50:00Z', now).current, true);
  assert.equal(marketFreshness(EVENT, null, now).current, false);
});

test('the UFC 331 production case: 13:06Z T-7d snapshot is current at the 15:41Z cycle', () => {
  const f = marketFreshness(EVENT, '2026-09-15T13:06:08.935Z', Date.parse('2026-09-15T15:41:09Z'));
  assert.equal(f.band, 'T-7d');
  assert.equal(f.current, true);
  assert.equal(f.limit_minutes, 730);
  /* Not 13:06Z + 730 min: the card enters T-72h at 2026-09-15T18:00Z, where the
   * snapshot (4.9h old) is still inside 370 min, which runs out at 19:16Z. */
  assert.equal(f.current_until, '2026-09-15T19:16:08.935Z');
});
