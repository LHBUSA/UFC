// V2 research shadow: isolation, invariants and V1 output parity.
//   node --test workers/ufc-algo/src/research/v2shadow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return next(url, context);
}`), pathToFileURL('./'));

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..');
const V = await import('./v2shadow.js');
const { runCycle } = await import('../cycle.js');
const { FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } = await import('../../../../scripts/model/feature_spec.mjs');
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/model/v2/artifacts/pbe-fight-model-v2-candidate-elo.json'), 'utf8'));
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/* ------------------------------------------------------------- the model */

test('the bundled V2 artifact re-hashes to the frozen spec; a tampered coefficient is refused', async () => {
  const spec = await V.v2Spec();
  assert.equal(spec.spec_sha256, 'cc84aa7c2ece16e5b499b9e1f0a7cee6863193d3078adaaaccc0584de518d029');
  assert.equal(spec.model_version, 'pbe-fight-model-v2-candidate-elo');
  assert.equal(spec.feature_version, 'pbe-fight-features-v2-elo');
  assert.equal(artifact.training.dataset_sha256, 'c174ca8f76a090f6f9f4ec9cc40321125125441a98777c59f2b6e3412f55c73b');
  assert.equal(spec.beta.length, FEATURE_KEYS.length + 1);
  const tampered = structuredClone(artifact);
  tampered.coefficients.elo_diff += 1e-9;
  await assert.rejects(() => V.v2Spec(tampered), /does not re-hash/);
});

test('frozen policy: primary >=60%, debut never evaluable, tier variant recorded but separate', async () => {
  const { policy } = await V.v2Spec();
  assert.equal(policy.primary.min_pick_probability, 0.60);
  assert.equal(policy.debut_corner, 'no_call');
  const d = (p, prior, ev = true) => V.policyDecisions(policy, p, prior, ev);
  assert.deepEqual(d(0.58, 4), { publish_v1_rule_55: true, publish_primary_60: false, publish_variant_tiers: false });
  assert.deepEqual(d(0.61, 7), { publish_v1_rule_55: true, publish_primary_60: true, publish_variant_tiers: true });
  assert.equal(d(0.63, 4).publish_variant_tiers, false, '3-5 tier needs 65%');
  assert.deepEqual(d(0.9, 4, false), { publish_v1_rule_55: false, publish_primary_60: false, publish_variant_tiers: false }, 'outside the universe nothing publishes');
  assert.equal(V.evaluable({ decision: 'ELIGIBLE', reasons: [] }), true);
  assert.equal(V.evaluable({ decision: 'NO_MODEL_CALL', reasons: ['LOW_CONFIDENCE'] }), true, 'V1 below 55% is still paired');
  assert.equal(V.evaluable({ decision: 'NO_MODEL_CALL', reasons: ['DEBUT_CORNER'] }), false);
  assert.equal(V.evaluable({ decision: 'NO_MODEL_CALL', reasons: ['DEBUT_CORNER', 'LOW_CONFIDENCE'] }), false);
});

const track = async (ratings = { aa: [1600, 5], bb: [1450, 3] }) => ({ registered: true, run_id: 'v2-run', spec: await V.v2Spec(), elo: { key: 'learning/elo/2026-10-08.json', sha256: 'e'.repeat(64), body: { version: 'pbe-elo-v1', as_of: '2026-10-08', ratings } } });
const row = (x = FEATURE_KEYS.map((_, i) => ((i % 7) - 3) * 0.1)) => ({ fighter_1_id: 'aa', fighter_2_id: 'bb', x, min_prior_bouts: 4, min_stat_bouts: 3, available_count: 31 });

test('V2 call: exactly complementary under a corner swap, Elo unrounded, V1 pair recorded', async () => {
  const t = await track();
  const bout = { id: 'b', fighter_a_id: 'aa', fighter_b_id: 'bb', scheduled_rounds: 5, is_title: false };
  const c = V.v2Call({ track: t, row: row(), bout, decision: { decision: 'ELIGIBLE', reasons: [] }, v1: { source: 'cycle', p1: 0.62 }, market: null });
  const swappedT = await track({ aa: [1450, 3], bb: [1600, 5] });
  const s = V.v2Call({ track: swappedT, row: row(row().x.map((v) => -v)), bout, decision: { decision: 'ELIGIBLE', reasons: [] }, v1: { source: 'cycle', p1: 0.38 }, market: null });
  assert.ok(Math.abs(c.policy.v2.prob_a + s.policy.v2.prob_a - 1) < 1e-8);
  assert.equal(c.feature_vector.elo_diff, 1.5);
  assert.equal(c.policy.v1.pick_probability, 0.62);
  assert.equal(c.policy.context.five_round_non_title, true);
  assert.equal(c.decision, 'ELIGIBLE');
  const debut = V.v2Call({ track: t, row: row(), bout, decision: { decision: 'NO_MODEL_CALL', reasons: ['DEBUT_CORNER'] }, v1: { source: 'cycle', p1: 0.7 } });
  assert.equal(debut.decision, 'NO_MODEL_CALL');
  assert.equal(debut.pick_fighter_id, null);
  assert.equal(debut.policy.v2.publish_primary_60, false);
});

/* ------------------------------------------------------------- isolation */

test('isolation (static): V2 writes only the shadow table and its lock RPC; never an official table', () => {
  const src = strip(fs.readFileSync(path.join(here, 'v2shadow.js'), 'utf8'));
  for (const banned of ['ufc_model_predictions', 'ufc_model_prediction_grades', 'ufc_model_bout_evaluations', 'ufc_model_versions', 'ufc_model_publish', 'ufc_model_promote', 'ufc_articles', 'market_intel', 'kalshi', 'polymarket']) {
    assert.ok(!src.includes(banned), `v2shadow.js references ${banned}`);
  }
  const posts = [...src.matchAll(/q\.(post|patch|del|rpc)\(\s*[`'"]([^`'"$?]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  const tables = [...src.matchAll(/q\.(post|patch|del)\(\s*`\$\{(\w+)\}/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(posts)], ['rpc ufc_model_lock_shadow']);
  assert.deepEqual([...new Set(tables)], ['V2_TABLE']);
  assert.equal(V.V2_TABLE, 'ufc_model_shadow_predictions');
});

