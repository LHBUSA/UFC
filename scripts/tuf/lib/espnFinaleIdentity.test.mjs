import test from 'node:test';
import assert from 'node:assert/strict';
import { planEspnIdBackfill } from './espnFinaleIdentity.mjs';

const F = (id, name, extra = {}) => ({ id, name, espn_athlete_id: null, ufcstats_id: `u-${id}`, dob: null, ...extra });
const base = () => ({
  expected: [{ id: 'g', name: 'Forrest Griffin' }, { id: 'b', name: 'Stephan Bonnar' }, { id: 's', name: 'Diego Sanchez' }, { id: 'k', name: 'Kenny Florian' }],
  fighters: [F('g', 'Forrest Griffin'), F('b', 'Stephan Bonnar'), F('s', 'Diego Sanchez'), F('k', 'Kenny Florian')],
  bouts: [
    { id: 'b1', fighter_a_id: 'g', fighter_b_id: 'b', winner_id: 'g', round: 3 },
    { id: 'b2', fighter_a_id: 's', fighter_b_id: 'k', winner_id: 's', round: 1 },
  ],
  competitions: [
    { id: 'c1', period: 3, competitors: [{ athlete_id: '2335522', name: 'Forrest Griffin', winner: true, dob: null }, { athlete_id: '2335525', name: 'Stephan Bonnar', winner: false, dob: null }] },
    { id: 'c2', period: 1, competitors: [{ athlete_id: '2335671', name: 'Diego Sanchez', winner: true, dob: null }, { athlete_id: '2335675', name: 'Kenny Florian', winner: false, dob: null }] },
  ],
  espnIdHolders: [],
});

test('every expected fighter maps deterministically through its exact bout', () => {
  const r = planEspnIdBackfill(base());
  assert.equal(r.ok, true);
  assert.equal(r.mapped, 4);
  assert.deepEqual(r.mappings.map((m) => [m.name, m.espn_athlete_id, m.role, m.bout_id]), [
    ['Forrest Griffin', '2335522', 'winner', 'b1'], ['Stephan Bonnar', '2335525', 'loser', 'b1'],
    ['Diego Sanchez', '2335671', 'winner', 'b2'], ['Kenny Florian', '2335675', 'loser', 'b2'],
  ]);
  assert.deepEqual(planEspnIdBackfill(base()), r, 'same inputs, same plan');
});

test('an ESPN id already on a different canonical fighter aborts the whole plan', () => {
  const p = base();
  p.espnIdHolders = [{ id: 'someone-else', espn_athlete_id: '2335522' }];
  const r = planEspnIdBackfill(p);
  assert.equal(r.ok, false);
  assert.equal(r.mapped, 0);
  assert.deepEqual(r.mappings, []);
  assert.ok(r.problems.some((x) => x.kind === 'espn_id_attached_to_another_fighter'));
});

test('a fighter already carrying a different ESPN id aborts', () => {
  const p = base();
  p.fighters[0].espn_athlete_id = '999';
  assert.equal(planEspnIdBackfill(p).ok, false);
});

test('names alone never map: a result that disagrees with the corner roles aborts', () => {
  const p = base();
  p.competitions[0].competitors[0].winner = false;
  p.competitions[0].competitors[1].winner = true;
  const r = planEspnIdBackfill(p);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.kind === 'no_reproducing_competition'));
});

test('a round that disagrees with our result row aborts', () => {
  const p = base();
  p.competitions[1].period = 2;
  assert.equal(planEspnIdBackfill(p).ok, false);
});

test('two competitions reproducing one bout is ambiguity, and aborts', () => {
  const p = base();
  p.competitions.push({ ...p.competitions[0], id: 'c1-dup' });
  const r = planEspnIdBackfill(p);
  assert.equal(r.ok, false);
  assert.ok(r.ambiguous > 0);
});

test('a missing canonical row or bout aborts rather than being skipped', () => {
  const p = base();
  p.bouts = p.bouts.slice(0, 1);
  const r = planEspnIdBackfill(p);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.kind === 'no_bout_on_event'));
  assert.ok(r.problems.some((x) => x.kind === 'count_mismatch'));
});

test('a date of birth disagreement is reported, not fixed and not fatal', () => {
  const p = base();
  p.fighters[2].dob = '1981-12-31';
  p.competitions[1].competitors[0].dob = '1981-12-30';
  const r = planEspnIdBackfill(p);
  assert.equal(r.ok, true);
  assert.equal(r.warnings[0].kind, 'dob_disagreement');
  assert.equal(r.mappings.find((m) => m.name === 'Diego Sanchez').canonical_dob, '1981-12-31');
});
