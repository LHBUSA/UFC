import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed } from './ingest.mjs';
import { emptyHealth } from './feed_health.mjs';
import { fallbackUrlsFor, fallbackPageFor, parseLatestPage } from './source_fallbacks.mjs';

const NOW = Date.parse('2026-09-16T23:00:00Z');

const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pub}</pubDate><description>${i.summary || ''}</description></item>`).join('')
}</channel></rss>`;

const latestHtml = (items) => `<!doctype html><html><head><title>Latest News</title></head><body>
  <nav><a href="/latest-news">Latest News</a><a href="/authors/editor">Staff</a></nav>
  ${items.map((i) => `<article class="card"><a href="${i.link}"><h2>${i.title}</h2></a><time datetime="${i.pub}">${i.pub}</time></article>`).join('\n')}
  <aside><a href="https://example.com/outside">Outside publisher link that must never be accepted</a></aside>
</body></html>`;

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fn: async (url, init = {}) => {
      const key = String(url);
      calls.push({ url: key, headers: init.headers || {} });
      const r = routes[key];
      if (!r) throw new Error(`unexpected fetch: ${key}`);
      if (r.throw) { const e = new Error(r.throw); e.name = r.name || 'Error'; throw e; }
      const status = r.status ?? 200;
      return new Response(status === 304 ? null : (r.body ?? ''), { status, headers: r.headers || {} });
    },
  };
}

test('latest-page parser keeps same-publisher dated article cards and rejects navigation/offsite links', () => {
  const page = 'https://www.mmafighting.com/latest-news';
  const html = latestHtml([
    {
      title: 'Aljamain Sterling calls for UFC title eliminator in December',
      link: '/ufc/510600/aljamain-sterling-calls-for-title-eliminator',
      pub: '2026-09-16T22:45:00Z',
    },
    {
      title: 'UFC 331 roundtable asks whether Joshua Van can become a face of the company',
      link: 'https://www.mmafighting.com/ufc/510601/ufc-331-roundtable-joshua-van',
      pub: '2026-09-16T21:00:00Z',
    },
  ]);
  const items = parseLatestPage(html, page);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://www.mmafighting.com/ufc/510600/aljamain-sterling-calls-for-title-eliminator');
  assert.equal(items[0].published, '2026-09-16T22:45:00Z');
  assert.ok(items.every((i) => i.link.startsWith('https://www.mmafighting.com/')));
  assert.ok(items.every((i) => !/authors|latest-news/.test(new URL(i.link).pathname)));
});

test('latest-page parser also reads NewsArticle JSON-LD when cards move around', () => {
  const page = 'https://www.mmamania.com/latest-news';
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'UFC cuts nine fighters from roster after busy week',
    url: 'https://www.mmamania.com/ufc-roster-cuts/472700/ufc-cuts-nine-fighters-from-roster',
    datePublished: '2026-09-16T22:54:00Z',
  })}</script></head><body></body></html>`;
  const items = parseLatestPage(html, page);
  assert.equal(items.length, 1);
  assert.equal(items[0].published, '2026-09-16T22:54:00Z');
});

test('a current primary publisher feed never fans out to fallbacks', async () => {
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
    assert.equal(result.page_fallback_attempted, false);
    assert.deepEqual(calls.map((c) => c.url), [primary]);
  } finally {
    globalThis.fetch = orig;
  }
});

test('a frozen MMA Fighting body still recovers from fresh official author RSS', async () => {
  const primary = 'https://publisher.test/rss';
  const fallbacks = fallbackUrlsFor('MMA Fighting');
  const latest = fallbackPageFor('MMA Fighting');
  assert.ok(fallbacks.length >= 2, 'test needs multiple publisher fallbacks');

  const routes = {
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
    [latest]: { status: 503 },
  };
  for (const url of fallbacks) routes[url] = { status: 404 };
  routes[fallbacks[0]] = {
    body: feedXml([{ title: 'Fresh UFC 331 media day story', link: 'https://www.mmafighting.com/ufc/510522/ufc-331-media-day', pub: 'Wed, 16 Sep 2026 22:50:00 GMT' }]),
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
    assert.ok(result.items.some((i) => i.link.includes('/ufc/510522/')));
    assert.ok(calls.some((c) => c.url === fallbacks[0]));
    assert.equal(health.consecutive_failures, 0, 'a recovered publisher remains healthy');
  } finally {
    globalThis.fetch = orig;
  }
});

test('a frozen publisher feed recovers from its live Latest News HTML when RSS fallbacks are dead', async () => {
  const primary = 'https://publisher.test/rss';
  const fallbacks = fallbackUrlsFor('MMA Fighting');
  const latest = fallbackPageFor('MMA Fighting');
  const routes = {
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
    [latest]: {
      body: latestHtml([{ title: 'UFC 331 media day live stream Van vs Pantoja 2', link: '/ufc/510522/ufc-331-media-day-live-stream-van-vs-pantoja-2', pub: '2026-09-16T22:50:00Z' }]),
    },
  };
  for (const url of fallbacks) routes[url] = { status: 404 };

  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result, health } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(result.error, null);
    assert.equal(result.fallback_used, true);
    assert.equal(result.page_fallback_attempted, true);
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.effective_newest_at, '2026-09-16T22:50:00.000Z');
    assert.ok(result.items.some((i) => i.link === 'https://www.mmafighting.com/ufc/510522/ufc-331-media-day-live-stream-van-vs-pantoja-2'));
    assert.ok(calls.some((c) => c.url === latest));
    assert.equal(health.last_primary_newest_ts, Date.parse('2026-09-14T12:00:00Z'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('a 304 from a known-frozen primary still checks the live publisher page on the two-minute pass', async () => {
  const primary = 'https://publisher.test/rss';
  const latest = fallbackPageFor('MMA Fighting');
  const health = {
    ...emptyHealth(),
    last_etag: 'W/"frozen-v1"',
    last_body_success_ts: NOW - 2 * 60 * 1000,
    last_primary_newest_ts: Date.parse('2026-09-14T12:00:00Z'),
  };
  const kv = fakeKV({ 'feed:health:MMA Fighting': JSON.stringify(health) });
  const { fn, calls } = fakeFetch({
    [primary]: { status: 304 },
    [latest]: {
      body: latestHtml([{ title: 'Aljamain Sterling calls for title eliminator with Jean Silva in December', link: '/ufc/510600/aljamain-sterling-title-eliminator', pub: '2026-09-16T22:58:00Z' }]),
    },
  });
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result } = await fetchFeed({ UFC_NEWS_KV: kv }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(calls[0].headers['If-None-Match'], 'W/"frozen-v1"');
    assert.equal(result.not_modified, false, 'publisher page produced real discovery despite primary 304');
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.effective_newest_at, '2026-09-16T22:58:00.000Z');
    assert.ok(result.items.some((i) => /aljamain-sterling-title-eliminator/.test(i.link)));
  } finally {
    globalThis.fetch = orig;
  }
});