test('isolation (static): learning, review and promotion never select a RESEARCH_SHADOW run', () => {
  const daily = fs.readFileSync(path.join(here, '..', 'learning', 'daily.js'), 'utf8');
  for (const m of daily.matchAll(/ufc_model_training_runs\?[^`]*/g)) {
    const q = m[0];
    if (/status=/.test(q)) assert.match(q, /status=(eq\.CHALLENGER|in\.\(CHALLENGER,DATA_REPAIR_DRIFT\))/, q);
  }
  const review = strip(fs.readFileSync(path.join(here, '..', 'learning', 'review.js'), 'utf8'));
  assert.ok(!review.includes('RESEARCH_SHADOW'));
  assert.match(review, /training_run_id=eq\.\$\{challengerRunId\}/, 'paired review reads only the challenger run');
});

test('isolation (static): no public surface reads shadow rows or knows the V2 track', () => {
  const dirs = ['web/app', 'web/lib', 'web/components', 'workers/ufc-api', 'workers/ufc-news-enrich', 'workers/ufc-newsroom', 'workers/ufc-event-editorial', 'workers/ufc-fight-state', 'workers/ufc-simulator'];
  const hits = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|tsx?|json)$/.test(e.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (/ufc_model_shadow|ufc_model_training_runs|RESEARCH_SHADOW|v2-candidate|v2-research-shadow|pbe-fight-features-v2/.test(strip(s))) hits.push(path.relative(ROOT, p));
      }
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  assert.deepEqual(hits, []);
});

/* ------------------------------------------------- V1 output parity (behavioural) */

function registeredV1() {
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 5) * 0.1 - 0.2]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const canonical = JSON.stringify({ model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 2 });
  return { model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, status: 'live', coefficients, feature_scale, spec_sha256: createHash('sha256').update(canonical).digest('hex'), hyperparameters: { lambda: 2 } };
}

async function armedCycle({ v2Registered, failV2 = false }) {
  const spec = await V.v2Spec();
  const eventDate = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
  const writes = [];
  const r2 = new Map();
  const bucket = { get: async (k) => (r2.has(k) ? { text: async () => r2.get(k).body, customMetadata: r2.get(k).meta } : null), head: async (k) => (r2.has(k) ? {} : null), put: async (k, body, o) => { if (failV2) throw new Error('r2 down'); r2.set(k, { body, meta: o.customMetadata }); writes.push({ method: 'R2PUT', path: k }); } };
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const p = u.pathname.replace('/rest/v1/', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') writes.push({ method, path: p, query: decodeURIComponent(u.search), body: init.body ? JSON.parse(init.body) : null });
    if (method === 'POST' && p === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
    if (method === 'POST' && p === 'ufc_model_shadow_predictions') return ok([{ id: 'sh-1' }]);
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (p === 'ufc_model_versions') return ok([registeredV1()]);
    if (p === 'ufc_model_training_runs') return ok(u.searchParams.get('status') === 'eq.RESEARCH_SHADOW' && v2Registered ? [{ id: 'v2-run', status: 'RESEARCH_SHADOW', spec_sha256: spec.spec_sha256 }] : []);
    if (p === 'ufc_events') return ok(u.searchParams.has('event_date') ? [{ id: 'e1', name: 'UFC 999: Test', event_date: eventDate }] : [{ id: 'e0', event_date: '2020-01-01' }]);
    if (p === 'ufc_bouts') {
      if (u.searchParams.has('or')) return ok([]);
      if (u.searchParams.get('select') === 'id,event_id,fighter_a_id,fighter_b_id') return ok(failV2 ? [] : [{ id: 'old', event_id: 'e0', fighter_a_id: 'f1', fighter_b_id: 'f9' }]);
      return ok([{ id: 'b1', event_id: 'e1', fighter_a_id: 'f1', fighter_b_id: 'f2', weight_class: 'LW', bout_order: 1, status: 'announced', scheduled_rounds: 3 }]);
    }
    if (p === 'ufc_bout_results') return ok(u.searchParams.get('select') === 'bout_id,winner_id,method' ? [{ bout_id: 'old', winner_id: 'f1', method: 'KO_TKO' }] : []);
    if (p === 'ufc_fighters') return ok([{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }]);
    return ok([]);
  };
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    const r = await runCycle({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ALGO_MODE: 'armed', ARTIFACTS: bucket }, { trigger: 'cron', mode: 'armed' });
    return { r, writes };
  } finally { globalThis.fetch = real; }
}

const OFFICIAL = /^(ufc_model_predictions|ufc_model_prediction_grades|ufc_model_bout_evaluations|ufc_model_versions|rpc\/ufc_model_publish|rpc\/ufc_model_promote)/;
const officialWrites = (ws) => ws.filter((w) => OFFICIAL.test(w.path)).map((w) => JSON.stringify({ m: w.method, p: w.path, q: w.query, b: w.body && { ...w.body, run_id: undefined } }));

test('V1 OUTPUT PARITY: the official writes of an armed cycle are identical with and without the V2 track', async () => {
  const without = await armedCycle({ v2Registered: false });
  const withV2 = await armedCycle({ v2Registered: true });
  assert.ok(officialWrites(without.writes).length >= 1, 'the fixture produces official writes');
  assert.deepEqual(officialWrites(withV2.writes), officialWrites(without.writes));
  assert.equal(without.r.research_shadow.registered, false);
  assert.equal(withV2.r.research_shadow.registered, true);
  /* Everything V2 wrote is the shadow table or the Elo artifact - nothing else. */
  const v2Only = withV2.writes.filter((w) => !without.writes.some((x) => x.method === w.method && x.path === w.path));
  assert.ok(v2Only.length >= 1);
  for (const w of v2Only) assert.match(`${w.method} ${w.path}`, /^(POST ufc_model_shadow_predictions|PATCH ufc_model_shadow_predictions|POST rpc\/ufc_model_lock_shadow|R2PUT learning\/elo\/\d{4}-\d{2}-\d{2}\.json)$/);
  const shadowRow = withV2.writes.find((w) => w.path === 'ufc_model_shadow_predictions' && w.method === 'POST');
  assert.equal(shadowRow.body.training_run_id, 'v2-run');
  assert.equal(shadowRow.body.challenger_spec_sha256, 'cc84aa7c2ece16e5b499b9e1f0a7cee6863193d3078adaaaccc0584de518d029');
  assert.ok(shadowRow.body.policy && shadowRow.body.policy.track === 'v2-research-shadow');
});

test('a failing V2 track never fails, delays or alters the official cycle', async () => {
  const ok = await armedCycle({ v2Registered: false });
  const bad = await armedCycle({ v2Registered: true, failV2: true });
  assert.equal(bad.r.error, undefined);
  assert.deepEqual(officialWrites(bad.writes), officialWrites(ok.writes));
  assert.ok(bad.r.writes.research_shadow.errors.length >= 1);
  const fin = bad.writes.filter((w) => w.path === 'ufc_model_runs' && w.method === 'PATCH').pop();
  assert.equal(fin.body.status, 'ok');
});
