import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed } from './ingest.mjs';
import { emptyHealth } from './feed_health.mjs';
import {
  fallbackUrlsFor, fallbackPageFor, fallbackPagesFor, parseLatestPage, parseArticlePage,
} from './source_fallbacks.mjs';

const NOW = Date.parse('2026-09-16T23:00:00Z');

const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pub}</pubDate><description>${i.summary || ''}</description></item>`).join('')
}</channel></rss>`;

const latestHtml = (items) => `<!doctype html><html><head><title>Latest News</title></head><body>
  <nav><a href="/latest-news">Latest News</a><a href="/authors/editor">Staff</a></nav>
  ${items.map((i) => `<article class="card"><a href="${i.link}"><h2>${i.title}</h2></a>${i.pub ? `<time datetime="${i.pub}">${i.pub}</time>` : ''}</article>`).join('\n')}
  <aside><a href="https://example.com/outside">Outside publisher link that must never be accepted</a></aside>
</body></html>`;

const detailHtml = ({ title, pub, url }) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'NewsArticle', headline: title,
  url, datePublished: pub, description: 'Fresh UFC detail from the publisher.',
})}</script></head><body><h1>${title}</h1></body></html>`;

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

function addPageFailures(routes, sourceName, status = 503) {
  for (const url of fallbackPagesFor(sourceName)) routes[url] = { status };
  return routes;
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

test('article-page parser gets a publication clock from real publisher JSON-LD', () => {
  const url = 'https://www.mmamania.com/latest-news/472753/gable-steveson-sean-sharaf-ufc-331';
  const item = parseArticlePage(detailHtml({
    title: 'Gable Steveson responds to UFC 331 opponent after media day',
    pub: '2026-09-16T22:57:00Z',
    url,
  }), url);
  assert.equal(item.link, url);
  assert.equal(item.published, '2026-09-16T22:57:00Z');
  assert.match(item.title, /Gable Steveson/);
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
  assert.ok(fallbacks.length >= 2, 'test needs multiple publisher fallbacks');

  const routes = addPageFailures({
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
  }, 'MMA Fighting');
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
  const pages = fallbackPagesFor('MMA Fighting');
  const routes = addPageFailures({
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
  }, 'MMA Fighting');
  for (const url of fallbacks) routes[url] = { status: 404 };
  routes[pages[0]] = {
    body: latestHtml([{ title: 'UFC 331 media day live stream Van vs Pantoja 2', link: '/ufc/510522/ufc-331-media-day-live-stream-van-vs-pantoja-2', pub: '2026-09-16T22:50:00Z' }]),
  };

  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result, health } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(result.error, null);
    assert.equal(result.fallback_used, true);
    assert.equal(result.page_fallback_attempted, true);
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.page_fallback_pages_attempted, pages.length);
    assert.equal(result.effective_newest_at, '2026-09-16T22:50:00.000Z');
    assert.ok(result.items.some((i) => i.link === 'https://www.mmafighting.com/ufc/510522/ufc-331-media-day-live-stream-van-vs-pantoja-2'));
    assert.ok(calls.some((c) => c.url === pages[0]));
    assert.equal(health.last_primary_newest_ts, Date.parse('2026-09-14T12:00:00Z'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('a second publisher page can recover when the preferred listing is dead', async () => {
  const primary = 'https://publisher.test/rss';
  const fallbacks = fallbackUrlsFor('MMA Mania');
  const pages = fallbackPagesFor('MMA Mania');
  assert.ok(pages.length >= 2, 'test needs multiple live publisher surfaces');
  const routes = {
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
    [pages[0]]: { status: 503 },
    [pages[1]]: {
      body: latestHtml([{ title: 'UFC cuts nine fighters from roster after busy week', link: '/latest-news/472700/ufc-cuts-nine-fighters-from-roster', pub: '2026-09-16T22:54:00Z' }]),
    },
  };
  for (const url of fallbacks) routes[url] = { status: 404 };

  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Mania', url: primary }, { now: NOW });
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.page_fallback_pages_ok, 1);
    assert.equal(result.effective_newest_at, '2026-09-16T22:54:00.000Z');
    assert.ok(calls.some((c) => c.url === pages[1]));
  } finally {
    globalThis.fetch = orig;
  }
});

test('an undated real article card is resolved from the article JSON-LD clock', async () => {
  const primary = 'https://publisher.test/rss';
  const fallbacks = fallbackUrlsFor('MMA Mania');
  const pages = fallbackPagesFor('MMA Mania');
  const article = 'https://www.mmamania.com/latest-news/472753/gable-steveson-sean-sharaf-ufc-331-assault-allegation-response';
  const routes = addPageFailures({
    [primary]: {
      body: feedXml([{ title: 'Old UFC story', link: 'https://publisher.test/old', pub: 'Mon, 14 Sep 2026 12:00:00 GMT' }]),
    },
  }, 'MMA Mania');
  for (const url of fallbacks) routes[url] = { status: 404 };
  routes[pages[0]] = {
    body: latestHtml([{ title: 'Gable Steveson responds to UFC 331 opponent after media day', link: article, pub: null }]),
  };
  routes[article] = {
    body: detailHtml({ title: 'Gable Steveson responds to UFC 331 opponent after media day', pub: '2026-09-16T22:57:00Z', url: article }),
  };

  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result } = await fetchFeed({ UFC_NEWS_KV: fakeKV() }, { name: 'MMA Mania', url: primary }, { now: NOW });
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.page_detail_attempted, 1);
    assert.equal(result.page_detail_ok, 1);
    assert.equal(result.effective_newest_at, '2026-09-16T22:57:00.000Z');
    assert.ok(calls.some((c) => c.url === article));
  } finally {
    globalThis.fetch = orig;
  }
});

test('a 304 from a known-frozen primary still checks live publisher pages on the two-minute pass', async () => {
  const primary = 'https://publisher.test/rss';
  const pages = fallbackPagesFor('MMA Fighting');
  const health = {
    ...emptyHealth(),
    last_etag: 'W/"frozen-v1"',
    last_body_success_ts: NOW - 2 * 60 * 1000,
    last_primary_newest_ts: Date.parse('2026-09-14T12:00:00Z'),
  };
  const kv = fakeKV({ 'feed:health:MMA Fighting': JSON.stringify(health) });
  const routes = addPageFailures({ [primary]: { status: 304 } }, 'MMA Fighting');
  routes[pages[0]] = {
    body: latestHtml([{ title: 'Aljamain Sterling calls for title eliminator with Jean Silva in December', link: '/ufc/510600/aljamain-sterling-title-eliminator', pub: '2026-09-16T22:58:00Z' }]),
  };
  const { fn, calls } = fakeFetch(routes);
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

test('a legacy 304 KV record with no content watermark immediately checks live publisher pages', async () => {
  const primary = 'https://publisher.test/rss';
  const pages = fallbackPagesFor('MMA Fighting');
  const legacyHealth = {
    ...emptyHealth(),
    total_successes: 4000,
    total_not_modified: 3900,
    last_etag: 'W/"legacy-frozen"',
    last_body_success_ts: NOW - 2 * 60 * 1000,
    last_primary_newest_ts: null,
  };
  const kv = fakeKV({ 'feed:health:MMA Fighting': JSON.stringify(legacyHealth) });
  const routes = addPageFailures({ [primary]: { status: 304 } }, 'MMA Fighting');
  routes[pages[0]] = {
    body: latestHtml([{ title: 'UFC 331 weigh-in results and breaking fight week updates', link: '/ufc/510700/ufc-331-weigh-in-results-breaking-updates', pub: '2026-09-16T22:59:00Z' }]),
  };
  const { fn, calls } = fakeFetch(routes);
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const { result } = await fetchFeed({ UFC_NEWS_KV: kv }, { name: 'MMA Fighting', url: primary }, { now: NOW });
    assert.equal(calls[0].headers['If-None-Match'], 'W/"legacy-frozen"');
    assert.ok(calls.some((c) => c.url === fallbackPageFor('MMA Fighting')), 'legacy production KV must not wait for a future forced 200');
    assert.equal(result.not_modified, false);
    assert.equal(result.page_fallback_used, true);
    assert.equal(result.effective_newest_at, '2026-09-16T22:59:00.000Z');
  } finally {
    globalThis.fetch = orig;
  }
});
