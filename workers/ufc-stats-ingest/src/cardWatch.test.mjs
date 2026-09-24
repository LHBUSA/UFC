import test from 'node:test';
import assert from 'node:assert/strict';
import { cardWatchDue, cardWatchDates, cardContradictions, contradictionAlertDecision, CARD_WATCH } from './cardWatch.mjs';

const NOW = Date.parse('2026-09-24T23:40:00Z');
const GALL = 'acd598cc', DUMAS = '1e6f20a1', HERNANDEZ = '4f914614';
const bout = { id: 'b-gall-dumas', event_id: 'vegas121', fighter_a_id: GALL, fighter_b_id: DUMAS };
const other = { id: 'b-other', event_id: 'vegas121', fighter_a_id: 'x1', fighter_b_id: 'x2' };
const item = { id: 'a54730a2', title: 'Sedriques Dumas gets new opponent at UFC Vegas 121', story_kind: 'replacement', primary_fighter_id: DUMAS, secondary_fighter_ids: [], fighter_ids: [DUMAS, GALL, HERNANDEZ], entity_confidence: 0.95, detected_at: '2026-09-24T22:02:00Z' };
const STALE_OBS = { vegas121: '2026-09-24T06:01:47Z' };

test('watch cadence: twice an hour at :05 and :35; one ESPN range covering today..+7 days', () => {
  assert.equal(cardWatchDue(Date.parse('2026-09-24T23:05:00Z')), true);
  assert.equal(cardWatchDue(Date.parse('2026-09-24T23:35:00Z')), true);
  assert.equal(cardWatchDue(Date.parse('2026-09-24T23:06:00Z')), false);
  assert.deepEqual(cardWatchDates(NOW), ['20260924-20261001']);
});

test('the 2026-09-24 incident: replacement reported, card last read at 06:01Z, bout still active -> stale_card, and only that bout', () => {
  const found = cardContradictions({ now: NOW, items: [item], bouts: [bout, other], lastObserved: STALE_OBS });
  assert.equal(found.length, 1);
  assert.equal(found[0].state, 'stale_card');
  assert.equal(found[0].bout_id, 'b-gall-dumas');
  assert.deepEqual([...found[0].named_fighters].sort(), [GALL, DUMAS].sort());
});

test('inside the reconciliation window it is awaiting_observation, not an alert', () => {
  const found = cardContradictions({ now: Date.parse(item.detected_at) + 10 * 60000, items: [item], bouts: [bout], lastObserved: STALE_OBS });
  assert.equal(found[0].state, 'awaiting_observation');
  assert.equal(contradictionAlertDecision({ found, previous: null, now: NOW }).send, false);
});

test('withdrawal reported but the official card, re-read AFTER the report, still lists the bout -> reported_unconfirmed (no removal, no alert)', () => {
  const w = { ...item, story_kind: 'withdrawal' };
  const found = cardContradictions({ now: NOW, items: [w], bouts: [bout], lastObserved: { vegas121: '2026-09-24T22:35:00Z' } });
  assert.equal(found[0].state, 'reported_unconfirmed');
  assert.equal(contradictionAlertDecision({ found, previous: null, now: NOW }).send, false);
});

test('confirmed removal without a known replacement: once the bout leaves the effective card there is nothing to contradict', () => {
  assert.deepEqual(cardContradictions({ now: NOW, items: [item], bouts: [other], lastObserved: { vegas121: '2026-09-24T23:05:00Z' } }), []);
});

test('duplicate reports collapse to one entry per bout; the oldest unreconciled report starts the clock', () => {
  const older = { ...item, id: '376cafab', detected_at: '2026-09-24T19:38:00Z', entity_confidence: 0.75, primary_fighter_id: HERNANDEZ, fighter_ids: [GALL, HERNANDEZ] };
  // 23:00Z: the newest report (22:02) is inside the window, the older one (19:38) is not. A newer duplicate must not reset the clock.
  const found = cardContradictions({ now: Date.parse('2026-09-24T23:00:00Z'), items: [item, older], bouts: [bout], lastObserved: STALE_OBS });
  assert.equal(found.length, 1);
  assert.equal(found[0].state, 'stale_card');
  assert.equal(found[0].news_item_id, '376cafab');
  assert.equal(found[0].reports, 2);
  // A re-read between the two reports reconciles the older one; the newer one then runs its own window.
  const mid = cardContradictions({ now: Date.parse('2026-09-24T23:00:00Z'), items: [item, older], bouts: [bout], lastObserved: { vegas121: '2026-09-24T20:05:00Z' } });
  assert.equal(mid[0].state, 'awaiting_observation');
  assert.equal(mid[0].news_item_id, 'a54730a2');
});

test('structured links only: low-confidence entity links, other story kinds and old items are ignored', () => {
  assert.equal(cardContradictions({ now: NOW, items: [{ ...item, entity_confidence: 0.4 }], bouts: [bout], lastObserved: STALE_OBS }).length, 0);
  assert.equal(cardContradictions({ now: NOW, items: [{ ...item, entity_confidence: null }], bouts: [bout], lastObserved: STALE_OBS }).length, 0);
  assert.equal(cardContradictions({ now: NOW, items: [{ ...item, story_kind: 'interview' }], bouts: [bout], lastObserved: STALE_OBS }).length, 0);
  assert.equal(cardContradictions({ now: NOW, items: [{ ...item, detected_at: '2026-09-10T00:00:00Z' }], bouts: [bout], lastObserved: STALE_OBS }).length, 0);
  assert.ok(CARD_WATCH.minEntityConfidence >= 0.7);
});

test('a fighter rebooked against a different opponent: the fresh observation lists the new bout, nothing is stale', () => {
  const rebooked = { id: 'b-dumas-hernandez', event_id: 'vegas121', fighter_a_id: DUMAS, fighter_b_id: HERNANDEZ };
  const found = cardContradictions({ now: NOW, items: [item], bouts: [rebooked], lastObserved: { vegas121: '2026-09-24T23:05:00Z' } });
  assert.equal(found[0].state, 'reported_unconfirmed');
});

test('stale observation after newer truth: an observation older than the report never counts as a re-read', () => {
  const found = cardContradictions({ now: NOW, items: [item], bouts: [bout], lastObserved: { vegas121: '2026-09-24T22:01:59Z' } });
  assert.equal(found[0].state, 'stale_card');
});

test('alerting: a new stale bout alerts loudly once; unchanged state is quiet; clearing sends one all-clear', () => {
  const found = cardContradictions({ now: NOW, items: [item], bouts: [bout], lastObserved: STALE_OBS });
  const first = contradictionAlertDecision({ found, previous: null, now: NOW });
  assert.equal(first.send, true); assert.equal(first.loud, true);
  assert.equal(contradictionAlertDecision({ found, previous: first.next, now: NOW + 60000 }).send, false);
  const cleared = contradictionAlertDecision({ found: [], previous: first.next, now: NOW + 120000 });
  assert.equal(cleared.send, true); assert.equal(cleared.next.status, 'ok');
});
