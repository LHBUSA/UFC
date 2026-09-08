/* Market maths. Run: npm run test:market
 *
 * These are the claims the UI makes on the reader's behalf, so they are the
 * ones worth pinning: that an age is described in the right unit, that the
 * stale threshold actually distinguishes a late run from a skipped one, that
 * a price survives conversion to probability and back, and above all that a
 * single ingest says nothing about movement. See market.test-hooks.mjs for
 * why `server-only` needs stubbing here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./market.test-hooks.mjs', import.meta.url);
const M = await import('./market.ts');

test('describeAge speaks in the right unit', () => {
  assert.equal(M.describeAge(null), 'at an unknown time');
  assert.equal(M.describeAge(0), 'just now');
  assert.equal(M.describeAge(1), '1 minute ago');
  assert.equal(M.describeAge(45), '45 minutes ago');
  assert.equal(M.describeAge(90), '2 hours ago');
  assert.equal(M.describeAge(60 * 26), '26 hours ago');
  assert.equal(M.describeAge(60 * 72), '3 days ago');
});

test('ageInMinutes is measured from a fixed now', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  assert.equal(M.ageInMinutes('2026-09-08T11:30:00Z', now), 30);
  assert.equal(M.ageInMinutes(null, now), null);
  assert.equal(M.ageInMinutes('not a date', now), null);
  assert.equal(M.ageInMinutes('2026-09-08T12:30:00Z', now), 0, 'a future stamp never goes negative');
});

test('the stale threshold survives a late run but not a skipped one', () => {
  assert.equal(M.STALE_AFTER_MINUTES, 720);
  const cadence = 8 * 60;                       // three runs a day
  assert.ok(M.STALE_AFTER_MINUTES > cadence, 'an on-time run is never stale');
  assert.ok(M.STALE_AFTER_MINUTES < 2 * cadence, 'a fully skipped run is always stale');
});

test('american odds survive conversion to probability and back', () => {
  for (const p of [-450, -110, 100, 250, 340]) {
    assert.equal(M.probabilityToAmerican(M.impliedProbability(p)), p);
  }
  assert.ok(Math.abs(M.impliedProbability(-450) - 0.81818) < 1e-4);
  assert.ok(Math.abs(M.impliedProbability(340) - 0.22727) < 1e-4);
  assert.equal(M.probabilityToAmerican(0.5), 100, 'even money is written +100');
});

test('movement says nothing from a single run', () => {
  /* The regression this exists for: every book in one ingest shares an
     observed_at, so treating rows as chronology reported the spread BETWEEN
     books as a line move. One look is a snapshot, not a history. */
  const one = {
    fighterId: 'f', consensus: -432, best: -420, worst: -450, bookCount: 8, books: [],
    runCount: 1,
    firstObserved: { price: -432, at: '2026-09-08T12:25:03Z' },
    previous: null,
    latest: { price: -432, at: '2026-09-08T12:25:03Z' },
  };
  assert.equal(M.movement(one, 'first'), null);
});

test('movement compares consensus across runs, in the right direction', () => {
  const two = {
    fighterId: 'f', consensus: -450, best: -450, worst: -450, bookCount: 8, books: [],
    runCount: 2,
    firstObserved: { price: -400, at: '2026-09-08T04:00:00Z' },
    previous: { price: -400, at: '2026-09-08T04:00:00Z' },
    latest: { price: -450, at: '2026-09-08T12:00:00Z' },
  };
  const m = M.movement(two, 'first');
  assert.equal(m.direction, 'toward', 'a shortening price is movement toward the fighter');
  assert.equal(m.from, -400);
  assert.equal(m.to, -450);

  assert.equal(M.movement({ ...two, latest: { price: -300, at: 'x' } }, 'first').direction, 'away');
  assert.equal(M.movement({ ...two, latest: { price: -400, at: 'x' } }, 'first').direction, 'unchanged');
});

test('every state has copy, and none of it implies a model', () => {
  for (const s of ['available', 'partial', 'not_posted', 'unavailable', 'not_configured']) {
    const c = M.MARKET_STATE_COPY[s];
    assert.ok(c?.label && c?.body, `${s} has copy`);
  }
  /* The product has no prediction model, so no market surface may read as
     one, and no wording may claim to know who is betting. */
  const all = Object.values(M.MARKET_STATE_COPY).map((c) => `${c.label} ${c.body}`).join(' ')
    + M.CONSENSUS_NOTE + M.FIRST_OBSERVED_NOTE;
  for (const banned of ['edge', 'value bet', 'sharp', 'steam', 'lock', 'prediction']) {
    assert.ok(!all.toLowerCase().includes(banned), `market copy must not say "${banned}"`);
  }
});
