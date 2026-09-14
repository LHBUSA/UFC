/* Fighter-status glue on the news-ingest host. Run with the worker's npm test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusDue, summarizePass, STATUS_PERIOD_MIN } from './status.mjs';

test('the periodic slot fires every ten minutes and only then', () => {
  assert.equal(STATUS_PERIOD_MIN, 10);
  assert.equal(statusDue(Date.parse('2026-09-14T22:00:00Z')), true);
  assert.equal(statusDue(Date.parse('2026-09-14T22:10:00Z')), true);
  assert.equal(statusDue(Date.parse('2026-09-14T22:02:00Z')), false);
  assert.equal(statusDue(Date.parse('2026-09-14T22:08:00Z')), false);
});

test('pass counters are carried through faithfully', () => {
  const s = summarizePass({
    status: 'success', wrote: true, duration_ms: 812,
    steps: { collect: { items_read: 40, candidates: 6, events: 2, below_confidence: 1, inserted: 1, duplicate_noop: 1, rejected: 0 }, lifecycle: { resolved: 0, expired: 1, applied: 1 } },
    failures: [],
  }, { trigger: 'ingest(+3)', at: '2026-09-14T22:00:00.000Z', sinceHours: 6 });
  assert.deepEqual(
    [s.items_inspected, s.events_emitted, s.inserted, s.duplicate_noop, s.rejected, s.lifecycle_expired, s.status],
    [40, 2, 1, 1, 0, 1, 'success'],
  );
});

test('the host adds no second fetch path and never calls a model', () => {
  const src = readFileSync(new URL('./status.mjs', import.meta.url), 'utf8');
  assert.match(src, /ingest:\s*false/, 'this host already ingested; the status pass must not fetch feeds');
  assert.doesNotMatch(src, /openai|anthropic|write_articles|fetch\(/i);
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(index, /inserted > 0 \|\| statusDue\(event\.scheduledTime\)/, 'status runs after new items and on the period');
});
