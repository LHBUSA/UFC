/* The editorial desk, moved from ufc-newsroom with the polish pass.
 *
 * The desk is not on the publication path -- an article publishes without it
 * -- so the guarantee here is that a missing or failing provider degrades
 * quality and never availability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { providersFor, resolveOptions as deskOptions } from '../../../scripts/news/polish_world_class.mjs';
import { main as polishArticles } from '../../../scripts/news/polish_world_class.mjs';

/* phases.runSweep was a wrapper that counted the review queue and then ran
 * the desk. The counting moved to the Worker; the desk behaviour asserted
 * below is the part that matters and is addressed directly. */
const deskRun = (env, _sb, opts = {}) => polishArticles(env, { maxPolish: 1, ...opts });
const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

test('the Worker never offers the Copilot provider, however many tokens it holds', () => {
  /* A Worker cannot spawn a process. Treating a token as a provider would make
   * the desk try a path that cannot exist and report a fallback it never had. */
  const withToken = { ANTHROPIC_API_KEY: '', GITHUB_TOKEN: 'ghs_x', COPILOT_GITHUB_TOKEN: 'ghs_y' };
  assert.deepEqual(providersFor(withToken, { allowCopilot: false }), { anthropic: false, copilot: false });
  assert.deepEqual(providersFor(withToken, { allowCopilot: true }), { anthropic: false, copilot: true },
    'the CLI, which can spawn, still gets it');
});

test('the desk is deterministic when no model is configured, and does not fail the run', async () => {
  const r = await deskRun(ENV, null, { now: Date.now() });
  assert.equal(r.status, 'no_provider', 'no provider is a reported state, not a thrown error');
  assert.equal(r.provider, null);
  assert.equal(r.passed, 0);
  /* review_queue used to be asserted here. It was produced by the runSweep
   * WRAPPER, which counted the queue before calling the desk; the wrapper moved
   * into this Worker and the count with it. The property that actually matters
   * -- a missing provider degrades quality and never availability -- is what is
   * asserted now, against the desk itself. */
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
    const r = await deskRun({ ...ENV, ANTHROPIC_API_KEY: 'k' }, sb, { now: Date.parse('2026-09-08T12:00:00Z'), recentHours: 24 });
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
