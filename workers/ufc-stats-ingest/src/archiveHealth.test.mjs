/* Round-archive gap detection. Run: node --test src/archiveHealth.test.mjs
 *
 * Pins the silent outage of 2026-09-13: UFCSTATS_ENABLED=false, Noche UFC
 * complete with 13 results, every bout awaiting_source, 0 round rows — and no
 * signal anywhere. That exact state must read as a degraded round lane, alert
 * once, not re-alert every 15 minutes, escalate if it persists, and clear when
 * the rows land. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundArchiveGaps, roundLaneStatus, gapAlertDecision, gapLine, gapDueAt } from './archiveHealth.mjs';

const NOCHE = (over = {}) => ({
  id: '1d0b22df-81e7-4e5b-8fa5-8e5d03c24c52', name: 'Noche UFC: Silva vs. Delgado', event_date: '2026-09-12', card_status: 'complete',
  bouts: Array.from({ length: 13 }, (_, i) => ({ id: `b${i}`, has_result: true, round_rows: 0, queue_state: 'awaiting_source', queue_reason: 'UFCSTATS_ENABLED=false' })),
  ...over,
});
const at = (iso) => Date.parse(iso);
const DISABLED = { enabled: false, challenged: false };

test('UFCSTATS_ENABLED=false + completed event + results + no rows is a degraded round lane', () => {
  const gaps = roundArchiveGaps({ events: [NOCHE()], now: at('2026-09-13T23:20:00Z'), source: DISABLED });
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].completed_bouts, gaps[0].with_round_rows, gaps[0].waiting_on_source, gaps[0].cause], [13, 0, 13, 'source disabled']);
  assert.deepEqual(gaps[0].queue_reasons, ['UFCSTATS_ENABLED=false']);
  assert.equal(roundLaneStatus({ gaps }), 'degraded');
  assert.equal(gapLine(gaps[0]), 'ROUND ARCHIVE GAP · Noche UFC: Silva vs. Delgado · 13 completed bouts · 0 with round rows · source disabled');
});

test('inside the publication grace period it is not yet a gap', () => {
  assert.equal(new Date(gapDueAt('2026-09-12')).toISOString(), '2026-09-13T12:00:00.000Z');
  assert.equal(roundArchiveGaps({ events: [NOCHE()], now: at('2026-09-13T06:00:00Z'), source: DISABLED }).length, 0);
});

test('fully archived, or answered as no round detail, or not complete, is not a gap', () => {
  const now = at('2026-09-14T00:00:00Z');
  const archived = NOCHE({ bouts: NOCHE().bouts.map((b) => ({ ...b, round_rows: 6, queue_state: 'written' })) });
  assert.equal(roundArchiveGaps({ events: [archived], now }).length, 0);
  const answered = NOCHE({ bouts: NOCHE().bouts.map((b, i) => (i === 0 ? { ...b, queue_state: 'no_round_detail' } : { ...b, round_rows: 4, queue_state: 'written' })) });
  assert.equal(roundArchiveGaps({ events: [answered], now }).length, 0);
  assert.equal(roundArchiveGaps({ events: [NOCHE({ card_status: 'announced' })], now }).length, 0);
  const identityOnly = NOCHE({ bouts: NOCHE().bouts.map((b, i) => (i === 0 ? { ...b, queue_state: 'identity_review' } : { ...b, round_rows: 4, queue_state: 'written' })) });
  assert.equal(roundArchiveGaps({ events: [identityOnly], now }).length, 0, 'not waiting on the source: a review item, not a source outage');
});

test('a materially incomplete card waiting on a challenged source is a gap', () => {
  const partial = NOCHE({ bouts: NOCHE().bouts.map((b, i) => (i < 9 ? { ...b, round_rows: 6, queue_state: 'written' } : b)) });
  const [g] = roundArchiveGaps({ events: [partial], now: at('2026-09-14T00:00:00Z'), source: { enabled: true, challenged: true } });
  assert.deepEqual([g.completed_bouts, g.with_round_rows, g.missing, g.cause], [13, 9, 4, 'source challenged']);
});

test('alert once, stay quiet on the next 15-minute checks, escalate after 24h, clear once', () => {
  const gaps = roundArchiveGaps({ events: [NOCHE()], now: at('2026-09-13T23:20:00Z'), source: DISABLED });
  const first = gapAlertDecision({ gaps, previous: null, now: at('2026-09-13T23:20:00Z') });
  assert.deepEqual([first.send, first.kind], [true, 'new']);
  assert.match(first.message, /^ROUND ARCHIVE GAP · Noche UFC/);
  let state = first.next;
  for (let m = 15; m <= 180; m += 15) {
    const d = gapAlertDecision({ gaps, previous: state, now: at('2026-09-13T23:20:00Z') + m * 60000 });
    assert.equal(d.send, false, `quiet at +${m}m`);
    state = d.next;
  }
  const esc = gapAlertDecision({ gaps, previous: state, now: at('2026-09-14T23:21:00Z') });
  assert.deepEqual([esc.send, esc.kind], [true, 'escalation']);
  assert.match(esc.message, /STILL DEGRADED since 2026-09-13T23:20:00.000Z/);
  state = esc.next;
  const partial = roundArchiveGaps({ events: [NOCHE({ bouts: NOCHE().bouts.map((b, i) => (i < 9 ? { ...b, round_rows: 6, queue_state: 'written' } : b)) })], now: at('2026-09-15T01:00:00Z'), source: { enabled: true, challenged: false } });
  const changed = gapAlertDecision({ gaps: partial, previous: state, now: at('2026-09-15T01:00:00Z') });
  assert.deepEqual([changed.send, changed.kind], [true, 'changed']);
  const cleared = gapAlertDecision({ gaps: [], previous: changed.next, now: at('2026-09-15T02:00:00Z') });
  assert.deepEqual([cleared.send, cleared.kind, cleared.next.status], [true, 'cleared', 'ok']);
  const quiet = gapAlertDecision({ gaps: [], previous: cleared.next, now: at('2026-09-15T02:15:00Z') });
  assert.equal(quiet.send, false, 'cleared is announced once');
});

test('one card recovers while others remain: one alert naming it, recorded once, then quiet', () => {
  const now = at('2026-09-14T02:00:00Z');
  const dwcs = {
    id: 'dwcs-5', name: 'Contender Series: Season 10, Week 5', event_date: '2026-09-08', card_status: 'complete',
    bouts: Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, has_result: true, round_rows: 0, queue_state: 'awaiting_source', queue_reason: 'UFCSTATS_ENABLED=false' })),
  };
  const both = roundArchiveGaps({ events: [NOCHE(), dwcs], now, source: DISABLED });
  /* a stored state written before event names were kept (production, 2026-09-14) */
  const legacy = { ...gapAlertDecision({ gaps: both, previous: null, now: now - 3600e3 }).next };
  delete legacy.event_names;
  delete legacy.cleared_events;
  const recovered = NOCHE({ bouts: NOCHE().bouts.map((b) => ({ ...b, round_rows: 6, queue_state: 'written' })) });
  const after = roundArchiveGaps({ events: [recovered, dwcs], now, source: DISABLED });
  assert.equal(after.length, 1);
  assert.equal(roundLaneStatus({ gaps: after }), 'degraded', 'still degraded for the card that is still missing');
  const d = gapAlertDecision({ gaps: after, previous: legacy, now, eventNames: { [NOCHE().id]: 'Noche UFC: Silva vs. Delgado' } });
  assert.deepEqual([d.send, d.kind], [true, 'changed']);
  assert.match(d.message, /^ROUND ARCHIVE GAP CLEARED · Noche UFC: Silva vs\. Delgado\nROUND ARCHIVE GAP · Contender Series/);
  assert.deepEqual(d.next.cleared_events.map((e) => [e.event_name, e.cleared_at]), [['Noche UFC: Silva vs. Delgado', '2026-09-14T02:00:00.000Z']]);
  const again = gapAlertDecision({ gaps: after, previous: d.next, now: now + 15 * 60e3 });
  assert.equal(again.send, false, 'no duplicate recovery alert');
  assert.equal(again.next.cleared_events.length, 1, 'recovery recorded once');
});
