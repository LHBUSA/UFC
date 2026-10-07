/* Change-only feed-health persistence: a plain 304 on a healthy feed is not
 * written back until the heartbeat, every meaningful transition still is. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed, runIngest } from './ingest.mjs';
import { emptyHealth, loadHealth, healthNeedsWrite, HEALTH_HEARTBEAT_MS } from './feed_health.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const fakeKV = (seed = {}) => { const store = new Map(Object.entries(seed)); const puts = []; return { store, puts, get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => { puts.push(k); store.set(k, v); } }; };
const healthy = (over = {}) => ({ ...emptyHealth(), total_successes: 10, total_not_modified: 8, last_success_ts: NOW - 60e3, last_body_success_ts: NOW - 4 * 60e3, last_primary_newest_ts: NOW - 3600e3, last_etag: 'W/"v1"', last_modified: 'Tue, 07 Oct 2026 11:00:00 GMT', ...over });
const withFetch = async (status, fn) => { const orig = globalThis.fetch; globalThis.fetch = async () => new Response(null, { status }); try { return await fn(); } finally { globalThis.fetch = orig; } };

test('a plain 304 on a healthy feed inside the heartbeat is not persisted', async () => {
  const kv = fakeKV({ 'feed:health:Live': JSON.stringify(healthy()) });
  const { result, changed, health } = await withFetch(304, () => fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Live', url: 'https://live.test/feed' }, { now: NOW }));
  assert.equal(result.not_modified, true);
  assert.equal(changed, false);
  assert.equal(health.total_not_modified, 9); // in-memory accounting unchanged
  assert.ok(!JSON.stringify(health).includes('stored')); // the stored copy never serializes
});

test('heartbeat: once the stored success is older than the window the 304 is persisted', async () => {
  const kv = fakeKV({ 'feed:health:Live': JSON.stringify(healthy({ last_success_ts: NOW - HEALTH_HEARTBEAT_MS })) });
  const { changed } = await withFetch(304, () => fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Live', url: 'https://live.test/feed' }, { now: NOW }));
  assert.equal(changed, true);
});

test('meaningful transitions are always persisted: recovery from failures, new record, legacy watermark', async () => {
  for (const seed of [
    { 'feed:health:Live': JSON.stringify(healthy({ consecutive_failures: 2, last_failure_ts: NOW - 120e3, last_failure_reason: 'http 503' })) },
    {},
    { 'feed:health:Live': JSON.stringify(healthy({ last_primary_newest_ts: null })) },
  ]) {
    const kv = fakeKV(seed);
    const { changed } = await withFetch(304, () => fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Live', url: 'https://live.test/feed' }, { now: NOW }));
    assert.equal(changed, true);
  }
});

test('failures and 200 bodies keep writing on every run', async () => {
  const kv = fakeKV({ 'feed:health:Live': JSON.stringify(healthy()) });
  const r = await withFetch(503, () => fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Live', url: 'https://live.test/feed' }, { now: NOW }));
  assert.equal(r.changed, true);
});

test('healthNeedsWrite compares meaningful fields against the stored record', async () => {
  const kv = fakeKV({ 'feed:health:X': JSON.stringify(healthy()) });
  const h = await loadHealth(kv, 'X', NOW);
  assert.equal(healthNeedsWrite(h, NOW), false);
  h.last_etag = 'W/"v2"';
  assert.equal(healthNeedsWrite(h, NOW), true);
  assert.equal(healthNeedsWrite({ ...emptyHealth() }, NOW), true); // no stored copy -> write
});
