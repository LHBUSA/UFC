/* The market tape. Run: node scripts/odds/market_tape.test.mjs
 *
 * The claims this makes are timing claims, and a timing claim is the easiest
 * thing in this system to overstate. So the assertions are mostly about what
 * the tape REFUSES to say: no price at a boundary it did not observe, no
 * pre-fight close from a post-start reading, no movement invented between a
 * checkpoint and a gap.
 */
import { buildMarketTape, priceReading, nearestReading, movementPts, MAX_ROUND_BOUNDARY_SECONDS } from './market_tape.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

const A = 'fighter-a';
const B = 'fighter-b';
/* One reading = both corners across some books at one observed_at. */
const reading = (observedAt, priceA, priceB, books = ['dk', 'fd']) =>
  books.flatMap((k) => ([
    { observed_at: observedAt, outcome_fighter_id: A, price: priceA, bookmaker_key: k, bookmaker_name: k, source_last_update: observedAt },
    { observed_at: observedAt, outcome_fighter_id: B, price: priceB, bookmaker_key: k, bookmaker_name: k, source_last_update: observedAt },
  ]));

const T0 = '2026-09-19T22:00:00.000Z';   // early reading
const T1 = '2026-09-19T22:58:00.000Z';   // last before the bell
const BELL = '2026-09-19T23:00:00.000Z'; // first seen in progress
const T2 = '2026-09-19T23:01:30.000Z';   // during round 1
const R1 = '2026-09-19T23:05:00.000Z';   // first seen at end of round 1
const T3 = '2026-09-19T23:05:23.000Z';   // 23s after that
const R1_PLUS = (sec) => new Date(Date.parse(R1) + sec * 1000).toISOString();

const OBS = [...reading(T0, -130, 110), ...reading(T1, -118, 102), ...reading(T2, -150, 130), ...reading(T3, -165, 140)];
const TRANS = [
  { kind: 'in_progress', observedAt: BELL, provenance: 'ESPN status first seen STATUS_IN_PROGRESS_1' },
  { kind: 'round_end', round: 1, observedAt: R1, provenance: 'ESPN status first seen STATUS_END_OF_ROUND period 1' },
];

/* ---- a reading needs both corners -------------------------------------- */
{
  eq(priceReading(reading(T0, -130, 110), A, B) !== null, true, 'both corners price');
  const oneSide = reading(T0, -130, 110).filter((r) => r.outcome_fighter_id === A);
  eq(priceReading(oneSide, A, B), null, 'a one-sided reading is not a price — it invites reading vig as signal');
}

/* ---- pre-fight close is STRICTLY before the bell ------------------------ */
{
  const tape = buildMarketTape({ observations: OBS, fighterAId: A, fighterBId: B, transitions: TRANS });
  const close = tape.checkpoints.find((c) => c.key === 'prefight_close');
  eq(close.unavailable, undefined, 'a close exists here');
  eq(close.observedAt, T1, 'the close is the last reading BEFORE the bout was seen in progress');
  eq(close.secondsFromBoundary, -120, 'and records that it was two minutes early');
  /* The readings at T2/T3 are after the bell and must never become the close. */
  eq(close.observedAt === T2 || close.observedAt === T3, false, 'a post-start price is never the close');
}
{
  /* Polling started only after the bell: there is no close, and none is made. */
  const late = [...reading(T2, -150, 130), ...reading(T3, -165, 140)];
  const tape = buildMarketTape({ observations: late, fighterAId: A, fighterBId: B, transitions: TRANS });
  const close = tape.checkpoints.find((c) => c.key === 'prefight_close');
  eq(close.unavailable, true, 'no pre-bell reading means the close is unavailable');
  eq(close.reason, 'no reading before the bout was seen in progress', 'and says why');
  eq(close.consensus, undefined, 'nothing is filled in for it');
}
{
  /* No observed in-progress transition at all. */
  const tape = buildMarketTape({ observations: OBS, fighterAId: A, fighterBId: B, transitions: [] });
  const close = tape.checkpoints.find((c) => c.key === 'prefight_close');
  eq(close.unavailable, true, 'without an observed start there is no close to define');
  eq(close.reason, 'no observed in-progress transition', 'and it says exactly that');
}

