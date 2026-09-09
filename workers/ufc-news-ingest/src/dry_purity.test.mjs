/* A dry run that changes the next production fetch is not a dry run.
 *
 * THE BUG THIS PINS, WHICH HAPPENED
 *
 * fetchFeed persists feed health on every call, and feed health carries the
 * ETag and Last-Modified validators. So a `?dry=true` probe stored fresh
 * validators, the next REAL run sent them, the origin answered 304, and the
 * items the dry run had just looked at were never inserted at all. On
 * 2026-09-09 that consumed Combat Press and LowKick MMA; their items reached
 * the database only because ufc-newsroom's legacy path was still fetching
 * unconditionally. Once this Worker is the sole writer, the same sequence loses
 * them silently, with every counter reporting success.
 *
 * That is why the second half of this file matters as much as the first. Proving
 * "the dry run wrote nothing" is not enough on its own: a dry run could leave KV
 * untouched and still have consumed the origin's freshness some other way. The
 * test therefore follows the dry run with a real run and insists the item is
 * still there to be found.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runIngest, countingReadOnlyKV } from './ingest.mjs';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const ETAG = 'W/"fresh-after-dry"';
const LASTMOD = 'Tue, 09 Sep 2026 11:59:00 GMT';

const FIGHTERS = [
  { id: 'f-pereira', name: 'Alex Pereira', record_w: 12, record_l: 3, record_d: 0, record_nc: 0 },
];

const ITEM = { title: 'Alex Pereira out of the main event with a broken hand', link: 'https://feed.test/a' };
const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>Tue, 09 Sep 2026 11:58:00 GMT</pubDate><description/></item>`).join('')
}</channel></rss>`;

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    snapshot: () => JSON.stringify([...store.entries()].sort()),
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  };
}

/** Serves the feed with validators, and answers 304 to a conditional request -
 *  exactly as the real origins did when this bug bit. */
function conditionalOrigin() {
  const calls = [];
  return {
    calls,
    fn: async (url, init = {}) => {
      const h = init.headers || {};
      calls.push({ url: String(url), ifNoneMatch: h['If-None-Match'] || null });
      if (h['If-None-Match'] === ETAG) return new Response(null, { status: 304 });
      return new Response(feedXml([ITEM]), {
        status: 200,
        headers: { etag: ETAG, 'last-modified': LASTMOD },
      });
    },
  };
}

function fakeSb() {
  const inserted = { ufc_news_items: [], ufc_news_pipeline_events: [] };
  return {
    inserted,
    async select(table, query) {
      if (table === 'ufc_news_sources') return [{ id: 'src-1', name: 'Test Feed', url: 'https://feed.test/rss', weight: 1 }];
      if (table === 'ufc_fighters') return FIGHTERS;
      if (table === 'ufc_fighter_aliases') return [];
      if (table === 'ufc_events') return [];
      if (table === 'ufc_bouts') return [];
      if (table === 'ufc_news_items') {
        if (/fingerprint=in\./.test(query) && !/select=id,fingerprint,detected_at/.test(query)) {
          return inserted.ufc_news_items.map((r) => ({ fingerprint: r.fingerprint, url: r.url }));
        }
        return inserted.ufc_news_items.map((r, i) => ({ id: `item-${i}`, fingerprint: r.fingerprint, detected_at: r.detected_at }));
      }
      return [];
    },
    async insertIgnoringDuplicates(table, rows) { inserted[table].push(...rows); return rows.length; },
    async insert(table, rows) { inserted[table].push(...(Array.isArray(rows) ? rows : [rows])); return rows; },
    async patch() { return null; },
    async count() { return 0; },
  };
}

