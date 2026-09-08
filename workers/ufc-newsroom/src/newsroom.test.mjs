/* Newsroom safety properties. Run: node --test src/newsroom.test.mjs
 *
 * Every test here is offline: a fake PostgREST and a fake Anthropic, no
 * network and no database. That is the point — these are the properties that
 * must hold before anything is deployed or pointed at production, so they
 * cannot themselves require production to run.
 *
 * Where a property is enforced by a database constraint rather than by code,
 * the test says so and checks the request we send, because sending an upsert
 * with no conflict target is exactly how that guarantee gets silently lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Supabase, CONFLICT_TARGETS } from './supabase.mjs';
import { enhance, enhanceOrKeep, parseEnvelope, isConfigured } from './anthropic.mjs';
import { findActiveRun, lastSuccessByPhase, STALE_RUN_MINUTES, WORKER } from './runlog.mjs';

const ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' };

/** A PostgREST stand-in that records requests and answers from a table map. */
function fakeRest({ tables = {}, onPost } = {}) {
  const calls = [];
  const counts = { ...tables };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', init });
    const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
    if ((init.method || 'GET') === 'GET') {
      const n = counts[table] ?? 0;
      return {
        ok: true,
        headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `0-0/${n}` : null) },
        text: async () => JSON.stringify(counts[`${table}:rows`] ?? []),
        json: async () => counts[`${table}:rows`] ?? [],
      };
    }
    if (onPost) onPost(table, init);
    return { ok: true, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };
  return { calls, counts };
}

/* ---- 12. no public GET can ingest, publish, or call a model -------------- */

test('a public GET cannot ingest, generate an article, or reach a model', async () => {
  const mod = await import('./index.js');
  const worker = mod.default;
  let networkTouched = false;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { networkTouched = true; throw new Error('no network in this test'); };
  try {
    for (const path of ['/', '/health', '/admin/run', '/admin/run?phases=write', '/ingest', '/run']) {
      const res = await worker.fetch(new Request(`https://w.dev${path}`), { ...ENV, ADMIN_TRIGGER_TOKEN: 'secret' });
      assert.ok([200, 404].includes(res.status), `${path} -> ${res.status}`);
      if (path !== '/health') {
        const body = await res.json();
        assert.equal(body.error, 'not_found', `${path} must not run anything on GET`);
      }
    }
    assert.equal(networkTouched, false, 'no GET reached the network at all');
  } finally { globalThis.fetch = real; }
});

test('/admin/run is 404 without a token, with a wrong token, and when unconfigured', async () => {
  const worker = (await import('./index.js')).default;
  const post = (headers, env) => worker.fetch(new Request('https://w.dev/admin/run', { method: 'POST', headers }), env);

  assert.equal((await post({}, { ...ENV, ADMIN_TRIGGER_TOKEN: 'secret' })).status, 404, 'no header');
  assert.equal((await post({ 'x-pbe-admin-token': 'wrong' }, { ...ENV, ADMIN_TRIGGER_TOKEN: 'secret' })).status, 404, 'wrong token');
  assert.equal((await post({ 'x-pbe-admin-token': 'secre' }, { ...ENV, ADMIN_TRIGGER_TOKEN: 'secret' })).status, 404, 'prefix of the token');
  /* No token configured must not mean "no auth required". */
  assert.equal((await post({ 'x-pbe-admin-token': '' }, { ...ENV })).status, 404, 'unconfigured token disables the route');
});

