import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBout, REASONS, RULES, confidenceLabel } from './eligibility.mjs';

const NOW = '2026-09-15T12:00:00Z';
const event = { name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19' };
const corner = (over = {}) => ({ fighter_exists: true, open_alias_review: false, record_reconciles: true, stale: false, ...over });
const base = (over = {}) => ({
  event, nowIso: NOW, modelLive: true, pickProbability: 0.64,
  bout: { status: 'announced', has_result: false, fighter_a_id: 'a', fighter_b_id: 'b', active_card_change: false },
  corners: [corner(), corner()],
  row: { min_prior_bouts: 6, min_stat_bouts: 6, available_count: 32 },
  marketDisagreementPts: null, regenerationDriftPts: null,
  ...over,
});

test('a clean scheduled UFC bout is ELIGIBLE with a confidence label and no reasons', () => {
  const r = evaluateBout(base());
  assert.deepEqual([r.decision, r.reasons, r.confidence], ['ELIGIBLE', [], 'MEDIUM']);
});

const cases = [
  ['EVENT_OUT_OF_SCOPE', { event: { name: "Dana White's Contender Series: Season 10, Week 6", event_date: '2026-09-19' } }],
  ['EVENT_OUT_OF_SCOPE', { event: { name: 'PFL 9', event_date: '2026-09-19' } }],
  ['BOUT_NOT_SCHEDULED', { bout: { status: 'cancelled', has_result: false, fighter_a_id: 'a', fighter_b_id: 'b' } }],
  ['BOUT_NOT_SCHEDULED', { bout: { status: 'announced', has_result: true, fighter_a_id: 'a', fighter_b_id: 'b' } }],
  ['BOUT_NOT_SCHEDULED', { bout: { status: 'announced', has_result: false, fighter_a_id: 'a', fighter_b_id: 'b', active_card_change: true } }],
  ['IDENTITY_UNRESOLVED', { corners: [corner({ open_alias_review: true }), corner()] }],
  ['IDENTITY_UNRESOLVED', { corners: [corner(), corner({ record_reconciles: false })] }],
  ['IDENTITY_UNRESOLVED', { corners: [corner({ fighter_exists: false }), corner()] }],
  ['IDENTITY_UNRESOLVED', { bout: { status: 'announced', has_result: false, fighter_a_id: 'a', fighter_b_id: 'a' } }],
  ['MODEL_VERSION_UNAVAILABLE', { modelLive: false }],
  ['FEATURES_NOT_ASSEMBLED', { row: null, pickProbability: null }],
  ['STALE_FIGHTER_DATA', { corners: [corner({ stale: true }), corner()] }],
  ['DEBUT_CORNER', { row: { min_prior_bouts: 0, min_stat_bouts: 0, available_count: 25 } }],
  ['INSUFFICIENT_FEATURES', { row: { min_prior_bouts: 3, min_stat_bouts: 3, available_count: 19 } }],
  ['LOW_CONFIDENCE', { pickProbability: 0.5499 }],
  ['LOCK_WINDOW_CLOSED', { nowIso: '2026-09-18T18:00:00Z' }],
];
for (const [code, over] of cases) {
  test(`NO MODEL CALL: ${code}`, () => {
    const r = evaluateBout(base(over));
    assert.equal(r.decision, 'NO_MODEL_CALL');
    assert.ok(r.reasons.includes(code), `${code} missing from ${r.reasons}`);
    assert.equal(r.confidence, null, 'an ineligible bout carries no confidence');
    assert.equal(r.elite_candidate, false);
    assert.equal(r.reason_text[r.reasons.indexOf(code)], REASONS[code]);
  });
}

test('boundaries are inclusive exactly where the evidence says', () => {
  assert.equal(evaluateBout(base({ pickProbability: 0.55 })).decision, 'ELIGIBLE');
  assert.equal(evaluateBout(base({ row: { min_prior_bouts: 1, min_stat_bouts: 1, available_count: 20 } })).decision, 'ELIGIBLE');
  assert.equal(evaluateBout(base({ nowIso: '2026-09-18T17:59:59Z' })).decision, 'ELIGIBLE');
});

test('every failing rule is reported, in precedence order', () => {
  const r = evaluateBout(base({ event: { name: 'Contender Series', event_date: '2026-09-19' }, row: { min_prior_bouts: 0, min_stat_bouts: 0, available_count: 2 }, pickProbability: 0.51 }));
  assert.deepEqual(r.reasons, ['EVENT_OUT_OF_SCOPE', 'DEBUT_CORNER', 'INSUFFICIENT_FEATURES', 'LOW_CONFIDENCE']);
});

test('HIGH needs probability AND sample AND completeness; small samples cap at MEDIUM', () => {
  assert.equal(confidenceLabel(0.896, { min_prior_bouts: 1, available_count: 27 }), 'MEDIUM');
  assert.equal(confidenceLabel(0.73, { min_prior_bouts: 3, available_count: 32 }), 'HIGH');
  assert.equal(confidenceLabel(0.73, { min_prior_bouts: 3, available_count: 30 }), 'MEDIUM');
  assert.equal(confidenceLabel(0.58, { min_prior_bouts: 9, available_count: 33 }), 'LEAN');
});

test('elite candidate requires stability evidence and no extreme market disagreement; never on no-call', () => {
  const strong = { row: { min_prior_bouts: 6, min_stat_bouts: 6, available_count: 32 }, pickProbability: 0.78 };
  assert.equal(evaluateBout(base(strong)).elite_candidate, false, 'no regeneration history yet');
  assert.equal(evaluateBout(base({ ...strong, regenerationDriftPts: 0.4 })).elite_candidate, true);
  assert.equal(evaluateBout(base({ ...strong, regenerationDriftPts: 0.4, marketDisagreementPts: 22 })).elite_candidate, false);
  assert.equal(evaluateBout(base({ ...strong, regenerationDriftPts: 0.4, modelLive: false })).elite_candidate, false);
  assert.equal(RULES.eliteCandidate.minPickProbability, 0.75);
});
