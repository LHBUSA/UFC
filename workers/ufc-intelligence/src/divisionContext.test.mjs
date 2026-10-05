import test from 'node:test';
import assert from 'node:assert/strict';
import { assignDivisions, buildDivisionContext, divisionKey, METRICS, MIN_COMPLETED_BOUTS } from './divisionContext.js';

const mo = (value, confidence = 'high') => ({ value, unit: 'per_min', confidence });
const AS_OF = '2026-10-05';

test('divisions come from the official ranked list; catchweight, openweight and unranked women divisions are not divisions', () => {
  assert.equal(divisionKey('FEATHERWEIGHT', false), 'M:FEATHERWEIGHT');
  assert.equal(divisionKey('strawweight', true), 'W:STRAWWEIGHT');
  assert.equal(divisionKey('CATCHWEIGHT', false), null);
  assert.equal(divisionKey('OPEN', false), null);
  assert.equal(divisionKey('FEATHERWEIGHT', true), null, "women's featherweight is not a ranked division");
  assert.equal(divisionKey(null, false), null);
});

test('a fighter belongs to the division of their most recent ranked-division bout before as-of', () => {
  const bouts = [
    { id: 'b1', fighter_a_id: 'x', fighter_b_id: 'y', weight_class: 'LIGHTWEIGHT', is_womens: false, event_date: '2025-01-01' },
    { id: 'b2', fighter_a_id: 'x', fighter_b_id: 'z', weight_class: 'WELTERWEIGHT', is_womens: false, event_date: '2026-03-01' },
    { id: 'b3', fighter_a_id: 'x', fighter_b_id: 'q', weight_class: 'CATCHWEIGHT', is_womens: false, event_date: '2026-06-01' },
    { id: 'b4', fighter_a_id: 'x', fighter_b_id: 'r', weight_class: 'MIDDLEWEIGHT', is_womens: false, event_date: AS_OF },
  ];
  const d = assignDivisions(bouts, AS_OF);
  assert.equal(d.get('x'), 'M:WELTERWEIGHT', 'catchweight skipped, the as-of day itself excluded');
  assert.equal(d.get('y'), 'M:LIGHTWEIGHT');
  assert.equal(d.has('q'), false, 'only a catchweight bout: no division');
  assert.equal(d.has('r'), false, 'bout on the as-of date does not count');
});

function snap(id, bouts, metrics) { return { fighter_id: id, sample_completed_bouts: bouts, metrics }; }

test('eligibility: active, enough bouts, known division, numeric medium/high metric', () => {
  const divisions = new Map([['a', 'M:LIGHTWEIGHT'], ['b', 'M:LIGHTWEIGHT'], ['c', 'M:LIGHTWEIGHT'], ['d', 'M:LIGHTWEIGHT'], ['e', 'M:LIGHTWEIGHT']]);
  const doc = buildDivisionContext({
    snapshots: [
      snap('a', 10, { sig_landed_per_min: mo(5) }),
      snap('b', 10, { sig_landed_per_min: mo(6, 'low') }),
      snap('c', MIN_COMPLETED_BOUTS - 1, { sig_landed_per_min: mo(9) }),
      snap('d', 10, { sig_landed_per_min: mo(7) }),
      snap('e', 10, { sig_landed_per_min: { value: null, confidence: 'high' } }),
      snap('f', 10, { sig_landed_per_min: mo(8) }),
    ],
    active: new Set(['a', 'b', 'c', 'e', 'f']),
    divisions, asOf: AS_OF, definitionVersion: 1, generatedAt: 'now',
  });
  assert.deepEqual(doc.fighters.a.ranks.sig_landed_per_min, [1, 1], 'b low-confidence, c thin sample, d inactive, e null, f no division');
  assert.equal(doc.fighters.b, undefined);
  assert.equal(doc.fighters.e, undefined);
  assert.equal(doc.divisions['M:LIGHTWEIGHT'].population, 3, 'a, b, e are the eligible fighters in the division');
  assert.equal(doc.divisions['M:LIGHTWEIGHT'].label, 'Lightweight');
});

test('direction and tie-break: higher is better except strikes absorbed; ties break on fighter id', () => {
  const divisions = new Map([['b', 'W:STRAWWEIGHT'], ['a', 'W:STRAWWEIGHT'], ['c', 'W:STRAWWEIGHT']]);
  const doc = buildDivisionContext({
    snapshots: [
      snap('b', 5, { sig_landed_per_min: mo(4), sig_absorbed_per_min: mo(2) }),
      snap('a', 5, { sig_landed_per_min: mo(4), sig_absorbed_per_min: mo(5) }),
      snap('c', 5, { sig_landed_per_min: mo(6), sig_absorbed_per_min: mo(3) }),
    ],
    active: new Set(['a', 'b', 'c']), divisions, asOf: AS_OF, definitionVersion: 1, generatedAt: 'now',
  });
  assert.deepEqual([doc.fighters.c.ranks.sig_landed_per_min, doc.fighters.a.ranks.sig_landed_per_min, doc.fighters.b.ranks.sig_landed_per_min], [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual([doc.fighters.b.ranks.sig_absorbed_per_min, doc.fighters.c.ranks.sig_absorbed_per_min, doc.fighters.a.ranks.sig_absorbed_per_min], [[1, 3], [2, 3], [3, 3]]);
  assert.equal(doc.metrics.sig_absorbed_per_min.better, 'lower');
  assert.equal(doc.metrics.sig_landed_per_min.better, 'higher');
  assert.equal(doc.fighters.a.division, 'W:STRAWWEIGHT');
});

test('ranks are per division, and the document carries no metric values', () => {
  const divisions = new Map([['a', 'M:HEAVYWEIGHT'], ['b', 'M:FLYWEIGHT']]);
  const doc = buildDivisionContext({
    snapshots: [snap('a', 5, { finish_rate: mo(0.987654) }), snap('b', 5, { finish_rate: mo(0.123456) })],
    active: new Set(['a', 'b']), divisions, asOf: AS_OF, definitionVersion: 1, generatedAt: 'now',
  });
  assert.deepEqual(doc.fighters.a.ranks.finish_rate, [1, 1]);
  assert.deepEqual(doc.fighters.b.ranks.finish_rate, [1, 1]);
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('0.987654') && !json.includes('0.123456') && !json.includes('"value"'), 'no values leak into the document');
  assert.deepEqual(Object.keys(doc.metrics), Object.keys(METRICS));
  assert.equal(doc.min_confidence, 'medium');
});
