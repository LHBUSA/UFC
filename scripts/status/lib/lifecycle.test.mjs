/* Status lifecycle. Run: node --test scripts/status/lib/lifecycle.test.mjs
 *
 * Two properties matter more than the rest and both are about NOT saying
 * things: a card-specific claim must stop being current when its card is over,
 * and nothing may ever conclude a fighter recovered because time passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLifecycle, expiries, resolutions, occurredAt, UNAVAILABLE_TYPES, RESOLVING_TYPES } from './lifecycle.mjs';

const TODAY = '2026-09-08';

const row = (over = {}) => ({
  id: 'r1', fighter_id: 'f1', status_type: 'withdrawal', state: 'active',
  event_id: null, bout_id: null, source_kind: 'news',
  effective_at: null, source_published_at: '2026-06-01T00:00:00Z', detected_at: '2026-06-01T00:00:00Z',
  ...over,
});

/* ================= expiry ================= */

test('a withdrawal from a card that has been fought stops being current', () => {
  const rows = [row({ id: 'r1', event_id: 'past', status_type: 'withdrawal' })];
  const out = expiries(rows, new Map([['past', '2026-03-14']]), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'r1');
  assert.match(out[0].reason, /does not outlive its card/);
});

test('a withdrawal from an upcoming card stays current', () => {
  const rows = [row({ event_id: 'future' })];
  assert.deepEqual(expiries(rows, new Map([['future', '2026-11-14']]), TODAY), []);
});

test('an event dated today has not passed', () => {
  /* The boundary belongs to the card: a fighter is off tonight's card all day. */
  const rows = [row({ event_id: 'today' })];
  assert.deepEqual(expiries(rows, new Map([['today', TODAY]]), TODAY), []);
});

test('an unknown event date is not evidence the event happened', () => {
  const rows = [row({ event_id: 'e-undated' })];
  assert.deepEqual(expiries(rows, new Map([['e-undated', null]]), TODAY), [], 'a null date must not expire anything');
  assert.deepEqual(expiries(rows, new Map(), TODAY), [], 'nor must an event we could not look up');
});

/* ================= the rule that must never be broken ================= */

test('an injury with no card NEVER expires by time — at any distance', () => {
  /* The whole point. Nothing in the passage of time tells us a fighter
   * recovered, and a "cleanup" job that expired old injuries would be making a
   * medical claim by omission: the fighter would silently become available on
   * our site with no source saying so. */
  for (const [label, published] of [
    ['a month', '2026-08-01T00:00:00Z'],
    ['a year', '2025-09-08T00:00:00Z'],
    ['five years', '2021-01-01T00:00:00Z'],
  ]) {
    const rows = [row({ status_type: 'injury', event_id: null, source_published_at: published })];
    assert.deepEqual(expiries(rows, new Map(), TODAY), [], `${label} old is still not a recovery`);
  }
});

test('a suspension with no card never expires by time either', () => {
  const rows = [row({ status_type: 'suspension', event_id: null, source_published_at: '2024-01-01T00:00:00Z' })];
  assert.deepEqual(expiries(rows, new Map(), TODAY), [],
    'a ban ends when the body that imposed it says so, not when a job runs');
});

test('only active rows are considered', () => {
  for (const state of ['resolved', 'expired']) {
    const rows = [row({ state, event_id: 'past' })];
    assert.deepEqual(expiries(rows, new Map([['past', '2026-01-01']]), TODAY), []);
  }
});

/* ================= sourced resolution ================= */

test('a clearance resolves the one open injury it can only mean', () => {
  const injury = row({ id: 'inj', status_type: 'injury', source_published_at: '2026-06-01T00:00:00Z' });
  const cleared = row({ id: 'clr', status_type: 'cleared', source_published_at: '2026-09-01T00:00:00Z' });
  const { decided, ambiguous } = resolutions([cleared], [injury]);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].id, 'inj');
  assert.equal(decided[0].resolved_by_event_id, 'clr');
  assert.deepEqual(ambiguous, []);
});

test('a resolver never reaches backwards in time', () => {
  const injury = row({ id: 'inj', status_type: 'injury', source_published_at: '2026-09-01T00:00:00Z' });
  const cleared = row({ id: 'clr', status_type: 'cleared', source_published_at: '2026-06-01T00:00:00Z' });
  assert.deepEqual(resolutions([cleared], [injury]).decided, [],
    'an earlier clearance says nothing about a later injury');
});