/* ---- round boundaries carry their real delta --------------------------- */
{
  const tape = buildMarketTape({ observations: OBS, fighterAId: A, fighterBId: B, transitions: TRANS });
  const r1 = tape.checkpoints.find((c) => c.key === 'round_1');
  eq(r1.observedAt, T3, 'the first reading at/after the round end is used');
  eq(r1.secondsFromBoundary, 23, 'and the real 23-second gap is recorded, not hidden');
  eq(r1.round, 1, 'the round comes from the observed transition');
  eq(r1.provenance, 'ESPN status first seen STATUS_END_OF_ROUND period 1', 'provenance is carried, not asserted');
  eq(tape.interpolated, false, 'nothing is interpolated, ever');
}
{
  /* Nothing within the window after the horn: unavailable, not borrowed from
     the reading before it. */
  const sparse = [...reading(T0, -130, 110), ...reading(T1, -118, 102)];
  const tape = buildMarketTape({ observations: sparse, fighterAId: A, fighterBId: B, transitions: TRANS, maxSecondsFromBoundary: 600 });
  const r1 = tape.checkpoints.find((c) => c.key === 'round_1');
  eq(r1.unavailable, true, 'no post-round reading means no round checkpoint');
  eq(r1.consensus, undefined, 'and no price is borrowed from before the round');
}
{
  /* A reading far outside the window is not "near" the boundary. */
  const far = [...reading(T0, -130, 110), ...reading('2026-09-19T23:59:00.000Z', -400, 320)];
  const tape = buildMarketTape({ observations: far, fighterAId: A, fighterBId: B, transitions: TRANS, maxSecondsFromBoundary: 600 });
  eq(tape.checkpoints.find((c) => c.key === 'round_1').unavailable, true, '54 minutes later is not a round-end price');
}

/* ---- movement is in probability points --------------------------------- */
{
  const from = priceReading(reading(T1, -118, 102), A, B);
  const to = priceReading(reading(T3, -165, 140), A, B);
  const pts = movementPts(from, to, 'a');
  /* -118 ≈ 54.1%, -165 ≈ 62.3%: roughly +8 points toward A. The point is that
     it is computed on probability, not on the 47-point gap between the raw
     American numbers. */
  eq(pts > 6 && pts < 10, true, `expected a single-digit points move toward A, got ${pts}`);
  eq(movementPts(null, to, 'a'), null, 'no movement without two readings');
  eq(movementPts(from, null, 'a'), null, 'and none against a gap');
}
{
  const tape = buildMarketTape({ observations: OBS, fighterAId: A, fighterBId: B, transitions: TRANS });
  eq(tape.checkpoints[0].movePtsA, null, 'the first checkpoint has nothing to move from');
  const r1 = tape.checkpoints.find((c) => c.key === 'round_1');
  eq(Number.isFinite(r1.movePtsA), true, 'later checkpoints carry a move');
  /* An unavailable checkpoint must not become a movement anchor. */
  const gapped = buildMarketTape({ observations: [...reading(T0, -130, 110)], fighterAId: A, fighterBId: B, transitions: TRANS });
  for (const c of gapped.checkpoints.filter((x) => x.unavailable)) eq(c.movePtsA, null, 'an unavailable checkpoint has no movement');
}

/* ---- books and overround are reported, not smoothed -------------------- */
{
  const r = priceReading(reading(T0, -130, 110, ['dk', 'fd', 'mgm']), A, B);
  eq(r.books, 3, 'book count is the distinct books in the reading');
  eq(r.overround > 1, true, 'the margin is exposed rather than silently removed');
  eq(r.a.best !== null, true, 'best available is carried alongside consensus');
}

/* ---- the 120-second round window --------------------------------------- */
{
  eq(MAX_ROUND_BOUNDARY_SECONDS, 120, 'the default boundary window is two polls, not ten minutes');
  /* 119s after the horn: still this round's market. */
  const t1 = buildMarketTape({ observations: reading(R1_PLUS(119), -170, 145), fighterAId: A, fighterBId: B, transitions: TRANS });
  eq(t1.checkpoints.find((c) => c.key === 'round_1').secondsFromBoundary, 119, 'inside the window it is used');
  /* 121s after: that is the next round forming, not this round closing. */
  const t2 = buildMarketTape({ observations: reading(R1_PLUS(121), -170, 145), fighterAId: A, fighterBId: B, transitions: TRANS });
  eq(t2.checkpoints.find((c) => c.key === 'round_1').unavailable, true,
    'past the window the checkpoint is unavailable rather than mislabelled');
}

console.log(failures === 0 ? 'market_tape.mjs: OK' : `market_tape.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
