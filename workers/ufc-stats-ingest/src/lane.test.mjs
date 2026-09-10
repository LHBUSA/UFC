/* Run: node workers/ufc-stats-ingest/src/lane.test.mjs
 * The round-stat lane's decisions, with no network and no database. */
import { selectCandidates, validateFight, roundRowsFor, latencySummary, sourceBlocked, isContenderSeries } from './lane.mjs';

let failures = 0;
const check = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } };

const NOW = Date.parse('2026-09-10T15:00:00Z');
const ev = (id, date, name = 'UFC Fight Night: A vs. B', ufcstats_id = 'e0000000000000a1') => ({ id, name, event_date: date, ufcstats_id });
const events = new Map([
  ['recent', ev('recent', '2026-09-05')],
  ['old', ev('old', '2026-05-01')],
  ['dwcs', ev('dwcs', '2026-09-02', "Dana White's Contender Series 2026: Week 5", null)],
  ['future', ev('future', '2026-09-20')],
]);
const bout = (id, event_id, status = 'complete') => ({ id, event_id, status, fighter_a_id: 'fa', fighter_b_id: 'fb', ufcstats_id: null });
const bouts = [
  bout('needs', 'recent'),            // finished, no rows            -> candidate
  bout('has', 'recent'),              // finished, rows present       -> skip
  bout('pending', 'recent'),          // no result yet                -> skip
  bout('history', 'old'),             // outside the forward window   -> skip
  bout('contender', 'dwcs'),          // not discoverable via the list -> skip
  bout('upcoming', 'future'),         // not yet fought               -> skip
  bout('cancel', 'recent', 'cancelled'),
  bout('confirmed', 'old'),
];
const results = new Map([
  ['needs', { has_stats: false }], ['has', { has_stats: true }], ['history', { has_stats: false }],
  ['contender', { has_stats: false }], ['cancel', { has_stats: false }],
]);
const { candidates, skipped } = selectCandidates({ bouts, events, results, withRows: new Set(['has']), now: NOW });
check(candidates.map((c) => c.bout.id).join() === 'needs', `only the finished, unrowed, in-window UFC bout is a candidate: ${candidates.map((c) => c.bout.id)}`);
check(skipped.has_rows === 1 && skipped.no_result === 1 && skipped.contender_series_not_discoverable === 1 && skipped.cancelled === 1, `skip reasons ${JSON.stringify(skipped)}`);

/* A linked-in-advance card must still be picked up once it completes — the
 * failure the old event-driven pass had. */
const linked = selectCandidates({ bouts: [bout('x', 'recent')], events, results: new Map([['x', { has_stats: false }]]), withRows: new Set(), now: NOW });
check(linked.candidates.length === 1 && linked.candidates[0].event.ufcstats_id, 'an event that already carries a ufcstats_id still yields its unrowed bouts');

/* A page that parsed with no stats tables is re-checked for a week, then accepted. */
const conf = (date) => selectCandidates({ bouts: [bout('c', 'e')], events: new Map([['e', ev('e', date)]]),
  results: new Map([['c', { has_stats: false, stats_captured_at: '2026-09-01T00:00:00Z' }]]), withRows: new Set(), now: NOW });
check(conf('2026-09-08').candidates.length === 1, 'no-stats page inside the grace period is re-checked');
check(conf('2026-08-20').candidates.length === 0 && conf('2026-08-20').skipped.source_confirmed_no_stats === 1, 'no-stats page past the grace period is accepted as the source answer');

check(isContenderSeries("Dana White's Contender Series 2025: Week 1") && !isContenderSeries('UFC 320: Ankalaev vs. Pereira 2'), 'contender series detection');

