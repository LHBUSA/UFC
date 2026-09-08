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

/* market.ts reads its connection at module scope, and marketConfigured()
   gates every state decision, so these must be set BEFORE the import or every
   state collapses to not_configured. They are placeholders: nothing in this
   file makes a request, and a real key must never be needed to run tests. */
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key-not-a-real-credential';

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
  for (const s of ['available', 'partial', 'not_posted', 'unresolved', 'unavailable', 'not_configured']) {
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

test('a bout the books are pricing is never called unpriced', () => {
  /* The two sentences are both true of different situations and must not be
     swapped: "nobody has posted a price" blames the books for our own
     unmatched name. */
  const base = { eventDate: '2099-01-01', hasResult: false, providerLive: true };
  assert.equal(M.marketStateFor(undefined, base), 'not_posted');
  assert.equal(M.marketStateFor(undefined, { ...base, unresolved: true }), 'unresolved');

  const posted = M.MARKET_STATE_COPY.not_posted.body.toLowerCase();
  const unres = M.MARKET_STATE_COPY.unresolved.body.toLowerCase();
  assert.ok(posted.includes('no book'), 'not_posted says the books have not posted');
  assert.ok(!unres.includes('no book'), 'unresolved must NOT claim the books posted nothing');
  assert.ok(unres.includes('could not match'), 'unresolved names our failure, not theirs');
});

test('a real price and a finished fight still outrank an unmatched name', () => {
  const base = { eventDate: '2099-01-01', hasResult: false, providerLive: true, unresolved: true };
  const market = { boutId: 'b', state: 'available', marketKey: 'h2h', a: null, b: null,
    lastUpdated: null, sourceLastUpdate: null, stale: false, ageMinutes: 0, bookCount: 2 };
  assert.equal(M.marketStateFor(market, base), 'available', 'having prices wins');
  assert.equal(M.marketStateFor(undefined, { ...base, hasResult: true }), 'unavailable', 'a finished bout has no market');
  assert.equal(M.marketStateFor(undefined, { ...base, providerLive: false }), 'not_configured', 'no feed at all wins');
});

/* ---- run bucketing: the rules that decide what is "current" ------------- */
const obs = (book, price, at, fighter = 'A', last = at) => ({
  bout_id: 'b1', bookmaker_key: book, bookmaker_name: book, market_key: 'h2h',
  outcome_name: fighter, outcome_fighter_id: fighter, price, point: null,
  source_last_update: last, observed_at: at,
});

const RUN1 = '2026-09-08T04:00:00Z';
const RUN2 = '2026-09-08T12:00:00Z';

test('a book that stops pricing stops voting', () => {
  /* Three books in the morning, two by midday. Carrying the absent book
     forward would keep a price nobody is offering inside the consensus and
     inflate the book count with it. */
  const side = M.sideFrom([
    obs('bookA', -200, RUN1), obs('bookB', -210, RUN1), obs('gone', +900, RUN1),
    obs('bookA', -200, RUN2), obs('bookB', -210, RUN2),
  ], 'A');

  assert.equal(side.bookCount, 2, 'only books in the latest run count');
  assert.deepEqual(side.books.map((b) => b.key).sort(), ['bookA', 'bookB']);
  assert.ok(!side.books.some((b) => b.key === 'gone'), 'the departed book is gone from the readout');
  assert.equal(side.worst, -210, 'its +900 no longer stretches the book range');
  assert.equal(side.runCount, 2);
});

test('movement is measured between snapshots, not between books', () => {
  /* Within RUN1 the books disagree by 60 points. That spread is not a move
     and must not appear as one; only the run-to-run consensus shift counts. */
  const side = M.sideFrom([
    obs('bookA', -180, RUN1), obs('bookB', -240, RUN1),
    obs('bookA', -300, RUN2), obs('bookB', -320, RUN2),
  ], 'A');

  assert.equal(side.runCount, 2);
  /* -207, not the -210 midpoint of -180 and -240. Consensus is the median
     IMPLIED PROBABILITY converted back, because American odds jump across the
     +/-100 boundary and averaging them is arithmetically meaningless. The two
     answers differ here by three points, which is exactly the kind of small
     wrongness that would never be noticed in the UI. */
  assert.equal(side.firstObserved.price, -207, 'consensus of run 1, not a single book, not a price average');
  assert.equal(side.latest.price, -310, 'consensus of run 2');

  const m = M.movement(side, 'first');
  assert.equal(m.direction, 'toward', 'the price shortened across the two snapshots');
  assert.equal(m.from, -207);
  assert.equal(m.to, -310);
});

test('a single snapshot yields one run and no movement, however many books', () => {
  const side = M.sideFrom([
    obs('bookA', -430, RUN1), obs('bookB', -450, RUN1), obs('bookC', -420, RUN1),
  ], 'A');
  assert.equal(side.runCount, 1);
  assert.equal(side.bookCount, 3);
  assert.equal(M.movement(side, 'first'), null, 'book disagreement is not chronology');
});

test('an unchanged reprice is not a move', () => {
  const side = M.sideFrom([
    obs('bookA', -200, RUN1), obs('bookA', -200, RUN2),
  ], 'A');
  assert.equal(side.runCount, 2);
  assert.equal(M.movement(side, 'first').direction, 'unchanged');
  assert.equal(side.previous, null, 'no earlier DIFFERENT price exists');
});

/* ---- idempotency and staleness, without touching a database ------------- */
const ING = await import('../../scripts/odds/ingest_market.mjs');

test('the conflict target matches the unique constraint exactly', () => {
  /* ufc_market_obs_unique, from supabase/migrations/20260907000009_ufc_market.sql.
     PostgREST infers ON CONFLICT from the PRIMARY KEY unless a target is
     named, and the PK here is a bigserial that never collides — so if these
     two ever drift, the second ingest of any day fails wholesale with 23505.
     That is exactly what happened before this was pinned. */
  assert.deepEqual(ING.OBS_CONFLICT_COLUMNS, [
    'bout_id', 'bookmaker_key', 'market_key', 'outcome_name', 'source_last_update', 'price',
  ]);
  assert.equal(ING.OBS_CONFLICT, 'bout_id,bookmaker_key,market_key,outcome_name,source_last_update,price');
  /* Checked against the column list, not the joined string: "bout_id" contains
     "id" as a substring, so a naive includes() on the joined form is a test
     that fails on correct code. */
  assert.ok(!ING.OBS_CONFLICT_COLUMNS.includes('observed_at'),
    'observed_at must never be in the key: it changes every run and would defeat deduplication');
  assert.ok(!ING.OBS_CONFLICT_COLUMNS.includes('id'), 'the surrogate key is not the identity');
});

test('replaying the same snapshot collides on every row', () => {
  const row = {
    bout_id: 'b1', bookmaker_key: 'fanduel', market_key: 'h2h', outcome_name: 'Jean Silva',
    source_last_update: '2026-09-08T12:22:41Z', price: -440,
    observed_at: '2026-09-08T12:25:03Z', bookmaker_name: 'FanDuel',
  };
  /* Same fact re-read: identical key, so the database rejects it as a duplicate. */
  const replay = { ...row, observed_at: '2026-09-08T20:00:00Z', bookmaker_name: 'FanDuel Sportsbook' };
  assert.equal(ING.observationKey(replay), ING.observationKey(row),
    'a later look at an unchanged price is the same observation');

  /* A moved price is new history and must NOT collide. */
  assert.notEqual(ING.observationKey({ ...row, price: -450 }), ING.observationKey(row));
  /* So is the same price newly stamped by the book. */
  assert.notEqual(ING.observationKey({ ...row, source_last_update: '2026-09-08T18:00:00Z' }), ING.observationKey(row));
});

test('a stale snapshot stays visibly stale, and keeps its prices', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const at = (mins) => new Date(now - mins * 60000).toISOString();

  assert.equal(M.isStale(at(0), now), false, 'a fresh read is current');
  assert.equal(M.isStale(at(8 * 60), now), false, 'an on-time run at the 8h cadence is current');
  assert.equal(M.isStale(at(M.STALE_AFTER_MINUTES), now), false, 'exactly at the threshold is not yet stale');
  assert.equal(M.isStale(at(M.STALE_AFTER_MINUTES + 1), now), true, 'one minute past it is');
  assert.equal(M.isStale(at(48 * 60), now), true, 'two days old is plainly stale');
  assert.equal(M.isStale(null, now), false, 'no timestamp is not a staleness claim');

  /* Staleness is a caveat on real prices, never a reason to hide them: the
     state stays available/partial so the numbers still render. */
  assert.equal(M.marketStateFor(
    { boutId: 'b', state: 'available', marketKey: 'h2h', a: null, b: null,
      lastUpdated: at(48 * 60), sourceLastUpdate: null, stale: true, ageMinutes: 2880, bookCount: 8 },
    { eventDate: '2099-01-01', hasResult: false, providerLive: true },
  ), 'available');
  assert.equal(M.describeAge(2880), '2 days ago');
});