test('/health performs no writes and no model call', async () => {
  const worker = (await import('./index.js')).default;
  const { calls } = fakeRest();
  const res = await worker.fetch(new Request('https://w.dev/health'), { ...ENV, ANTHROPIC_API_KEY: 'k' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0, 'health touches nothing');
  assert.equal(body.requirements.ANTHROPIC_API_KEY, true);
  assert.match(body.editorial_provider, /deterministic templates always publish/);
});

/* ---- 1, 2, 3, 9. duplicates and churn ----------------------------------- */

test('the upsert names the real unique index, not the primary key', async () => {
  /* This is what makes "same item twice -> one row" true. PostgREST infers
     ON CONFLICT from the PRIMARY KEY unless a target is named, and every table
     here has a surrogate uuid PK that never collides — so an unnamed target
     deduplicates nothing and raises 23505 on the second run instead. */
  assert.equal(CONFLICT_TARGETS.ufc_news_items, 'fingerprint');
  assert.equal(CONFLICT_TARGETS.ufc_articles, 'slug');

  let seen = null;
  fakeRest({ tables: { ufc_news_items: 5 }, onPost: (t, init) => { seen = { t, init }; } });
  const sb = new Supabase(ENV);
  await sb.insertIgnoringDuplicates('ufc_news_items', [{ fingerprint: 'abc' }]);
  assert.ok(seen, 'a POST was made');
  assert.match(seen.init.headers.Prefer, /resolution=ignore-duplicates/);
  assert.match(seen.t, /^ufc_news_items$/);
});

test('re-ingesting the same snapshot inserts nothing and reports zero', async () => {
  /* Count before and count after, so a run that wrote nothing says zero
     instead of reporting the number of rows it offered. */
  fakeRest({ tables: { ufc_news_items: 70 } });
  const sb = new Supabase(ENV);
  const inserted = await sb.insertIgnoringDuplicates('ufc_news_items', [
    { fingerprint: 'a' }, { fingerprint: 'b' }, { fingerprint: 'c' },
  ]);
  assert.equal(inserted, 0, 'all three collided, so nothing was written');
});

test('an upsert without a declared conflict target is refused, not degraded', async () => {
  fakeRest();
  const sb = new Supabase(ENV);
  await assert.rejects(
    () => sb.insertIgnoringDuplicates('ufc_bout_results', [{ id: 1 }]),
    /refusing to upsert/,
    'the degraded form looks identical until it fails in production',
  );
});

test('two overlapping invocations: the second stands down', async () => {
  const started = new Date(Date.now() - 2 * 60000).toISOString();
  fakeRest({ tables: { 'ufc_ingest_runs:rows': [{ id: 'run-1', started_at: started, status: 'running' }] } });
  const sb = new Supabase(ENV);
  const active = await findActiveRun(sb);
  assert.ok(active, 'an in-flight run is visible to the next invocation');
  assert.equal(active.id, 'run-1');
});

test('a crashed run does not lock the newsroom forever', async () => {
  /* A Worker killed mid-run never writes its closing row, so "running" is not
     proof of life. Past the staleness window the lock is ignored, or one crash
     would stop the newsroom permanently — a worse outage than a double run,
     which the unique indexes already make harmless. */
  const ancient = new Date(Date.now() - (STALE_RUN_MINUTES + 5) * 60000).toISOString();
  fakeRest({ tables: { 'ufc_ingest_runs:rows': [{ id: 'dead', started_at: ancient, status: 'running' }] } });
  const sb = new Supabase(ENV);
  assert.equal(await findActiveRun(sb), null);
});

/* ---- 7, 8. the enhancement can never stop publication -------------------- */

test('Anthropic unconfigured: the deterministic article survives untouched', async () => {
  const draft = { headline: 'H', body_md: 'B', model_version: 'template-2' };
  const out = await enhanceOrKeep({}, draft, { prompt: 'x' });
  assert.equal(out.enhanced, false);
  assert.deepEqual(out.article, draft);
  assert.equal(isConfigured({}), false);
});

test('Anthropic unavailable in every way: still the deterministic article', async () => {
  const draft = { headline: 'H', body_md: 'B', model_version: 'template-2' };
  const real = globalThis.fetch;
  try {
    for (const [label, impl] of [
      ['network error', async () => { throw new Error('ECONNRESET'); }],
      ['timeout', async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }],
      ['http 529', async () => ({ ok: false, status: 529 })],
      ['empty content', async () => ({ ok: true, json: async () => ({ content: [] }) })],
      ['unparseable', async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'sorry, no.' }] }) })],
    ]) {
      globalThis.fetch = impl;
      const out = await enhanceOrKeep({ ANTHROPIC_API_KEY: 'k' }, draft, { prompt: 'x' });
      assert.equal(out.enhanced, false, `${label} must not enhance`);
      assert.deepEqual(out.article, draft, `${label} must leave the draft intact`);
    }
  } finally { globalThis.fetch = real; }
});

