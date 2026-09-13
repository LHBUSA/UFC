/* The provider write path and the durable spending gates.
 * Run: node src/capture.test.mjs
 *
 * Two things are proven here that nothing else can prove:
 *
 *   1. An UNCHANGED market still produces a snapshot. The change-history table
 *      deduplicates it away by design, so without the snapshot layer "we
 *      observed this right after round 2" would be unprovable.
 *   2. Every spending control survives a fresh isolate, because Cloudflare may
 *      discard the one that made the last call.
 */
import { normalizePayload, snapshotRows, observationRows } from './capture.mjs';
import { shouldPoll, readConfig } from './gate.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

const A = { id: 'fa', name: 'Joshua Van' };
const B = { id: 'fb', name: 'Alexandre Pantoja' };
const BOUT = { id: 'bout-1', a: A, b: B, eventDate: '2026-09-19' };
const FIGHTERS = [A, B];

const payload = (priceA, priceB, lastUpdate = '2026-09-19T22:00:00Z') => ([{
  id: 'src-1', sport_key: 'mma_mixed_martial_arts',
  commence_time: '2026-09-19T22:00:00Z', home_team: 'Joshua Van', away_team: 'Alexandre Pantoja',
  bookmakers: [{
    key: 'draftkings', title: 'DraftKings', last_update: lastUpdate,
    markets: [{ key: 'h2h', last_update: lastUpdate, outcomes: [
      { name: 'Joshua Van', price: priceA }, { name: 'Alexandre Pantoja', price: priceB },
    ] }],
  }],
}]);

/* ---- one fetch, one timestamp ------------------------------------------ */
{
  const at = '2026-09-19T23:05:23.000Z';
  const n = normalizePayload({ payload: payload(-150, 130), bouts: [BOUT], fighters: FIGHTERS, aliases: [], observedAt: at, eventId: 'e1' });
  eq(n.quotes.length, 2, 'both corners normalized');
  eq(n.matchedBouts, 1, 'the bout matched');
  eq(n.ambiguous, 0, 'nothing ambiguous');
  eq([...new Set(n.quotes.map((q) => q.observed_at))].length, 1, 'ONE observed_at for the whole fetch');
  eq(n.quotes[0].observed_at, at, 'and it is the one the caller took around the request');
  eq(n.quotes.find((q) => q.outcome_name === 'Joshua Van').outcome_fighter_id, 'fa', 'resolved to the right fighter');
}

/* ---- THE distinction: unchanged market -------------------------------- */
{
  const run1 = normalizePayload({ payload: payload(-150, 130), bouts: [BOUT], fighters: FIGHTERS, aliases: [], observedAt: '2026-09-19T23:05:00Z', eventId: 'e1' });
  const run2 = normalizePayload({ payload: payload(-150, 130), bouts: [BOUT], fighters: FIGHTERS, aliases: [], observedAt: '2026-09-19T23:06:00Z', eventId: 'e1' });

  /* SNAPSHOT: two runs, two sets of rows, distinguished by run_id. */
  const s1 = snapshotRows(run1.quotes, 101);
  const s2 = snapshotRows(run2.quotes, 102);
  eq(s1.length + s2.length, 4, 'an unchanged market still yields a snapshot per run');
  eq(s1[0].run_id !== s2[0].run_id, true, 'and they are separated by run, not by price');
  eq(s1[0].observed_at !== s2[0].observed_at, true, 'with distinct observation times');

  /* CHANGE: identical on every column of the conflict target, so the database
     collapses the second to nothing. Same key = same fact. */
  const key = (r) => [r.bout_id, r.bookmaker_key, r.market_key, r.outcome_name, r.source_last_update, r.price].join('|');
  const o1 = observationRows(run1.quotes).map(key);
  const o2 = observationRows(run2.quotes).map(key);
  eq(JSON.stringify(o1), JSON.stringify(o2), 'an unchanged price is the SAME change-history fact in both runs');

  /* A moved price is new history in both layers. */
  const run3 = normalizePayload({ payload: payload(-180, 155, '2026-09-19T23:07:00Z'), bouts: [BOUT], fighters: FIGHTERS, aliases: [], observedAt: '2026-09-19T23:07:10Z', eventId: 'e1' });
  eq(observationRows(run3.quotes).map(key).some((k) => o1.includes(k)), false, 'a moved price is a new change-history fact');
}

