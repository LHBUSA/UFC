/* The ingest run, against a fake feed origin and a fake PostgREST.
 *
 * The properties worth pinning are the ones that are invisible when they break:
 * that an open circuit is not contacted, that a 304 costs no parse, that a
 * boxing item is stored but unscoreable, that detected_at is the run's clock
 * and not the publisher's, and that no detect event is emitted for an item that
 * already existed - which is what would otherwise make the SLA report claim a
 * three-day-old story was detected just now.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed, runIngest } from './ingest.mjs';
import { emptyHealth, onFailure, CIRCUIT_FAILURE_THRESHOLD } from './feed_health.mjs';

const NOW = Date.parse('2026-09-09T12:00:00Z');

const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pub || 'Tue, 09 Sep 2026 11:58:00 GMT'}</pubDate><description>${i.summary || ''}</description></item>`).join('')
}</channel></rss>`;

/** In-memory KV with the two methods feed_health uses. */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

/** Records every request so assertions can be about what was NOT called. */
function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fn: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      const r = routes[String(url)];
      if (!r) throw new Error(`unexpected fetch: ${url}`);
      if (r.throw) { const e = new Error(r.throw); e.name = r.name || 'Error'; throw e; }
      const status = r.status ?? 200;
      /* 304/204/205 are null-body statuses; Response throws on a non-null body
       * for them, and swallowing that as a fetch error is exactly how a test
       * for 304 handling would silently stop testing 304 handling. */
      const nullBody = status === 304 || status === 204 || status === 205;
      return new Response(nullBody ? null : (r.body ?? ''), { status, headers: r.headers ?? {} });
    },
  };
}

test('a feed whose circuit is open is not contacted at all', async () => {
  const h = emptyHealth();
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) onFailure(h, NOW, 'dead');
  const kv = fakeKV({ 'feed:health:Dead': JSON.stringify(h) });
  const { fn, calls } = fakeFetch({});
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const { result, changed } = await fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Dead', url: 'https://dead.invalid/feed' }, { now: NOW + 1000 });
    assert.match(result.skipped, /circuit open/);
    assert.equal(calls.length, 0, 'an open circuit must cost zero requests');
    assert.equal(changed, false);
  } finally { globalThis.fetch = orig; }
});

test('cached validators are sent, and a 304 costs no parse', async () => {
  const h = { ...emptyHealth(), last_etag: 'W/"v1"', last_modified: 'Tue, 09 Sep 2026 11:00:00 GMT' };
  const kv = fakeKV({ 'feed:health:Live': JSON.stringify(h) });
  const { fn, calls } = fakeFetch({ 'https://live.test/feed': { status: 304 } });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const { result, health } = await fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Live', url: 'https://live.test/feed' }, { now: NOW });
    assert.equal(calls[0].headers['If-None-Match'], 'W/"v1"');
    assert.equal(calls[0].headers['If-Modified-Since'], 'Tue, 09 Sep 2026 11:00:00 GMT');
    assert.equal(result.not_modified, true);
    assert.equal(result.items.length, 0);
    assert.equal(health.total_not_modified, 1);
    assert.equal(health.circuit_state, 'closed');
  } finally { globalThis.fetch = orig; }
});

test('a 200 that parses to nothing is a failure, not a quiet day', async () => {
  /* Otherwise a feed that started serving an HTML error page stays "healthy"
   * forever and the circuit never opens. */
  const kv = fakeKV();
  const { fn } = fakeFetch({ 'https://empty.test/feed': { status: 200, body: '<html>maintenance</html>' } });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const { result, health } = await fetchFeed({ UFC_NEWS_KV: kv }, { name: 'Empty', url: 'https://empty.test/feed' }, { now: NOW });
    assert.equal(result.error, 'no items parsed');
    assert.equal(health.consecutive_failures, 1);
    assert.equal(health.total_successes, 0);
  } finally { globalThis.fetch = orig; }
});