/* ---- provider readiness must never be a stale "no" ---------------------- */

/** Capture what market.ts asks the network for, and answer it. */
function stubFetch(countHeader, ok = true) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      headers: { get: (h) => (h.toLowerCase() === 'content-range' ? countHeader : null) },
      json: async () => [],
    };
  };
  return calls;
}

test('provider readiness cannot get stuck on a stale "not configured"', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });

  /* The production failure this pins: 352 observations in the table and the
     site still saying "Market data not configured" because a cached false
     from before the first ingest was still being served. The one moment this
     answer ever changes is the one moment a cache is guaranteed wrong. */
  const withRows = stubFetch('0-0/352');
  assert.equal(await M.marketProviderLive(), true, 'observations exist, so the provider is live');

  const req = withRows[0].init;
  assert.equal(req.cache, 'no-store', 'readiness must be uncached');
  assert.ok(!req.next?.revalidate, 'readiness must carry no revalidate window at all');

  /* Uncached means uncached: a second call re-asks rather than replaying. */
  await M.marketProviderLive();
  assert.equal(withRows.length, 2, 'every call reaches the database');

  /* And it still reports honestly when the table really is empty. */
  const empty = stubFetch('*/0');
  assert.equal(await M.marketProviderLive(), false, 'an empty table is genuinely not configured');
  assert.equal(empty[0].init.cache, 'no-store');

  /* A failed read is not evidence of a live provider. */
  stubFetch('0-0/352', false);
  assert.equal(await M.marketProviderLive(), false, 'a non-ok response must not read as live');
});

test('readiness, observation freshness and staleness stay three separate knobs', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });

  const calls = stubFetch('0-0/1');
  await M.marketProviderLive();
  await M.getMarketsFor(['bout-1'], new Map([['bout-1', { a: 'A', b: 'B' }]]));

  const readiness = calls.find((c) => c.url.includes('limit=1'));
  const observations = calls.find((c) => c.url.includes('market_key=eq.h2h'));

  assert.equal(readiness.init.cache, 'no-store', 'readiness: uncached');
  assert.equal(observations.init.next.revalidate, 60, 'observations: one minute');
  assert.equal(M.STALE_AFTER_MINUTES, 720, 'staleness: twelve hours, and not a cache setting');
  assert.notEqual(M.STALE_AFTER_MINUTES, observations.init.next.revalidate / 60);
});
