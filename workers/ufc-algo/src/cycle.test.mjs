// Scheduler gates. Runs the real cycle module against a fake PostgREST that
// records every write, so "dry_run writes nothing but its run row" and "armed
// refuses without a live, hash-verified model" are behaviour, not intent.
// Bundler-only imports (the JSON artifact) are loaded through a Node loader hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return next(url, context);
}`), pathToFileURL('./'));

const { runCycle, gradeFor, lockWindow, band, resolveModel } = await import('./cycle.js');
const { FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } = await import('../../../scripts/model/feature_spec.mjs');

function fakeDb({ versions = [], events = [] } = {}) {
  const writes = [];
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname.replace('/rest/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') writes.push({ method, path, body });
    if (method === 'POST' && path === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
    if (method === 'PATCH' && path === 'ufc_model_runs') return new Response(null, { status: 204 });
    if (path === 'ufc_model_versions') return ok(versions);
    if (path === 'ufc_events') return ok(events);
    return ok([]);
  };
  return { writes, handler };
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const env = (over = {}) => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ALGO_MODE: 'dry_run', ...over });

function registered({ status = 'live', tamper = false } = {}) {
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 5) * 0.1 - 0.2]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const canonical = JSON.stringify({ model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 2 });
  const spec = createHash('sha256').update(canonical).digest('hex');
  if (tamper) coefficients[FEATURE_KEYS[0]] = 9;
  return { model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, status, coefficients, feature_scale, spec_sha256: spec, hyperparameters: { lambda: 2 } };
}

test('dry_run writes only its run row, even when env says armed but the request does not', async () => {
  for (const e of [env(), env({ ALGO_MODE: 'armed' })]) {
    const f = fakeDb({ events: [] });
    const r = await withFetch(f.handler, () => runCycle(e, { trigger: 'admin', mode: 'dry_run' }));
    assert.equal(r.mode, 'dry_run');
    assert.deepEqual(f.writes.map((w) => `${w.method} ${w.path}`), ['POST ufc_model_runs', 'PATCH ufc_model_runs']);
  }
});

test('armed requires BOTH env ALGO_MODE=armed and the request; otherwise it is a dry run', async () => {
  const f = fakeDb({ versions: [registered()] });
  const r = await withFetch(f.handler, () => runCycle(env({ ALGO_MODE: 'dry_run' }), { trigger: 'admin', mode: 'armed' }));
  assert.equal(r.mode, 'dry_run');
});

test('armed with no registered model is BLOCKED and writes nothing but the run ledger', async () => {
  const f = fakeDb({ versions: [] });
  const r = await withFetch(f.handler, () => runCycle(env({ ALGO_MODE: 'armed' }), { trigger: 'cron', mode: 'armed' }));
  assert.equal(r.blocked, 'no registered live model version');
  assert.deepEqual(f.writes.map((w) => `${w.method} ${w.path}`), ['POST ufc_model_runs', 'PATCH ufc_model_runs']);
  assert.equal(f.writes[1].body.status, 'blocked');
});

test('a registered candidate (not live) or a tampered coefficient row blocks armed mode', async () => {
  for (const [row, why] of [[registered({ status: 'candidate' }), /not live/], [registered({ tamper: true }), /does not re-hash/]]) {
    const f = fakeDb({ versions: [row] });
    const r = await withFetch(f.handler, () => runCycle(env({ ALGO_MODE: 'armed' }), { trigger: 'cron', mode: 'armed' }));
    assert.match(r.blocked, why);
    assert.ok(!f.writes.some((w) => /ufc_model_(predictions|bout_evaluations|prediction_grades)|rpc\//.test(w.path)));
  }
});

test('a live, hash-verified registry row is accepted', async () => {
  const f = fakeDb({ versions: [registered()] });
  const m = await withFetch(f.handler, async () => resolveModel((await import('./supabase.js')).db(env()), 'armed'));
  assert.equal(m.live, true);
  assert.equal(m.source, 'registry');
});

test('grading: result-bound WIN/LOSS/DRAW/NC, VOID only without a result, never a guess', () => {
  const p = { pick_fighter_id: 'a', fighter_a_id: 'a', fighter_b_id: 'b' };
  assert.deepEqual(gradeFor(p, { winner_id: 'a', method: 'KO_TKO' }), { result: 'WIN', winner_id: 'a' });
  assert.deepEqual(gradeFor(p, { winner_id: 'b', method: 'DEC_U' }), { result: 'LOSS', winner_id: 'b' });
  assert.deepEqual(gradeFor(p, { winner_id: null, method: 'DRAW' }), { result: 'DRAW', winner_id: null });
  assert.deepEqual(gradeFor(p, { winner_id: null, method: 'NC' }), { result: 'NC', winner_id: null });
  assert.equal(gradeFor(p, { winner_id: 'zzz', method: 'SUB' }), null, 'winner is neither corner');
  assert.equal(gradeFor(p, { winner_id: null, method: 'DEC_S' }), null, 'decision without a winner');
  assert.deepEqual(gradeFor(p, null, { status: 'cancelled', event_complete: false }), { result: 'VOID', winner_id: null });
  assert.deepEqual(gradeFor(p, null, { status: 'announced', event_complete: true }), { result: 'VOID', winner_id: null });
  assert.equal(gradeFor(p, null, { status: 'announced', event_complete: false }), null, 'still pending');
});

test('lock window: opens 8h before the event day, closes at the 6h database floor', () => {
  const at = (iso) => lockWindow('2026-09-19', Date.parse(iso)).open;
  assert.equal(at('2026-09-18T15:59:59Z'), false);
  assert.equal(at('2026-09-18T16:00:00Z'), true);
  assert.equal(at('2026-09-18T17:41:00Z'), true);
  assert.equal(at('2026-09-18T18:00:00Z'), false);
  assert.equal(band(0.644), '60-65');
  assert.equal(band(0.2), '80-100');
});

test('market provenance reports when the consensus prices were taken, never the run time', async () => {
  const { marketProvenance } = await import('./cycle.js');
  const o = (book, side, price, obs, upd) => ({ market_key: 'h2h', bookmaker_key: book, outcome_fighter_id: side, price, observed_at: obs, source_last_update: upd });
  const rows = [
    o('dk', 'a', 455, '2026-09-08T12:25:03Z', '2026-09-08T12:22:17Z'),
    o('dk', 'b', -625, '2026-09-08T12:25:03Z', '2026-09-08T12:22:17Z'),
    o('fd', 'a', 360, '2026-09-08T12:25:03Z', '2026-09-08T12:22:41Z'),
    o('fd', 'a', 380, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z'), // after the run: ignored
  ];
  const p = marketProvenance(rows, '2026-09-14T22:57:48Z');
  assert.equal(p.observed_at, '2026-09-08T12:25:03Z');
  assert.equal(p.oldest_book_update, '2026-09-08T12:22:17Z');
  assert.equal(p.age_hours, 154.5);
  assert.equal(marketProvenance([], '2026-09-14T00:00:00Z'), null);
});

test('after a promotion: locked calls of the old version never move; its unlocked drafts are withdrawn; nothing locked is patched', async () => {
  const v1 = { ...registered(), status: 'retired' };
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 3) * 0.05]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const canonical = JSON.stringify({ model_version: 'pbe-fight-model-v1.1', feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 5 });
  const v11 = { model_version: 'pbe-fight-model-v1.1', model_family: 'pbe-fight-model', feature_version: FEATURE_VERSION, status: 'live', coefficients, feature_scale, spec_sha256: createHash('sha256').update(canonical).digest('hex'), hyperparameters: { lambda: 5 } };
  const eventDate = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
  const event = { id: 'e1', name: 'UFC 999: Test', event_date: eventDate, card_status: 'announced' };
  const bout = (id, a, b) => ({ id, event_id: 'e1', fighter_a_id: a, fighter_b_id: b, weight_class: 'LW', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: 1, status: 'announced' });
  const bouts = [bout('bx', 'f1', 'f2'), bout('by', 'f3', 'f4')];
  const preds = [
    { id: 'px', bout_id: 'bx', locked_at: '2026-09-18T16:41:00Z', model_version: MODEL_VERSION, prob_a: 0.6, pick_probability: 0.6 },
    { id: 'py', bout_id: 'by', locked_at: null, model_version: MODEL_VERSION, prob_a: 0.58, pick_probability: 0.58 },
  ];
  const writes = [];
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname.replace('/rest/v1/', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') writes.push({ method, path, query: u.search, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'POST' && path === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (path === 'ufc_model_versions') return ok([v1, v11]);
    if (path === 'ufc_events') return ok([event]);
    if (path === 'ufc_bouts') return ok(u.searchParams.has('or') ? [] : bouts);
    if (path === 'ufc_fighters') return ok(['f1', 'f2', 'f3', 'f4'].map((id) => ({ id, name: id })));
    if (path === 'ufc_model_predictions') return ok(preds);
    return ok([]);
  };
  const r = await withFetch(handler, () => runCycle(env({ ALGO_MODE: 'armed' }), { trigger: 'cron', mode: 'armed' }));
  assert.equal(r.model.model_version, 'pbe-fight-model-v1.1', 'the live champion is resolved from the registry');
  const predWrites = writes.filter((w) => w.path === 'ufc_model_predictions');
  assert.deepEqual(predWrites.map((w) => `${w.method} ${decodeURIComponent(w.query)}`), ['DELETE ?id=eq.py&locked_at=is.null'], 'only the old unlocked draft is withdrawn');
  assert.equal(writes.filter((w) => w.path.startsWith('rpc/ufc_model_publish')).length, 0);
  const bx = r.cards[0].bouts.find((b) => b.bout_id === 'bx');
  assert.equal(bx.locked_model_version, MODEL_VERSION, 'the locked call stays with the version that made it');
  assert.equal(r.writes.drafts_withdrawn, 1);
});

test('dry run with an active challenger: shadow is reported, nothing but the run ledger is written, V1 stays champion', async () => {
  const { CHALLENGER_LABEL } = await import('./learning/core.js');
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 2) * 0.07]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const spec = createHash('sha256').update(JSON.stringify({ model_version: CHALLENGER_LABEL, feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 5 })).digest('hex');
  const challenger = { id: 'run-c', created_at: '2026-09-15T12:20:00Z', status: 'CHALLENGER', parent_model_version: MODEL_VERSION, superseded_at: null, spec_sha256: spec, coefficients, feature_scale, hyperparameters: { lambda: 5 }, leakage_audit: { all_passed: true }, training_bouts: 9192 };
  const eventDate = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
  const writes = [];
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname.replace('/rest/v1/', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (method === 'POST' && path === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (path === 'ufc_model_versions') return ok([registered()]);
    if (path === 'ufc_model_training_runs') return ok([challenger]);
    if (path === 'ufc_events') return ok([{ id: 'e1', name: 'UFC 999: Test', event_date: eventDate }]);
    if (path === 'ufc_bouts') return ok(u.searchParams.has('or') ? [] : [{ id: 'b1', event_id: 'e1', fighter_a_id: 'f1', fighter_b_id: 'f2', weight_class: 'LW', bout_order: 1, status: 'announced' }]);
    if (path === 'ufc_fighters') return ok([{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }]);
    return ok([]);
  };
  const r = await withFetch(handler, () => runCycle(env({ ALGO_MODE: 'armed' }), { trigger: 'admin', mode: 'dry_run' }));
  assert.equal(r.mode, 'dry_run');
  assert.equal(r.model.model_version, MODEL_VERSION);
  assert.equal(r.challenger.training_run_id, 'run-c');
  assert.ok(r.cards[0].bouts[0].shadow, 'shadow call reported');
  assert.deepEqual(writes, ['POST ufc_model_runs', 'PATCH ufc_model_runs']);
});

test('armed: a failing shadow track (read, write, lock, grade) never fails or blocks the official cycle', async () => {
  const { CHALLENGER_LABEL } = await import('./learning/core.js');
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 2) * 0.07]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const spec = createHash('sha256').update(JSON.stringify({ model_version: CHALLENGER_LABEL, feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 5 })).digest('hex');
  const challenger = { id: 'run-c', created_at: '2026-09-15T12:20:00Z', status: 'CHALLENGER', parent_model_version: MODEL_VERSION, superseded_at: null, spec_sha256: spec, coefficients, feature_scale, hyperparameters: { lambda: 5 }, leakage_audit: { all_passed: true } };
  const eventDate = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
  for (const failing of ['read', 'write']) {
    const writes = [];
    const handler = async (url, init = {}) => {
      const u = new URL(url);
      const method = (init.method || 'GET').toUpperCase();
      const path = u.pathname.replace('/rest/v1/', '');
      const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
      if (method !== 'GET') writes.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
      if (path.startsWith('ufc_model_shadow') && (failing === 'read' || method !== 'GET')) return new Response('boom', { status: 500 });
      if (method === 'POST' && path === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
      if (method !== 'GET') return new Response(null, { status: 204 });
      if (path === 'ufc_model_versions') return ok([registered()]);
      if (path === 'ufc_model_training_runs') return ok([challenger]);
      if (path === 'ufc_events') return ok([{ id: 'e1', name: 'UFC 999: Test', event_date: eventDate }]);
      if (path === 'ufc_bouts') return ok(u.searchParams.has('or') ? [] : [{ id: 'b1', event_id: 'e1', fighter_a_id: 'f1', fighter_b_id: 'f2', weight_class: 'LW', bout_order: 1, status: 'announced' }]);
      if (path === 'ufc_fighters') return ok([{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }]);
      if (path === 'ufc_model_predictions') return ok([{ id: 'pl', bout_id: 'old', locked_at: '2026-09-01T00:00:00Z', model_version: MODEL_VERSION, pick_fighter_id: 'f1', fighter_a_id: 'f1', fighter_b_id: 'f2' }]);
      return ok([]);
    };
    const r = await withFetch(handler, () => runCycle(env({ ALGO_MODE: 'armed' }), { trigger: 'cron', mode: 'armed' }));
    assert.equal(r.error, undefined, `${failing}: ${r.error}`);
    assert.equal(r.writes.evaluations, 1, 'the official evaluation was still written');
    assert.ok(r.writes.shadow.errors.length >= 1, 'the shadow failure is reported');
    const fin = writes.filter((w) => w.path === 'ufc_model_runs' && w.method === 'PATCH').pop();
    assert.equal(fin.body.status, 'ok');
  }
});