/* ---- ambiguity never attaches ------------------------------------------ */
{
  /* Two corners that normalise identically: the source cannot be telling us
     which one it means, and a coin flip would store a wrong attribution. */
  const twins = { id: 'bout-2', a: { id: 'x', name: 'Jose Aldo' }, b: { id: 'y', name: 'José Aldo' }, eventDate: '2026-09-19' };
  const p = [{ id: 's2', home_team: 'Jose Aldo', away_team: 'José Aldo', commence_time: '2026-09-19T22:00:00Z',
    bookmakers: [{ key: 'dk', markets: [{ key: 'h2h', outcomes: [{ name: 'Jose Aldo', price: -110 }] }] }] }];
  const n = normalizePayload({ payload: p, bouts: [twins], fighters: [twins.a, twins.b], aliases: [], observedAt: 'now', eventId: 'e1' });
  eq(n.quotes.length, 0, 'an ambiguous outcome is never attached to a fighter');
  eq(n.unmatched.length > 0, true, 'it lands in the unmatched zone instead');
}
{
  /* A source event with no canonical bout is kept, not dropped. */
  const p = [{ id: 's3', home_team: 'Nobody One', away_team: 'Nobody Two', commence_time: '2026-09-19T22:00:00Z', bookmakers: [] }];
  const n = normalizePayload({ payload: p, bouts: [BOUT], fighters: FIGHTERS, aliases: [], observedAt: 'now', eventId: 'e1' });
  eq(n.quotes.length, 0, 'no quotes from an unmatched event');
  eq(n.unmatched[0].source_event_id, 's3', 'the source event is preserved for a human to read');
}

/* ---- durable spending controls ----------------------------------------- */
const CFG = readConfig({ LIVE_ODDS_ENABLED: 'true', ODDS_API_KEY: 'k', LIVE_ODDS_MAX_CARD_COST: '400' });
const NOW = Date.parse('2026-09-19T23:30:00Z');
const LIVE = [{ competitionId: '1', status: 'STATUS_IN_PROGRESS_2' }];
const freshQuota = { known: true, remaining: 90000, measuredAt: '2026-09-19T23:25:00Z' };
const base = { now: NOW, cfg: CFG, cardStartsAt: '2026-09-19T22:00:00Z', boutStatuses: LIVE, quota: freshQuota, cardSpend: 0, lastCallAt: null };

eq(shouldPoll(base).poll, true, 'fresh quota, live bout, budget left -> poll');

/* A fresh isolate knows nothing; the values must come from persisted rows. */
eq(shouldPoll({ ...base, cardSpend: null }).reason, 'card_spend_unknown',
  'an unreadable card budget is not an empty one');
eq(shouldPoll({ ...base, cardSpend: 400 }).reason, 'card_budget_exhausted',
  'card spend read from the ledger stops the lane');
eq(shouldPoll({ ...base, cardSpend: 399 }).poll, true, 'one under the cap still polls');

/* lastCallAt comes from the run ledger, so spacing survives a new isolate. */
eq(shouldPoll({ ...base, lastCallAt: '2026-09-19T23:29:30Z' }).reason, 'too_soon',
  'a paid call 30s ago blocks the next, even in a brand-new isolate');
eq(shouldPoll({ ...base, lastCallAt: '2026-09-19T23:28:00Z' }).poll, true, 'two minutes later is a new reading');

/* ---- stale and unknown quota ------------------------------------------- */
eq(shouldPoll({ ...base, quota: { known: true, remaining: 90000, measuredAt: '2026-09-08T12:25:00Z' } }).reason, 'quota_stale',
  'a quota reading from a previous card cannot authorise spending');
eq(shouldPoll({ ...base, quota: { known: true, remaining: 90000, measuredAt: null } }).reason, 'quota_age_unknown',
  'a quota with no measurement time is not fresh, it is unverified');
eq(shouldPoll({ ...base, quota: { known: false, remaining: null } }).reason, 'quota_unknown',
  'unknown quota never authorises spend');
eq(shouldPoll({ ...base, quota: null }).reason, 'quota_unknown', 'absent quota never authorises spend');
eq(shouldPoll({ ...base, quota: { known: true, remaining: 4999, measuredAt: '2026-09-19T23:25:00Z' } }).reason, 'quota_reserve_reached',
  'the reserve still holds against a fresh reading');

console.log(failures === 0 ? 'capture.mjs: OK' : `capture.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
