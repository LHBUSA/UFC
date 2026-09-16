/* The circuit breaker's contract, stated as tests.
 *
 * At a two-minute cadence an unbroken circuit is not a minor inefficiency: a
 * dead feed would be contacted 720 times a day, each costing up to the full
 * 8-second timeout, and the timeouts are what make a run overrun.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyHealth, onSuccess, onFailure, isInCooldown, shouldHalfOpen, percentile, summarize,
  refreshStaleValidators, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS,
  CIRCUIT_EXTENDED_COOLDOWN_MS, FORCE_BODY_REFRESH_MS, LATENCY_SAMPLES,
} from './feed_health.mjs';

const T0 = Date.parse('2026-09-09T12:00:00Z');

test('the circuit opens on the fifth consecutive failure, not the first', () => {
  const h = emptyHealth();
  for (let i = 1; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    onFailure(h, T0, `http 500 #${i}`);
    assert.equal(h.circuit_state, 'closed', `should still be closed after ${i} failures`);
  }
  onFailure(h, T0, 'http 500 #5');
  assert.equal(h.circuit_state, 'open');
  assert.equal(h.cooldown_until_ts, T0 + CIRCUIT_COOLDOWN_MS);
  assert.equal(isInCooldown(h, T0 + 60_000), true);
});

test('one success anywhere in the streak resets it', () => {
  const h = emptyHealth();
  onFailure(h, T0, 'a'); onFailure(h, T0, 'b'); onFailure(h, T0, 'c'); onFailure(h, T0, 'd');
  onSuccess(h, T0, { latencyMs: 120 });
  assert.equal(h.consecutive_failures, 0);
  onFailure(h, T0, 'e');
  assert.equal(h.circuit_state, 'closed', 'a single failure after a success must not open the circuit');
});

test('cooldown expiry half-opens, and failing the retry backs off to 24h', () => {
  const h = emptyHealth();
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) onFailure(h, T0, 'dead');
  assert.equal(shouldHalfOpen(h, T0 + CIRCUIT_COOLDOWN_MS - 1), false);

  const later = T0 + CIRCUIT_COOLDOWN_MS + 1;
  assert.equal(shouldHalfOpen(h, later), true);
  assert.equal(isInCooldown(h, later), false, 'past cooldown the feed gets exactly one probe');

  onFailure(h, later, 'still dead', { wasHalfOpen: true });
  assert.equal(h.cooldown_until_ts, later + CIRCUIT_EXTENDED_COOLDOWN_MS);
});

test('a recovered feed closes its circuit completely', () => {
  const h = emptyHealth();
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) onFailure(h, T0, 'dead');
  onSuccess(h, T0 + CIRCUIT_COOLDOWN_MS + 1, { latencyMs: 90, etag: 'W/"abc"' });
  assert.equal(h.circuit_state, 'closed');
  assert.equal(h.cooldown_until_ts, null);
  assert.equal(isInCooldown(h, T0 + CIRCUIT_COOLDOWN_MS + 2), false);
});

test('304 counts as success, preserves body watermark and does not erase cached validators', () => {
  const h = emptyHealth();
  onSuccess(h, T0, { latencyMs: 100, etag: 'W/"v1"', lastModified: 'Tue, 09 Sep 2026 12:00:00 GMT' });
  assert.equal(h.last_body_success_ts, T0);
  onSuccess(h, T0 + 120_000, { latencyMs: 30, notModified: true });
  assert.equal(h.last_etag, 'W/"v1"');
  assert.equal(h.last_modified, 'Tue, 09 Sep 2026 12:00:00 GMT');
  assert.equal(h.last_body_success_ts, T0, '304 must not pretend a response body was refreshed');
  assert.equal(h.total_not_modified, 1);
  assert.equal(h.total_successes, 2);
});

test('stale validators are cleared after the forced-body interval', () => {
  const h = emptyHealth();
  onSuccess(h, T0, { latencyMs: 100, etag: 'W/"v1"', lastModified: 'Tue, 09 Sep 2026 12:00:00 GMT' });
  refreshStaleValidators(h, T0 + FORCE_BODY_REFRESH_MS - 1);
  assert.equal(h.last_etag, 'W/"v1"');
  assert.ok(h.last_modified);
  refreshStaleValidators(h, T0 + FORCE_BODY_REFRESH_MS);
  assert.equal(h.last_etag, null);
  assert.equal(h.last_modified, null);
});

test('legacy health that already accumulated 304s gets one unconditional recovery fetch', () => {
  const h = {
    ...emptyHealth(),
    total_successes: 91,
    total_not_modified: 90,
    last_success_ts: T0,
    last_etag: 'W/"stuck"',
    last_modified: 'Tue, 09 Sep 2026 10:00:00 GMT',
    last_body_success_ts: null,
  };
  refreshStaleValidators(h, T0 + 1);
  assert.equal(h.last_etag, null);
  assert.equal(h.last_modified, null);
});

test('latency samples stay bounded and percentiles are usable', () => {
  const h = emptyHealth();
  for (let i = 1; i <= LATENCY_SAMPLES + 15; i += 1) onSuccess(h, T0, { latencyMs: i });
  assert.equal(h.latency_samples.length, LATENCY_SAMPLES);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
});

test('summarize reports the operator-facing truth', () => {
  const h = emptyHealth();
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) onFailure(h, T0, 'http 404');
  const s = summarize('Dead Feed', h, T0 + 60_000);
  assert.equal(s.circuit, 'open');
  assert.equal(s.cooling_down, true);
  assert.equal(s.cooldown_remaining_minutes, 359);
  assert.equal(s.last_failure_reason, 'http 404');
  assert.equal(s.success_rate, 0);
  assert.equal(s.forced_body_refresh_minutes, FORCE_BODY_REFRESH_MS / 60000);
});