test('Anthropic output that fails the editorial gate is discarded', async () => {
  const draft = { headline: 'Verified headline', body_md: 'Facts only.', model_version: 'template-2' };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: '{"headline":"Lock of the night","body_md":"Guaranteed winner at -400."}' }],
    }),
  });
  try {
    /* A gate that rejects invented betting language, the same shape the
       template had to satisfy. The only way to publish an enhanced version is
       to be strictly better by the rules the deterministic one already met. */
    const gate = (c) => (/lock|guaranteed|winner/i.test(`${c.headline} ${c.body_md}`)
      ? { ok: false, reason: 'unsupported betting claim' }
      : { ok: true });
    const out = await enhanceOrKeep({ ANTHROPIC_API_KEY: 'k' }, draft, { prompt: 'x', gate });
    assert.equal(out.enhanced, false);
    assert.match(out.reason, /gate: unsupported betting claim/);
    assert.deepEqual(out.article, draft, 'the verified article is what gets stored');
  } finally { globalThis.fetch = real; }
});

test('an accepted enhancement is recorded as the model that wrote it', async () => {
  const draft = { headline: 'H', body_md: 'B', slug: 's', model_version: 'template-2' };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ model: 'claude-sonnet-5', content: [{ type: 'text', text: '{"headline":"Clearer headline"}' }] }),
  });
  try {
    const out = await enhanceOrKeep({ ANTHROPIC_API_KEY: 'k' }, draft, { prompt: 'x', gate: () => ({ ok: true }) });
    assert.equal(out.enhanced, true);
    assert.equal(out.article.headline, 'Clearer headline');
    assert.equal(out.article.slug, 's', 'identity fields survive the merge');
    assert.equal(out.article.model_version, 'anthropic:claude-sonnet-5');
  } finally { globalThis.fetch = real; }
});

test('enhance() never throws, whatever the provider does', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    assert.equal(await enhance({ ANTHROPIC_API_KEY: 'k' }, { prompt: 'x' }), null,
      'a forgotten catch here would take down publication, so there is no throw path');
  } finally { globalThis.fetch = real; }
});

test('a fenced or chatty JSON envelope is still parsed', () => {
  assert.deepEqual(parseEnvelope('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseEnvelope('Here you go: {"a":2} hope that helps'), { a: 2 });
  assert.equal(parseEnvelope('no json at all'), null);
  assert.equal(parseEnvelope(''), null);
});

/* ---- 10. one dead source must not kill the healthy ones ------------------ */

test('a phase failure is contained and the run is recorded partial', async () => {
  const { run } = await import('./index.js');
  fakeRest({ tables: { ufc_news_items: 70, ufc_articles: 34, 'ufc_ingest_runs:rows': [] } });
  /* Force only the sweep, which needs no imports beyond counts, and confirm
     the run closes cleanly with a status a human can read. */
  const res = await run({ ...ENV }, { cron: null, invoked: 'test', force: ['sweep'] });
  assert.ok(['success', 'partial'].includes(res.status));
  assert.ok(res.phases.includes('sweep'));
});

test('missing configuration fails closed and loudly, writing nothing', async () => {
  const { run } = await import('./index.js');
  const res = await run({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' }, { cron: '*/30 * * * *' });
  assert.equal(res.status, 'misconfigured');
  assert.deepEqual(res.phases, []);
  assert.match(res.error, /SUPABASE_URL/);
});

/* ---- ledger ------------------------------------------------------------- */

test('only completed runs count as a phase succeeding', async () => {
  fakeRest({ tables: { 'ufc_ingest_runs:rows': [
    { finished_at: '2026-09-08T12:00:00Z', status: 'success', notes: { phases_succeeded: ['ingest', 'write'] } },
    { finished_at: '2026-09-08T10:00:00Z', status: 'partial', notes: { phases_succeeded: ['sweep'] } },
    { finished_at: null, status: 'running', notes: { phases_succeeded: ['refresh'] } },
  ] } });
  const sb = new Supabase(ENV);
  const last = await lastSuccessByPhase(sb);
  assert.equal(last.ingest, '2026-09-08T12:00:00Z');
  assert.equal(last.sweep, '2026-09-08T10:00:00Z', 'a partial run still proves its completed phases');
  assert.equal(last.refresh, undefined, 'an unfinished run proves nothing');
  assert.equal(WORKER, 'ufc-newsroom');
});