/* validation */
const fA = { id: 'A', ufcstats_id: 'aaaaaaaaaaaaaaaa', name: 'Alpha' };
const fB = { id: 'B', ufcstats_id: 'bbbbbbbbbbbbbbbb', name: 'Bravo' };
const row = (f, round) => ({ fighter_ufcstats_id: f, round, kd: 0, sig_str_landed: 10, sig_str_att: 20 });
const parsed = {
  fighters: [{ ufcstats_id: 'aaaaaaaaaaaaaaaa' }, { ufcstats_id: 'bbbbbbbbbbbbbbbb' }],
  winner_ufcstats_id: 'aaaaaaaaaaaaaaaa', round: 2,
  rounds: [row('aaaaaaaaaaaaaaaa', 1), row('bbbbbbbbbbbbbbbb', 1), row('aaaaaaaaaaaaaaaa', 2), row('bbbbbbbbbbbbbbbb', 2)],
};
check(validateFight({ parsed, fighterA: fA, fighterB: fB, result: { winner_id: 'A', round: 2 } }).length === 0, 'valid fight passes');
check(validateFight({ parsed, fighterA: fA, fighterB: { ...fB, ufcstats_id: 'cccccccccccccccc' }, result: null }).some((p) => p.includes('identity')), 'wrong fighter id is rejected');
check(validateFight({ parsed, fighterA: fA, fighterB: { ...fB, ufcstats_id: null }, result: null }).some((p) => p.includes('not both linked')), 'unlinked fighter is rejected');
check(validateFight({ parsed, fighterA: fA, fighterB: fB, result: { winner_id: 'B', round: 2 } }).some((p) => p.includes('winner')), 'winner disagreement is rejected');
check(validateFight({ parsed: { ...parsed, rounds: parsed.rounds.slice(0, 3) }, fighterA: fA, fighterB: fB, result: null }).some((p) => p.includes('corner')), 'a round with one corner is rejected');
check(validateFight({ parsed: { ...parsed, rounds: parsed.rounds.slice(2) }, fighterA: fA, fighterB: fB, result: null }).some((p) => p.includes('contiguous')), 'rounds must start at 1');
check(validateFight({ parsed: { ...parsed, round: 1 }, fighterA: fA, fighterB: fB, result: null }).some((p) => p.includes('beyond')), 'rows beyond the finish round are rejected');
check(validateFight({ parsed: { ...parsed, winner_ufcstats_id: null }, fighterA: fA, fighterB: fB, result: { winner_id: null, round: 2 } }).length === 0, 'a draw/NC with no winner on either side passes');

const rows = roundRowsFor(parsed, fA, fB, 'bout1', 'http://ufcstats.com/fight-details/x', '2026-09-10T00:00:00Z');
check(rows.length === 4 && rows.every((r) => r.bout_id === 'bout1' && ['A', 'B'].includes(r.fighter_id) && !('fighter_ufcstats_id' in r)), 'rows map to our ids');
check(rows.find((r) => r.fighter_id === 'B' && r.round === 2).sig_str_landed === 10, 'values carried through unchanged');

const lat = latencySummary({ espn_final_first_seen_at: '2026-09-06T03:00:00Z', ufcstats_last_unavailable_at: '2026-09-06T03:15:00Z', ufcstats_first_available_at: '2026-09-06T03:30:00Z', round_rows_captured_at: '2026-09-06T03:30:00Z' });
check(lat.source_available_window_ms === 15 * 60000 && lat.final_to_capture_ms === 30 * 60000, `latency is a window ${JSON.stringify(lat)}`);
check(latencySummary({ round_rows_captured_at: '2026-09-06T03:30:00Z' }).source_available_window_ms === null, 'no bracket, no window claimed');

check(sourceBlocked({ status: 'challenged', at: '2026-09-10T12:00:00Z' }, NOW, 6) === true, 'recent challenge blocks');
check(sourceBlocked({ status: 'challenged', at: '2026-09-10T08:00:00Z' }, NOW, 6) === false, 'old challenge expires');
check(sourceBlocked({ status: 'ok', at: '2026-09-10T14:00:00Z' }, NOW, 6) === false, 'ok never blocks');

console.log('lane.mjs:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
