/* The exported ESPN lanes are what the operator-run historical backfill calls.
 *
 * Pinned here because the backfill trusts them to refuse exactly what the
 * fight-night pass refuses: a breakdown that does not reproduce its total on
 * both axes, and a card attributed to a slot instead of a named official.
 */
import { espnLanes } from './index.js';
import { Espn } from './espn.mjs';

const { fightTotalsIncoherence, reconcileScorecard, JUDGED_METHODS } = espnLanes;
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures += 1; console.log(`FAIL ${msg}`); } };

const coherent = {
  sig_str_landed: 9, sig_str_att: 18, total_str_landed: 12, total_str_att: 22, td_landed: 2, td_att: 5,
  head_landed: 3, head_att: 6, body_landed: 3, body_att: 6, leg_landed: 3, leg_att: 6,
  distance_landed: 3, distance_att: 6, clinch_landed: 3, clinch_att: 6, ground_landed: 3, ground_att: 6,
};
check(fightTotalsIncoherence(coherent).length === 0, 'coherent row passes');
check(fightTotalsIncoherence({ ...coherent, head_landed: 4 }).some((p) => p.startsWith('target landed')), 'target axis mismatch is caught');
check(fightTotalsIncoherence({ ...coherent, clinch_att: 7 }).some((p) => p.startsWith('position att')), 'position axis mismatch is caught');
check(fightTotalsIncoherence({ ...coherent, sig_str_landed: 13, total_str_landed: 12, head_landed: 7 }).some((p) => p.startsWith('sig landed > total')), 'sig above total is caught');
check(fightTotalsIncoherence({ ...coherent, td_landed: 6 }).length > 0, 'takedowns landed above attempted is caught');
check(JSON.stringify(JUDGED_METHODS) === JSON.stringify(['DEC_U', 'DEC_S', 'DEC_M', 'DRAW']), 'judged methods match web/lib/judgeScoring.ts');

const COMP = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/1/competitions/2';
const oref = (id) => `http://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/1/competitions/2/officials/${id}?lang=en&region=us`;
const espn = new Espn({ minIntervalMs: 0 });
espn.json = async (url) => {
  const cid = /competitors\/(\d+)\/linescores/.exec(url)?.[1];
  const scores = { 10: [29, 28, 30], 20: [28, 29, 27] }[cid];
  return { items: [{ linescores: ['101', '102', '103'].map((o, i) => ({ value: scores[i], official: { $ref: oref(o) } })) }] };
};
const run = { scorecards_reconciled: 0, scorecards_written: 0, scorecard_cards_written: 0, notes: {} };
const named = await reconcileScorecard(espn, run, {
  competitionRef: COMP, competitorIds: ['10', '20'],
  judges: [{ id: '101', name: 'Sal DAmato', order: 1 }, { id: '102', name: 'Judge 2', order: 2 }, { id: '103', name: 'Derek Cleary', order: 3 }],
});
check(named.fields.judge_1 === 'Sal DAmato' && named.fields.judge_2 === 'Derek Cleary' && named.fields.judge_3 === null, 'placeholder judge is dropped, named judges kept in order');
check(named.fields.scorecards?.length === 2 && named.fields.scorecards[0].score === '29-28', 'card pair in competitor order');
check(run.notes.scorecard_rejected_reasons?.placeholder_official === 1, 'placeholder rejection is counted');

const none = await reconcileScorecard(espn, run, { competitionRef: COMP, competitorIds: ['10', '20'], judges: [] });
check(Object.keys(none.fields).length === 0, 'no named official -> no fields written');

if (failures) { console.log(`espnLanes: ${failures} failure(s)`); process.exit(1); }
console.log('espnLanes: OK');
