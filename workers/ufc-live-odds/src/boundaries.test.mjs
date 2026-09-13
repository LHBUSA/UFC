/* Round-boundary evidence. Run: node src/boundaries.test.mjs
 *
 * Two things must hold at once: we must not LOSE a boundary because a poll
 * missed a short intermission, and we must not INVENT one or claim more
 * precision than ESPN gave us. Most of these assertions are the second kind.
 */
import { boundariesFrom, dedupeBoundaries, activePeriod, describeBoundary } from './boundaries.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

const C = '401905192';
const at = (s) => `2026-09-19T23:${String(s).padStart(2, '0')}:00.000Z`;

/* ---- PATH 1: the direct state ------------------------------------------ */
{
  const b = boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(10) });
  eq(b.length, 1, 'end-of-round status yields one boundary');
  eq(b[0].round, 2, 'the round is the period ESPN reported');
  eq(b[0].boundary_basis, 'espn_end_of_round_status', 'basis records that we saw the state itself');
  eq(b[0].observed_at, at(10), 'observed_at is when WE saw it');
  eq(b[0].previous_period_seen_at, undefined, 'a direct observation needs no uncertainty bracket');
  /* The provenance must not read like a horn time. */
  eq(/first observed/.test(b[0].provenance), true, 'provenance says first observed, not "ended at"');
  eq(/horn|bell|exact/i.test(b[0].provenance), false, 'no claim of exact horn time');
}
{
  /* period 0 is not a round, and the status suffix is not a period. */
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 0 }, previous: null, observedAt: at(10) }).length, 0,
    'period 0 is not a round');
  eq(activePeriod({ period: 0 }), null, 'period 0 is not an active period');
  eq(activePeriod({ period: 6 }), null, 'period 6 is outside any UFC bout');
  eq(activePeriod({}), null, 'absent period is never guessed');
}

/* ---- PATH 2: the period transition ------------------------------------- */
{
  const b = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_IN_PROGRESS_2', period: 2 },
    previous: { period: 1, seenAt: at(4) }, observedAt: at(5),
  });
  eq(b.length, 1, 'period 1 -> 2 evidences round 1 completing');
  eq(b[0].round, 1, 'the round that ENDED is the earlier period');
  eq(b[0].boundary_basis, 'espn_period_transition', 'basis records that it was inferred');
  eq(b[0].observed_at, at(5), 'observed_at is when we first saw the NEW period');
  eq(b[0].previous_period_seen_at, at(4), 'the bracket keeps the last sighting of the old period');
  eq(b[0].next_period_seen_at, at(5), 'and the first sighting of the new one');
  eq(/inferred from first observed ESPN period transition/.test(b[0].provenance), true,
    'provenance states it was inferred from a transition');
  eq(/horn|bell|exact/i.test(b[0].provenance), false, 'and claims no exact time');
}
{
  const b = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_IN_PROGRESS_3', period: 3 },
    previous: { period: 2, seenAt: at(10) }, observedAt: at(11),
  });
  eq(b.length, 1, 'period 2 -> 3 evidences round 2');
  eq(b[0].round, 2, 'round 2 completed');
}
{
  /* A poll that skipped an entire round still yields both boundaries rather
     than losing the one in the middle. */
  const b = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_IN_PROGRESS_3', period: 3 },
    previous: { period: 1, seenAt: at(4) }, observedAt: at(12),
  });
  eq(b.length, 2, 'a 1 -> 3 jump evidences rounds 1 AND 2');
  eq(JSON.stringify(b.map((x) => x.round)), '[1,2]', 'both completed rounds are recorded');
}

/* ---- what must NEVER produce a boundary -------------------------------- */
{
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_IN_PROGRESS_2', period: 2 }, previous: { period: 2, seenAt: at(8) }, observedAt: at(9) }).length, 0,
    'the same period twice is not a round ending');
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_IN_PROGRESS_1', period: 1 }, previous: { period: 3, seenAt: at(8) }, observedAt: at(9) }).length, 0,
    'a period going BACKWARDS is a correction, never a completion');
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_SCHEDULED', period: null }, previous: null, observedAt: at(1) }).length, 0,
    'a scheduled bout evidences nothing');
  eq(boundariesFrom({ status: { competitionId: '', status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(1) }).length, 0,
    'no competition id, no boundary');
}
{
  /* Beyond the bout's scheduled length, where we know it. */
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 4 }, previous: null, observedAt: at(20), scheduledRounds: 3 }).length, 0,
    'round 4 of a three-round bout is refused');
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 4 }, previous: null, observedAt: at(20), scheduledRounds: 5 }).length, 1,
    'round 4 of a five-round bout is fine');
  eq(boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(20) }).length, 1,
    'with no scheduled context we do not refuse a plausible round');
}

/* ---- ONE boundary per round, whichever path saw it first --------------- */
{
  const fallbackFirst = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_IN_PROGRESS_3', period: 3 },
    previous: { period: 2, seenAt: at(10) }, observedAt: at(11),
  });
  const directLater = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(14),
  });
  const merged = dedupeBoundaries(fallbackFirst, directLater);
  eq(merged.length, 1, 'both paths seeing round 2 produce ONE boundary');
  eq(merged[0].observed_at, at(11), 'the FIRST sighting keeps the timestamp — a later one is worse evidence');
  eq(merged[0].boundary_basis, 'espn_end_of_round_status', 'but the basis is enriched to the stronger evidence');
  eq(/direct STATUS_END_OF_ROUND observed later/.test(merged[0].provenance), true,
    'and the provenance records that the upgrade happened afterwards');
}
{
  /* Direct first, fallback later: nothing is downgraded and nothing moves. */
  const directFirst = boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(10) });
  const fallbackLater = boundariesFrom({
    status: { competitionId: C, status: 'STATUS_IN_PROGRESS_3', period: 3 },
    previous: { period: 2, seenAt: at(10) }, observedAt: at(12),
  });
  const merged = dedupeBoundaries(directFirst, fallbackLater);
  eq(merged.length, 1, 'still one boundary');
  eq(merged[0].observed_at, at(10), 'the earlier direct sighting is kept');
  eq(merged[0].boundary_basis, 'espn_end_of_round_status', 'the stronger basis is not downgraded');
}
{
  /* Different rounds are different boundaries. */
  const merged = dedupeBoundaries(
    boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 1 }, previous: null, observedAt: at(5) }),
    boundariesFrom({ status: { competitionId: C, status: 'STATUS_END_OF_ROUND', period: 2 }, previous: null, observedAt: at(11) }),
  );
  eq(merged.length, 2, 'round 1 and round 2 are separate boundaries');
}

/* ---- the UI must not imply equal precision ----------------------------- */
{
  eq(describeBoundary('espn_end_of_round_status', 2), 'round-end state was first seen', 'direct wording');
  eq(describeBoundary('espn_period_transition', 2), 'ESPN advanced to round 3', 'inferred wording names the transition');
  for (const basis of ['espn_end_of_round_status', 'espn_period_transition']) {
    eq(/horn|bell|exactly/i.test(describeBoundary(basis, 2)), false, 'neither wording claims a horn');
  }
}

console.log(failures === 0 ? 'boundaries.mjs: OK' : `boundaries.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
