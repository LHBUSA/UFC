import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWikipediaCareer, resultForCareerRow, shouldPromoteCareerRow, scoreTarget } from './logic.js';

const target = { id: 'a', dob: '1990-07-02' };
const fighterNames = new Map([['b', 'Holly Holm'], ['c', 'Ketlen Vieira']]);
const canonical = [
  { fighter_a_id: 'a', fighter_b_id: 'b', event_date: '2024-04-13' },
  { fighter_a_id: 'a', fighter_b_id: 'c', event_date: '2024-10-05' },
];

function page(rows, dob = '1990-07-02') { return { record: { dob, rows } }; }

test('two exact UFC overlaps verify an ordinary career page', () => {
  const proof = verifyWikipediaCareer({
    target,
    page: page([
      { promotion_slug: 'ufc', event_date: '2024-04-13', opponent: 'Holly Holm' },
      { promotion_slug: 'ufc', event_date: '2024-10-05', opponent: 'Ketlen Vieira' },
      { promotion_slug: 'pfl', event_date: '2023-11-24', opponent: 'Aspen Ladd' },
    ]),
    canonicalBouts: canonical,
    fighterNames,
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.exact_ufc_matches, 2);
});

test('DOB conflict or unexplained UFC row fails closed', () => {
  assert.equal(verifyWikipediaCareer({
    target,
    page: page([
      { promotion_slug: 'ufc', event_date: '2024-04-13', opponent: 'Holly Holm' },
      { promotion_slug: 'ufc', event_date: '2024-10-05', opponent: 'Ketlen Vieira' },
    ], '1991-07-02'),
    canonicalBouts: canonical,
    fighterNames,
  }).verified, false);

  assert.equal(verifyWikipediaCareer({
    target,
    page: page([
      { promotion_slug: 'ufc', event_date: '2024-04-13', opponent: 'Holly Holm' },
      { promotion_slug: 'ufc', event_date: '2025-01-01', opponent: 'Wrong Person' },
    ]),
    canonicalBouts: canonical,
    fighterNames,
  }).verified, false);
});

test('one-UFC-bout fighter requires DOB plus exact bout', () => {
  const one = [canonical[0]];
  assert.equal(verifyWikipediaCareer({
    target,
    page: page([{ promotion_slug: 'ufc', event_date: '2024-04-13', opponent: 'Holly Holm' }]),
    canonicalBouts: one,
    fighterNames,
  }).verified, true);
  assert.equal(verifyWikipediaCareer({
    target: { id: 'a', dob: null },
    page: page([{ promotion_slug: 'ufc', event_date: '2024-04-13', opponent: 'Holly Holm' }], null),
    canonicalBouts: one,
    fighterNames,
  }).verified, false);
});

test('only recognized, dated, linked non-UFC rows promote', () => {
  assert.equal(shouldPromoteCareerRow({ promotion_slug: 'pfl', promotion_recognized: true, event_date: '2023-01-01', opponent_wiki_title: 'Someone' }), true);
  assert.equal(shouldPromoteCareerRow({ promotion_slug: 'ufc', promotion_recognized: true, event_date: '2023-01-01', opponent_wiki_title: 'Someone' }), false);
  assert.equal(shouldPromoteCareerRow({ promotion_slug: 'regional-x', promotion_recognized: false, event_date: '2023-01-01', opponent_wiki_title: 'Someone' }), false);
  assert.equal(shouldPromoteCareerRow({ promotion_slug: 'pfl', promotion_recognized: true, event_date: null, opponent_wiki_title: 'Someone' }), false);
});

test('result winner is deterministic from the verified page row', () => {
  assert.deepEqual(resultForCareerRow({ result: 'win' }, 'a', 'b'), { outcome: 'win', winner_id: 'a' });
  assert.deepEqual(resultForCareerRow({ result: 'loss' }, 'a', 'b'), { outcome: 'win', winner_id: 'b' });
  assert.deepEqual(resultForCareerRow({ result: 'draw' }, 'a', 'b'), { outcome: 'draw', winner_id: null });
});

test('target scoring prioritizes champions and near-term cards', () => {
  assert.ok(scoreTarget({ champion: true, nextCardIndex: 0, active: true, externalAppearances: 0 }) >
    scoreTarget({ ranked: true, active: true, externalAppearances: 0 }));
});
