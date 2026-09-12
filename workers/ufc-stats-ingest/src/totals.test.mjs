/* ESPN fight totals reader.
 *
 * The rules worth protecting are the ones that would produce a plausible
 * WRONG number: a partial 3x3 sum presented as a whole-fight figure, a
 * payload that has stopped being a total being stored as one anyway, and a
 * breakdown that does not add up being written because only one axis was
 * checked.
 */
import { Espn } from './espn.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures += 1; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`);

const COMP = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600060772/competitions/401897736';

function stub(payload) {
  const e = new Espn({ minIntervalMs: 0 });
  e.json = async () => payload;
  return e;
}
const stat = (name, value) => ({ name, value, displayValue: String(value) });

/* A coherent fighter: the 3x3 matrix sums to the significant-strike totals on
 * both axes, which is what the real payload does. */
function coherentStats() {
  const s = [
    stat('knockDowns', 1),
    stat('sigStrikesLanded', 9), stat('sigStrikesAttempted', 18),
    stat('totalStrikesLanded', 12), stat('totalStrikesAttempted', 22),
    stat('takedownsLanded', 2), stat('takedownsAttempted', 5),
    stat('timeInControl', 41), stat('reversals', 1),
    stat('wallclock', 1789263258),
  ];
  /* 3 positions x 3 targets, each 1 landed / 2 attempted => 9 landed / 18 att. */
  for (const p of ['Distance', 'Clinch', 'Ground']) {
    for (const t of ['Head', 'Body', 'Leg']) {
      s.push(stat(`sig${p}${t}StrikesLanded`, 1), stat(`sig${p}${t}StrikesAttempted`, 2));
    }
  }
  return s;
}
const payload = (stats, type = 'total') => ({ splits: { type, name: 'All Splits', categories: [{ name: 'general', stats }] } });

/* ---- the happy path ---------------------------------------------------- */
{
  const t = await stub(payload(coherentStats())).fightTotals(COMP, '3136289');
  eq(t.kd, 1, 'knockdowns read');
  eq([t.sig_str_landed, t.sig_str_att], [9, 18], 'significant strikes read');
  eq([t.total_str_landed, t.total_str_att], [12, 22], 'total strikes read');
  eq([t.td_landed, t.td_att], [2, 5], 'takedowns read');
  eq(t.ctrl_sec, 41, 'control time is stored in SECONDS, not as a display string');
  eq(t.rev, 1, 'reversals read');
  eq([t.head_landed, t.body_landed, t.leg_landed], [3, 3, 3], 'targets sum across the three positions');
  eq([t.distance_landed, t.clinch_landed, t.ground_landed], [3, 3, 3], 'positions sum across the three targets');
  eq(t.head_att, 6, 'attempted sums the same way');
  eq(t.source_updated_at, '2026-09-13T01:34:18.000Z', 'ESPN wallclock becomes the source update time');
  eq(t.espn_athlete_id, '3136289', 'the athlete asked about is reported back for identity checking');
  check(!('sub_att' in t), 'sub_att must NOT be produced: ESPN submissions is not proven equivalent');
}

/* ---- the assumption the whole table rests on --------------------------- */
{
  let threw = null;
  try { await stub(payload(coherentStats(), 'round')).fightTotals(COMP, '1'); } catch (e) { threw = e; }
  check(threw, 'a payload that is no longer splits.type "total" must throw, not be stored as a total');
  check(String(threw?.message || '').includes('total'), 'the assertion says what it expected');
}

/* ---- partial breakdowns are not totals --------------------------------- */
{
  /* One component of the leg row missing: the axis must refuse to sum rather
   * than report a smaller number that looks like a real one. */
  const s = coherentStats().filter((x) => x.name !== 'sigGroundLegStrikesLanded');
  const t = await stub(payload(s)).fightTotals(COMP, '1');
  eq(t.leg_landed, null, 'a target axis with a missing component sums to null, not to a partial total');
  eq(t.ground_landed, null, 'the position axis containing it is null too');
  eq(t.head_landed, 3, 'unaffected axes still sum');
  eq(t.sig_str_landed, 9, 'the headline total is untouched');
}

/* ---- refuses to guess -------------------------------------------------- */
{
  eq(await stub(payload(coherentStats())).fightTotals('https://example.com/nope', '1'), null, 'a ref that is not a competition yields nothing');
  eq(await stub(payload(coherentStats())).fightTotals(COMP, 'abc'), null, 'a non-numeric competitor yields nothing');
  eq(await stub({ splits: { type: 'total', categories: [] } }).fightTotals(COMP, '1'), null, 'an empty category list yields nothing');
  eq(await stub({}).fightTotals(COMP, '1'), null, 'a payload with no splits yields nothing');
}

console.log(failures === 0 ? 'totals.mjs: OK' : `totals.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
