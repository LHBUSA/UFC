import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed } from './ingest.mjs';
import { fallbackUrlsFor } from './source_fallbacks.mjs';

const NOW = Date.parse('2026-09-16T23:00:00Z');

const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pub}</pubDate><description>${i.summary || ''}</description></item>`).join('')
}</channel></rss>`;

function fakeKV() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) || null,
    put: async (k, v) => { store.set(k, v); },
  };
}

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      const key = String(url);
      calls.push(key);
      const r = routes[key];
      if (!r) throw new Error(`unexpected fetch: ${key}`);
      const status = r.status ?? 200;
      return new Response(status === 304 ? null : (r.body ?? ''), { status, headers: r.headers || {} });
    },
  };
}

test('a current primary publisher feed never fans out to author fallbacks', async () => {
  const primary = 'https://publisher.test/rss';
  const { fn, calls } = fakeFetch({
    [primary]: {
      body: feedXml([{ title: 'Fresh UFC story', link: 'https://publisher.test/fresh', pub: 'Wed, 16 Sep 2026 22:55:00 GMT' }]),
    },
  });
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(result.fallback_used, false);
    assert.equal(result.fallback_attempted, 0);
    assert.deepEqual(calls, [primary]);
  } finally {
    globalThis.fetch = orig;
  }
});

test('a frozen MMA Fighting body recovers from fresh official author RSS', async () => {
  const primary = 'https://publisher.test/rss';
  const fallbacks = fallbackUrlsFor('MMA Fighting');
  assert.ok(fallbacks.length >= 2, 'test needs multiple publisher fallbacks');

  const routes = {
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
  };
  for (const url of fallbacks) routes[url] = { status: 404 };
  routes[fallbacks[0]] = {
    body: feedXml([{ title: 'Fresh UFC 331 media day story', link: 'https://publisher.test/fresh', pub: 'Wed, 16 Sep 2026 22:50:00 GMT' }]),
  };

  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result, health } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(result.error, null);
    assert.equal(result.fallback_used, true);
    assert.equal(result.fallback_attempted, fallbacks.length);
    assert.equal(result.fallback_feeds_ok, 1);
    assert.equal(result.primary_newest_at, '2026-09-14T12:00:00.000Z');
    assert.equal(result.effective_newest_at, '2026-09-16T22:50:00.000Z');
    assert.ok(result.items.some((i) => i.link === 'https://publisher.test/fresh'));
    assert.ok(calls.includes(fallbacks[0]));
    assert.equal(health.consecutive_failures, 0, 'a recovered publisher remains healthy');
  } finally {
    globalThis.fetch = orig;
  }
});