test('two open statuses of different kinds are NOT resolved by one vague clearance', () => {
  /* Guessing here either declares a suspended fighter eligible or leaves a
   * healed one injured. Both are claims the source did not make. */
  const injury = row({ id: 'inj', status_type: 'injury', source_published_at: '2026-06-01T00:00:00Z' });
  const visa = row({ id: 'visa', status_type: 'visa_travel', source_published_at: '2026-06-02T00:00:00Z' });
  const cleared = row({ id: 'clr', status_type: 'cleared', source_published_at: '2026-09-01T00:00:00Z' });
  const { decided, ambiguous } = resolutions([cleared], [injury, visa]);
  assert.deepEqual(decided, []);
  assert.equal(ambiguous.length, 1);
  assert.match(ambiguous[0].reason, /does not say which it ends/);
});

test('several open statuses about the SAME card are all ended by a resolver about that card', () => {
  const a = row({ id: 'a', status_type: 'injury', event_id: 'e1', source_published_at: '2026-06-01T00:00:00Z' });
  const b = row({ id: 'b', status_type: 'withdrawal', event_id: 'e1', source_published_at: '2026-06-02T00:00:00Z' });
  const ret = row({ id: 'ret', status_type: 'return', event_id: 'e1', source_published_at: '2026-09-01T00:00:00Z' });
  const { decided } = resolutions([ret], [a, b]);
  assert.deepEqual(decided.map((d) => d.id).sort(), ['a', 'b']);
});

test('a reported clearance does not lift a suspension; a commission one does', () => {
  const susp = row({ id: 'susp', status_type: 'suspension', source_published_at: '2026-06-01T00:00:00Z' });
  const reported = row({ id: 'c1', status_type: 'cleared', source_kind: 'news', source_published_at: '2026-09-01T00:00:00Z' });
  const commission = row({ id: 'c2', status_type: 'cleared', source_kind: 'commission', source_published_at: '2026-09-01T00:00:00Z' });

  const bad = resolutions([reported], [susp]);
  assert.deepEqual(bad.decided, [], 'a reporter cannot end a ban');
  assert.match(bad.ambiguous[0].reason, /only a commission source can/);

  const good = resolutions([commission], [susp]);
  assert.equal(good.decided.length, 1);
  assert.equal(good.decided[0].id, 'susp');
});

test('a resolver only ever touches the same fighter', () => {
  const theirs = row({ id: 'inj', fighter_id: 'f2', status_type: 'injury', source_published_at: '2026-06-01T00:00:00Z' });
  const cleared = row({ id: 'clr', fighter_id: 'f1', status_type: 'cleared', source_published_at: '2026-09-01T00:00:00Z' });
  assert.deepEqual(resolutions([cleared], [theirs]).decided, []);
});

/* ================= the combined plan ================= */

test('resolution wins over expiry, so the ledger says which actually happened', () => {
  const injury = row({ id: 'inj', status_type: 'injury', event_id: 'past', source_published_at: '2026-06-01T00:00:00Z' });
  const cleared = row({ id: 'clr', status_type: 'cleared', source_published_at: '2026-09-01T00:00:00Z' });
  const plan = planLifecycle({
    rows: [injury, cleared],
    eventDateById: new Map([['past', '2026-07-01']]),
    today: TODAY,
  });
  assert.equal(plan.resolve.length, 1, 'a source ended it');
  assert.deepEqual(plan.expire, [], 'so it is not merely out of date');
});

test('a plan over a mixed table transitions exactly what it should', () => {
  const rows = [
    row({ id: 'past-card', status_type: 'withdrawal', event_id: 'past' }),
    row({ id: 'future-card', status_type: 'withdrawal', event_id: 'future' }),
    row({ id: 'open-injury', fighter_id: 'f9', status_type: 'injury', event_id: null }),
    row({ id: 'already-expired', state: 'expired', status_type: 'withdrawal', event_id: 'past' }),
  ];
  const plan = planLifecycle({
    rows,
    eventDateById: new Map([['past', '2026-03-14'], ['future', '2026-11-14']]),
    today: TODAY,
  });
  assert.deepEqual(plan.expire.map((e) => e.id), ['past-card']);
  assert.deepEqual(plan.resolve, []);
});

/* ================= shared vocabulary ================= */

test('the type sets match what the rest of the system means by them', () => {
  for (const t of ['injury', 'illness', 'withdrawal', 'suspension', 'visa_travel']) {
    assert.ok(UNAVAILABLE_TYPES.has(t));
  }
  for (const t of ['replacement', 'weight_miss', 'return', 'cleared', 'other']) {
    assert.ok(!UNAVAILABLE_TYPES.has(t), `${t} does not make a fighter unavailable`);
  }
  assert.deepEqual([...RESOLVING_TYPES].sort(), ['cleared', 'return']);
});

test('ordering uses the source clock first and our clock last', () => {
  assert.equal(occurredAt({ effective_at: 'A', source_published_at: 'B', detected_at: 'C' }), 'A');
  assert.equal(occurredAt({ effective_at: null, source_published_at: 'B', detected_at: 'C' }), 'B');
  assert.equal(occurredAt({ effective_at: null, source_published_at: null, detected_at: 'C' }), 'C');
});
