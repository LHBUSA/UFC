import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScheduledRounds as r, scheduledRounds } from './normalizers.mjs';

test('normal three-round bout: description and periods agree', () => {
  assert.deepEqual([r({ periods: 3, description: '3 Rnd (5-5-5)' }).rounds, r({ periods: 3, description: '3 Rnd (5-5-5)' }).basis], [3, 'description']);
  assert.equal(r({ periods: 3 }).rounds, 3, 'periods alone, a valid UFC length');
});

test('non-title five-round main event: five from the structured record, never assumed', () => {
  assert.equal(r({ periods: 5, description: '5 Rnd (5-5-5-5-5)' }).rounds, 5);
  assert.equal(r({ periods: 5 }).rounds, 5);
  const unknownMain = r({ periods: 0, description: '' });
  assert.equal(unknownMain.rounds, null, 'a main event with no round data is unresolved, not five');
});

test('title bout: five rounds; a title bout with no usable count resolves to five by rule; a three-round title record is a conflict', () => {
  assert.equal(r({ periods: 5, description: '5 Rnd (5-5-5-5-5)', isTitle: true }).rounds, 5);
  assert.deepEqual([r({ periods: 0, isTitle: true }).rounds, r({ periods: 0, isTitle: true }).basis], [5, 'title_bout_rule']);
  assert.equal(r({ periods: 3, isTitle: true }).state, 'conflict');
});

test('invalid 0 (Allen vs Duncan card, 2026-09-24): unresolved, never 3', () => {
  const x = r({ periods: 0, description: '' });
  assert.deepEqual([x.rounds, x.state, x.basis], [null, 'unresolved', 'invalid_periods_0']);
});

test('invalid 4 (UFC Vegas 121, "3 Rnd + OT (5-5-5-5)"): three regulation rounds plus overtime, per the historical convention', () => {
  const x = r({ periods: 4, description: '3 Rnd + OT (5-5-5-5)' });
  assert.deepEqual([x.rounds, x.overtime, x.state, x.basis], [3, 1, 'resolved', 'description_regulation_plus_overtime']);
  const bare = r({ periods: 4 });
  assert.deepEqual([bare.rounds, bare.state], [null, 'unresolved'], 'a bare 4 is never read as 3');
  assert.equal(r({ periods: 3, description: '1 Rnd + 2OT (15-3-3)' }).rounds, 1, 'historical multi-OT format keeps its regulation count');
});

test('conflicting sources: description and periods disagree -> conflict, rounds null', () => {
  const x = r({ periods: 5, description: '3 Rnd (5-5-5)' });
  assert.deepEqual([x.rounds, x.state, x.basis], [null, 'conflict', 'description_vs_periods']);
});

test('the historical parser is unchanged', () => {
  assert.equal(scheduledRounds('3 Rnd + OT (5-5-5-5)'), 3);
  assert.equal(scheduledRounds('5 Rnd (5-5-5-5-5)'), 5);
});
