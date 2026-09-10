/* Source verification and the editorial desk. Run: node --test src/sources_sweep.test.mjs
 *
 * Both of these were production behaviour that the first Worker draft dropped
 * or stubbed, and both failures are quiet ones — a newsroom missing them looks
 * like a newsroom having a slow week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySources } from '../../../scripts/news/seed_sources.mjs';

const quiet = { log: () => {} };
const ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };

/** Answer feed URLs from a map; anything unlisted is a dead feed. */
function fakeFeeds(map) {
  const real = globalThis.fetch;
  const headers = { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/rss+xml' : null) };
  globalThis.fetch = async (url) => {
    const body = map[String(url)];
    if (body === undefined) return { ok: false, status: 404, url: String(url), headers, text: async () => '' };
    if (body === 'throw') throw new Error('connection reset');
    return { ok: true, status: 200, url: String(url), headers, text: async () => body };
  };
  return () => { globalThis.fetch = real; };
}

const FEED = `<?xml version="1.0"?><rss><channel>
  <item><title>One</title><link>https://a.invalid/1</link><pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

/* ---- source verification ------------------------------------------------ */

test('a feed is verified before it is trusted, and an empty one is not', async () => {
  const restore = fakeFeeds({
    'https://good.invalid/feed': FEED,
    'https://empty.invalid/feed': '<?xml version="1.0"?><rss><channel></channel></rss>',
  });
  try {
    const r = await verifySources([
      { name: 'Good', urls: ['https://good.invalid/feed'], weight: 1 },
      { name: 'Empty', urls: ['https://empty.invalid/feed'], weight: 1 },
    ], quiet);
    assert.deepEqual(r.chosen.map((c) => c.name), ['Good']);
    assert.deepEqual(r.dropped, ['Empty'], 'a feed that parses to nothing is not a source');
  } finally { restore(); }
});

test('a known alternate URL is used when the first one has moved', async () => {
  /* Two of the five real sources already carry an alternate for this reason.
   * Losing this would silently halve the newsroom's inputs. */
  const restore = fakeFeeds({ 'https://site.invalid/rss/index.xml': FEED });
  try {
    const r = await verifySources([
      { name: 'Moved', urls: ['https://site.invalid/rss/current', 'https://site.invalid/rss/index.xml'], weight: 1 },
    ], quiet);
    assert.equal(r.chosen.length, 1);
    assert.equal(r.chosen[0].url, 'https://site.invalid/rss/index.xml');
    assert.equal(r.attempts.length, 2, 'the first URL was tried before the fallback');
  } finally { restore(); }
});

test('one dead source does not stop the healthy ones', async () => {
  const restore = fakeFeeds({ 'https://ok.invalid/feed': FEED, 'https://boom.invalid/feed': 'throw' });
  try {
    const r = await verifySources([
      { name: 'Boom', urls: ['https://boom.invalid/feed'], weight: 1 },
      { name: 'Ok', urls: ['https://ok.invalid/feed'], weight: 1 },
      { name: 'Gone', urls: ['https://gone.invalid/feed'], weight: 1 },
    ], quiet);
    assert.deepEqual(r.chosen.map((c) => c.name), ['Ok'], 'the healthy source still lands');
    assert.deepEqual(r.dropped.sort(), ['Boom', 'Gone'], 'and the failures are explicit, not thrown');
  } finally { restore(); }
});

test('source state is explicit: verified, dropped and disabled are counted', async () => {
  const restore = fakeFeeds({ 'https://ok.invalid/feed': FEED });
  try {
    const r = await verifySources([{ name: 'Ok', urls: ['https://ok.invalid/feed'], weight: 1 }], quiet);
    assert.equal(typeof r.chosen[0].enabled, 'boolean');
    assert.equal(r.chosen[0].enabled, true);
    assert.equal(r.chosen[0].kind, 'rss');
  } finally { restore(); }
});

/* ---- the editorial desk ------------------------------------------------- */

/* The editorial-desk half of this file moved to ufc-event-editorial with the
 * polish pass it covers. What remains is feed-registry verification, which is
 * still this Worker's: it maintains the source list the ingest lane reads. */