async function withFetch(fn, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('the full sequence: dry run mutates nothing, then the real run still gets the item', async () => {
  const kv = fakeKV();
  const origin = conditionalOrigin();
  const sbDry = fakeSb();

  // 1. capture exact relevant KV state
  const before = kv.snapshot();

  // 2 + 3. a source response is available to dry mode; execute the dry run
  const dry = await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sbDry, { now: NOW, dry: true }), origin.fn);
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.totals.candidates, 1, 'the dry run must actually have seen the item');
  assert.equal(dry.would_insert.length, 1);

  // 4. KV operational state unchanged
  assert.equal(kv.snapshot(), before, 'dry run mutated KV');
  assert.equal(kv.store.size, 0, 'dry run created KV keys');
  assert.equal(dry.kv_writes_attempted, 0, 'dry run attempted a KV write');

  //    ...and no Supabase rows, no pipeline events, no queue messages
  assert.deepEqual(sbDry.inserted.ufc_news_items, [], 'dry run wrote news items');
  assert.deepEqual(sbDry.inserted.ufc_news_pipeline_events, [], 'dry run wrote pipeline events');

  // 5. run a real ingest immediately afterwards
  const sbReal = fakeSb();
  const real = await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sbReal, { now: NOW + 1000 }), origin.fn);

  // 6. the real run still sees and processes that item
  assert.equal(real.totals.inserted, 1, 'the real run lost the item the dry run had seen');
  assert.equal(sbReal.inserted.ufc_news_items.length, 1);
  assert.equal(sbReal.inserted.ufc_news_pipeline_events.length, 1);
  assert.equal(sbReal.inserted.ufc_news_pipeline_events[0].stage, 'detect');

  //    the origin was never asked conditionally on the dry run's behalf
  assert.equal(origin.calls[0].ifNoneMatch, null, 'first (dry) request should carry no validator here');
  assert.equal(origin.calls[1].ifNoneMatch, null, 'the real run must not inherit a validator the dry run stored');

  // 7. no duplicate is introduced: a second real run inserts nothing new
  const third = await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sbReal, { now: NOW + 2000 }), origin.fn);
  assert.equal(third.totals.inserted, 0, 'a repeat run inserted a duplicate');
  assert.equal(sbReal.inserted.ufc_news_items.length, 1);
  assert.equal(sbReal.inserted.ufc_news_pipeline_events.length, 1, 'a duplicate detect event would restamp an old story as fresh');
});

test('a real run DOES persist validators, so 304s still work', async () => {
  /* The fix must not be "stop conditional fetching". At a two-minute cadence
   * that would be 720 full fetches per feed per day. */
  const kv = fakeKV();
  const origin = conditionalOrigin();
  const sb = fakeSb();

  await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sb, { now: NOW }), origin.fn);
  const stored = JSON.parse(await kv.get('feed:health:Test Feed'));
  assert.equal(stored.last_etag, ETAG, 'a real run must store the validator');
  assert.equal(stored.last_modified, LASTMOD);

  const second = await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sb, { now: NOW + 120_000 }), origin.fn);
  assert.equal(origin.calls[1].ifNoneMatch, ETAG, 'the second real run must send the stored validator');
  assert.equal(second.totals.not_modified, 1, 'and receive a 304');
  assert.equal(second.totals.parsed, 0, 'a 304 must cost no parse');
});

test('a dry run after a real run is still pure, and still previews faithfully', async () => {
  /* The order that actually happens in operation: health already exists, and a
   * dry run must neither refresh it nor corrupt it. */
  const kv = fakeKV();
  const origin = conditionalOrigin();
  const sb = fakeSb();

  await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, sb, { now: NOW }), origin.fn);
  const before = kv.snapshot();

  const dry = await withFetch(() => runIngest({ UFC_NEWS_KV: kv }, fakeSb(), { now: NOW + 60_000, dry: true }), origin.fn);
  assert.equal(kv.snapshot(), before, 'a dry run after a real run mutated stored health');
  assert.equal(dry.kv_writes_attempted, 0);
  /* It sent the stored validator and got a 304 - which is a faithful preview of
   * what the next real run would do, not a failure. */
  assert.equal(dry.totals.not_modified, 1);
});

test('the counting facade reads through and swallows writes', async () => {
  const kv = fakeKV({ a: '1' });
  const counter = { attempted: 0 };
  const ro = countingReadOnlyKV(kv, counter);
  assert.equal(await ro.get('a'), '1');
  await ro.put('a', '2');
  await ro.delete('a');
  assert.equal(counter.attempted, 2);
  assert.equal(await kv.get('a'), '1', 'the underlying store must be untouched');
  assert.equal(countingReadOnlyKV(null, counter), null, 'an absent binding stays absent');
});
