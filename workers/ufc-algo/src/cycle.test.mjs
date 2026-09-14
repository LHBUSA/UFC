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
