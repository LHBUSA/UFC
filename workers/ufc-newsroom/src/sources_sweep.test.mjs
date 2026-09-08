/* Source verification and the editorial desk. Run: node --test src/sources_sweep.test.mjs
 *
 * Both of these were production behaviour that the first Worker draft dropped
 * or stubbed, and both failures are quiet ones — a newsroom missing them looks
 * like a newsroom having a slow week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySources } from '../../../scripts/news/seed_sources.mjs';
import { providersFor, resolveOptions as deskOptions } from '../../../scripts/news/polish_world_class.mjs';
import { runSweep } from './phases.mjs';

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

test('the Worker never offers the Copilot provider, however many tokens it holds', () => {
  /* A Worker cannot spawn a process. Treating a token as a provider would make
   * the desk try a path that cannot exist and report a fallback it never had. */
  const withToken = { ANTHROPIC_API_KEY: '', GITHUB_TOKEN: 'ghs_x', COPILOT_GITHUB_TOKEN: 'ghs_y' };
  assert.deepEqual(providersFor(withToken, { allowCopilot: false }), { anthropic: false, copilot: false });
  assert.deepEqual(providersFor(withToken, { allowCopilot: true }), { anthropic: false, copilot: true },
    'the CLI, which can spawn, still gets it');
});

test('the desk is deterministic when no model is configured, and does not fail the run', async () => {
  const sb = { count: async () => 3 };
  const r = await runSweep(ENV, sb, { now: Date.now() });
  assert.equal(r.status, 'no_provider');
  assert.equal(r.review_queue, 3, 'it still reports the review queue');
  assert.match(r.note, /Publication does not depend on it/);
});

test('the sweep runs the real desk when a key is present', async () => {
  /* The old sweep returned status:'reporting_only' and called nothing. This
   * asserts the actual editorial code runs: it must query candidates and, on a
   * clean pass, report having done so. */
  const real = globalThis.fetch;
  let queried = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('ufc_articles') && (init.method || 'GET') === 'GET') {
      queried = u;
      return { ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-range' ? '0-0/0' : null) }, text: async () => '[]', json: async () => [] };
    }
    throw new Error(`unexpected call ${u}`);
  };
  try {
    const sb = { count: async () => 0 };
    const r = await runSweep({ ...ENV, ANTHROPIC_API_KEY: 'k' }, sb, { now: Date.parse('2026-09-08T12:00:00Z'), recentHours: 24 });
    assert.equal(r.status, 'ran', 'the desk actually ran rather than reporting on itself');
    assert.match(r.provider, /^anthropic:/);
    assert.ok(!/copilot/.test(r.provider), 'and offered no fallback it cannot use');
    assert.match(queried, /status=eq\.published/, 'candidates are published articles');
    assert.match(queried, /2026-09-07T12/, 'the window is measured from the invocation clock');
  } finally { globalThis.fetch = real; }
});

test('the desk window and limit are bounded per invocation', () => {
  assert.equal(deskOptions({ limit: 500 }).limit, 60, 'a runaway limit is clamped');
  assert.equal(deskOptions({ limit: 0 }).limit, 30, 'and a missing one falls back to the default');
  assert.equal(deskOptions({ recentHours: 99999 }).recentHours, 1440);
});