/* ---- full run -------------------------------------------------------- */

const FIGHTERS = [
  { id: 'f-pereira', name: 'Alex Pereira', record_w: 12, record_l: 3, record_d: 0, record_nc: 0 },
  { id: 'f-makhachev', name: 'Islam Makhachev', record_w: 27, record_l: 1, record_d: 0, record_nc: 0 },
  { id: 'f-tsarukyan', name: 'Arman Tsarukyan', record_w: 22, record_l: 3, record_d: 0, record_nc: 0 },
  { id: 'f-dvalishvili', name: 'Merab Dvalishvili', record_w: 20, record_l: 4, record_d: 0, record_nc: 0 },
];

/** Minimal Supabase double: enough surface for runIngest, and it records writes. */
function fakeSb({ existingFingerprints = [] } = {}) {
  const inserted = { ufc_news_items: [], ufc_news_pipeline_events: [] };
  return {
    inserted,
    async select(table, query) {
      if (table === 'ufc_news_sources') return [{ id: 'src-1', name: 'Test Feed', url: 'https://feed.test/rss', weight: 1 }];
      /* A real index, because the focus filter's entity rule reads it. An empty
       * one would make every headline resolve zero fighters and quietly change
       * what these tests are measuring. */
      if (table === 'ufc_fighters') return FIGHTERS;
      if (table === 'ufc_fighter_aliases') return [];
      if (table === 'ufc_events') return [];
      if (table === 'ufc_bouts') return [];
      if (table === 'ufc_news_items') {
        if (/fingerprint=in\./.test(query) && !/select=id,fingerprint,detected_at/.test(query)) {
          return existingFingerprints.map((fp) => ({ fingerprint: fp, url: `https://existing/${fp}` }));
        }
        /* read-back after insert */
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

test('a run stores boxing but marks it unscoreable, and stamps our own clock', async () => {
  const kv = fakeKV();
  const sb = fakeSb();
  const { fn } = fakeFetch({
    'https://feed.test/rss': {
      status: 200,
      body: feedXml([
        { title: 'Alex Pereira out of the main event with a broken hand', link: 'https://feed.test/a' },
        { title: 'Title Fight Preview | Ryan Garcia vs Conor Benn', link: 'https://feed.test/b' },
        { title: 'Top 10 knockouts of 2025', link: 'https://feed.test/c' },
      ]),
    },
  });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const out = await runIngest({ UFC_NEWS_KV: kv }, sb, { now: NOW });
    assert.equal(out.status, 'ran');
    assert.equal(out.totals.parsed, 3);
    assert.equal(out.totals.candidates, 1, 'only the UFC item may be scoreable');
    assert.equal(out.totals.focus_rejected, 2);
    assert.equal(out.totals.inserted, 3, 'rejected items are stored, not dropped');

    const rows = sb.inserted.ufc_news_items;
    const find = (prefix) => {
      const r = rows.find((x) => x.title.startsWith(prefix));
      assert.ok(r, `no stored row starting "${prefix}" (stored: ${rows.map((x) => x.title).join(' | ')})`);
      return r;
    };
    assert.equal(find('Alex Pereira').state, 'new');
    assert.equal(find('Title Fight Preview').state, 'skipped');
    assert.match(find('Title Fight Preview').state_reason, /no_ufc_link/);
    assert.equal(find('Top 10 knockouts').state, 'skipped');

    /* detected_at is OUR clock. Using the publisher's would make an item
     * republished with an old pubDate look instantly stale, and would make the
     * SLA measure their latency instead of ours. */
    for (const r of rows) assert.equal(r.detected_at, new Date(NOW).toISOString());
  } finally { globalThis.fetch = orig; }
});

test('an item that already exists produces no insert and no detect event', async () => {
  /* This is what keeps the SLA report honest: a detect event per OFFERED row
   * would restamp every old story as freshly detected on every run. */
  const kv = fakeKV();
  const probe = await (async () => {
    const s = fakeSb();
    const { fn } = fakeFetch({ 'https://feed.test/rss': { status: 200, body: feedXml([{ title: 'Islam Makhachev vs Arman Tsarukyan rebooked for December', link: 'https://feed.test/a' }]) } });
    const orig = globalThis.fetch; globalThis.fetch = fn;
    try { await runIngest({ UFC_NEWS_KV: kv }, s, { now: NOW }); } finally { globalThis.fetch = orig; }
    return s.inserted.ufc_news_items[0].fingerprint;
  })();

  const sb = fakeSb({ existingFingerprints: [probe] });
  const { fn } = fakeFetch({ 'https://feed.test/rss': { status: 200, body: feedXml([{ title: 'Islam Makhachev vs Arman Tsarukyan rebooked for December', link: 'https://feed.test/a' }]) } });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const out = await runIngest({ UFC_NEWS_KV: fakeKV() }, sb, { now: NOW + 120_000 });
    assert.equal(out.totals.dup_in_db, 1);
    assert.equal(out.totals.inserted, 0);
    assert.equal(sb.inserted.ufc_news_pipeline_events.length, 0, 'no detect event for an item we already had');
  } finally { globalThis.fetch = orig; }
});

test('the detect event records publisher lag separately from our own', async () => {
  const sb = fakeSb();
  const { fn } = fakeFetch({
    'https://feed.test/rss': {
      status: 200,
      body: feedXml([{ title: 'Merab Dvalishvili misses weight by two pounds', link: 'https://feed.test/a', pub: 'Tue, 09 Sep 2026 11:55:00 GMT' }]),
    },
  });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    await runIngest({ UFC_NEWS_KV: fakeKV() }, sb, { now: NOW });
    const ev = sb.inserted.ufc_news_pipeline_events[0];
    assert.equal(ev.stage, 'detect');
    assert.equal(ev.status, 'ok');
    assert.equal(ev.since_detect_ms, 0);
    assert.equal(ev.detail.publisher_lag_ms, 5 * 60 * 1000, 'five minutes behind the publisher');
    assert.equal(ev.worker, 'ufc-news-ingest');
  } finally { globalThis.fetch = orig; }
});

test('stale items are dropped and duplicates within one run are collapsed', async () => {
  const sb = fakeSb();
  const { fn } = fakeFetch({
    'https://feed.test/rss': {
      status: 200,
      body: feedXml([
        { title: 'Ancient news about a card', link: 'https://feed.test/old', pub: 'Mon, 01 Jan 2024 10:00:00 GMT' },
        { title: 'Merab Dvalishvili signs new four-fight deal', link: 'https://feed.test/x' },
        { title: 'Merab Dvalishvili signs new four-fight deal', link: 'https://feed.test/x' },
      ]),
    },
  });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const out = await runIngest({ UFC_NEWS_KV: fakeKV() }, sb, { now: NOW });
    assert.equal(out.totals.stale, 1);
    assert.equal(out.totals.dup_in_run, 1);
    assert.equal(out.totals.inserted, 1);
  } finally { globalThis.fetch = orig; }
});

test('dry mode changes nothing', async () => {
  const sb = fakeSb();
  const { fn } = fakeFetch({ 'https://feed.test/rss': { status: 200, body: feedXml([{ title: 'Alex Pereira out of the main event', link: 'https://feed.test/a' }]) } });
  const orig = globalThis.fetch; globalThis.fetch = fn;
  try {
    const out = await runIngest({ UFC_NEWS_KV: fakeKV() }, sb, { now: NOW, dry: true });
    assert.equal(out.status, 'dry_run');
    assert.equal(out.would_insert.length, 1);
    assert.equal(sb.inserted.ufc_news_items.length, 0);
    assert.equal(sb.inserted.ufc_news_pipeline_events.length, 0);
  } finally { globalThis.fetch = orig; }
});
