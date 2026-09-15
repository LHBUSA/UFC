// Daily learning + weekly promotion: the owner's critical properties as tests
// (design section 11). Pure core on synthetic data; orchestration against an
// in-memory PostgREST/R2 double that records every write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = await import('./core.js');
const { resolveChampion, specCanonical, sha256Hex } = await import('../champion.js');
const D = await import('./daily.js');
const R = await import('./review.js');
const { FEATURE_KEYS, FEATURE_VERSION } = await import('../../../../scripts/model/feature_spec.mjs');

/* ------------------------------------------------------------ fixtures */

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TRUE_BETA = FEATURE_KEYS.map((_, i) => (i % 4 === 0 ? 0.35 : i % 4 === 1 ? -0.2 : 0));

function synthetic(n = 4200, seed = 7, { from = 2005, to = 2026 } = {}) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const year = from + Math.floor((i / n) * (to - from + 1));
    const date = `${year}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
    const x = FEATURE_KEYS.map(() => Math.round((r() * 2 - 1) * 1e6) / 1e6);
    const z = x.reduce((a, v, j) => a + v * TRUE_BETA[j], 0);
    const label = r() < 1 / (1 + Math.exp(-z)) ? 1 : 0;
    rows.push({ bout_id: `b${String(i).padStart(5, '0')}`, event_date: date, label, x, available: x.map(() => 1), min_prior_bouts: i % 9, min_stat_bouts: i % 5, available_count: 33 });
  }
  return rows;
}

/** In-memory PostgREST double: tables as arrays, a tiny filter parser for eq/is/in/neq, every write recorded. */
function fakeQ(tables = {}) {
  const writes = [];
  const T = (name) => (tables[name] ||= []);
  const parse = (p) => {
    const [name, qs] = p.split('?');
    const params = new URLSearchParams(qs || '');
    const filters = [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      filters.push([k, v]);
    }
    return { name, filters, limit: params.get('limit') ? Number(params.get('limit')) : null };
  };
  const match = (row, [k, v]) => {
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    const cell = row[k];
    if (op === 'eq') return String(cell) === decodeURIComponent(val);
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? cell == null : true;
    if (op === 'not' && val === 'is.null') return cell != null;
    if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, '')).includes(String(cell));
    if (op === 'gt') return String(cell) > decodeURIComponent(val);
    if (op === 'lt') return String(cell) < val;
    if (op === 'gte') return String(cell) >= val;
    if (op === 'lte') return String(cell) <= val;
    return true;
  };
  const select = (p) => { const { name, filters, limit } = parse(p); const rows = T(name).filter((r) => filters.every((f) => match(r, f))); return limit ? rows.slice(0, limit) : rows; };
  return {
    writes, tables,
    get: async (p) => select(p),
    post: async (p, body) => { const { name } = parse(p); writes.push({ method: 'POST', table: name, body }); const row = { id: `${name}-${T(name).length + 1}`, created_at: new Date().toISOString(), ...body }; T(name).push(row); return [row]; },
    patch: async (p, body) => { const { name } = parse(p); writes.push({ method: 'PATCH', table: name, path: p, body }); for (const r of select(p)) Object.assign(r, body); return null; },
    del: async (p) => { const { name } = parse(p); writes.push({ method: 'DELETE', table: name, path: p }); const gone = select(p); tables[name] = T(name).filter((r) => !gone.includes(r)); return gone; },
    rpc: async (fn, args) => { writes.push({ method: 'RPC', table: fn, body: args }); return null; },
    inChunks: async (table, column, ids, sel, extra = '') => select(`${table}?${column}=in.(${ids.join(',')})${extra}`),
  };
}

function fakeBucket(seed = {}) {
  const store = new Map(Object.entries(seed));
  const puts = [];
  return {
    store, puts,
    get: async (k) => (store.has(k) ? { text: async () => store.get(k), json: async () => JSON.parse(store.get(k)) } : null),
    head: async (k) => (store.has(k) ? {} : null),
    put: async (k, v) => { puts.push(k); store.set(k, typeof v === 'string' ? v : String(v)); },
  };
}

async function versionRow(model_version, beta, { status = 'live', window_end = '2026-09-05', provenance = null } = {}) {
  const scale = FEATURE_KEYS.map(() => 1);
  const spec = await sha256Hex(specCanonical({ model_version, feature_version: FEATURE_VERSION, beta, scale, lambda: 2 }));
  return {
    model_version, model_family: 'pbe-fight-model', feature_version: FEATURE_VERSION, status, spec_sha256: spec,
    coefficients: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, beta[i]])), feature_scale: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1])),
    hyperparameters: { lambda: 2, ...(provenance ? { provenance } : {}) }, training_window_end: window_end,
  };
}

/* ------------------------------------------------------------ gate + cutoff */

test('no new graded fights -> NO_NEW_TRAINING_DATA, no challenger, no R2 write', async () => {
  const g = C.decideGate({ cutoffDate: '2026-09-15', newBouts: [], freshness: {} });
  assert.equal(g.status, 'NO_NEW_TRAINING_DATA');
  const genesis = synthetic(600, 3, { from: 2020, to: 2026 }).map((r) => ({ ...r, event_date: r.event_date > '2026-09-05' ? '2026-09-01' : r.event_date }));
  const sha = await C.datasetSha256(genesis);
  const bucket = fakeBucket({ 'model-releases/g.jsonl': C.toJsonl(genesis) });
  const v1 = await versionRow('pbe-fight-model-v1', TRUE_BETA);
  const q = fakeQ({ ufc_model_versions: [v1], ufc_events: [], ufc_model_training_runs: [] });
  const env = { GENESIS_MODEL_VERSION: 'pbe-fight-model-v1', GENESIS_DATASET_SHA256: sha, GENESIS_DATASET_URI: 'r2://ufc-algo-artifacts/model-releases/g.jsonl', CODE_SHA: 'abc' };
  const gate = await D.gateStep({ q, env, bucket, now: Date.parse('2026-09-15T12:17:00Z') });
  assert.equal(gate.decision.status, 'NO_NEW_TRAINING_DATA');
  const stored = await D.storeNoData({ q, env, gate, trigger: 'cron' });
  assert.equal(stored.run.status, 'NO_NEW_TRAINING_DATA');
  assert.equal(stored.run.dataset_sha256, undefined);
  assert.equal(stored.run.coefficients, undefined);
  assert.deepEqual(bucket.puts, [], 'no artifact written');
  /* The same day again: the existing no-data row is returned, nothing new inserted. */
  const again = await D.storeNoData({ q, env, gate, trigger: 'admin' });
  assert.equal(again.created, false);
  assert.equal(q.writes.filter((w) => w.table === 'ufc_model_training_runs').length, 1);
});

test('the cutoff keeps today and later out, and waits for ingestion before learning', () => {
  const bouts = [{ bout_id: 'a', event_date: '2026-09-12' }, { bout_id: 'b', event_date: '2026-09-15' }, { bout_id: 'c', event_date: '2026-09-19' }];
  const ok = C.decideGate({ cutoffDate: '2026-09-15', newBouts: bouts, freshness: { statsIngestAt: '2026-09-15T01:31:17Z', missingSnapshots: [], missingFeatureRows: [], lockedUngraded: 0 } });
  assert.equal(ok.status, 'LEARN');
  assert.deepEqual(ok.bout_ids, ['a'], 'a bout on or after the cutoff never enters the dataset');
  const wait = C.decideGate({ cutoffDate: '2026-09-15', newBouts: bouts, freshness: { statsIngestAt: '2026-09-11T00:00:00Z', missingSnapshots: ['f'], missingFeatureRows: [], lockedUngraded: 2 } });
  assert.equal(wait.status, 'WAITING_FOR_DATA');
  assert.match(wait.reason, /stats-ingest/);
  assert.match(wait.reason, /snapshot/);
  assert.match(wait.reason, /not graded/);
});

test('the leakage audit fails on a row at the cutoff and on an injected future snapshot', () => {
  const rows = synthetic(2600, 11);
  const trained = C.trainChallenger(rows);
  const clean = C.leakageAudit({ datasetRows: rows, trained, cutoffDate: '2027-01-01', newRowIntegrity: [{ snapshot: '2026-01-01', target_in_snapshot: false, snapshot_after_event: false }] });
  assert.equal(clean.all_passed, true, JSON.stringify(clean.checks.filter((c) => !c.pass)));
  const future = C.leakageAudit({ datasetRows: rows, trained, cutoffDate: '2026-06-01' });
  assert.equal(future.checks.find((c) => c.name === 'training cutoff').pass, false);
  assert.equal(future.all_passed, false);
  const injected = C.leakageAudit({ datasetRows: rows, trained, cutoffDate: '2027-01-01', newRowIntegrity: [{ snapshot: '2026-09-14', target_in_snapshot: true, snapshot_after_event: true }] });
  assert.equal(injected.all_passed, false);
});

/* ------------------------------------------------------------ determinism + provenance */

test('identical dataset -> identical model and spec hash; row order does not matter', async () => {
  const rows = synthetic(2600, 5);
  const shuffled = rows.slice().reverse();
  assert.equal(await C.datasetSha256(rows), await C.datasetSha256(shuffled));
  const a = C.trainChallenger(rows), b = C.trainChallenger(shuffled);
  const spec = (t) => sha256Hex(specCanonical({ model_version: C.CHALLENGER_LABEL, feature_version: FEATURE_VERSION, beta: t.fit.beta, scale: t.fit.scale, lambda: t.fit.lambda }));
  assert.equal(await spec(a), await spec(b));
  const changed = rows.map((r, i) => (i === 100 ? { ...r, label: 1 - r.label } : r));
  assert.notEqual(await C.datasetSha256(changed), await C.datasetSha256(rows));
});

test('a duplicate run (same parent, dataset, code) returns the existing run and writes nothing', async () => {
  const existing = { id: 'run-1', status: 'CHALLENGER', parent_model_version: 'pbe-fight-model-v1', dataset_sha256: 'd1', code_sha: 'abc', superseded_at: null };
  const q = fakeQ({ ufc_model_training_runs: [existing] });
  const gate = { run_date: '2026-09-15', training_cutoff_at: '2026-09-15T00:00:00Z', champion: { model_version: 'pbe-fight-model-v1' }, parent: { run_id: null }, decision: { newly_graded: 18 } };
  const out = await D.storeTrained({ q, env: { CODE_SHA: 'abc' }, gate, dataset: { dataset_sha256: 'd1', dataset_uri: 'r2://ufc-algo-artifacts/x' }, trained: { status: 'CHALLENGER' }, trigger: 'admin' });
  assert.equal(out.created, false);
  assert.equal(out.run.id, 'run-1');
  assert.equal(q.writes.length, 0);
});

test('a new passing challenger supersedes the previous one; its row is otherwise untouched', async () => {
  const old = { id: 'old', status: 'CHALLENGER', parent_model_version: 'pbe-fight-model-v1', dataset_sha256: 'd0', code_sha: 'abc', superseded_at: null };
  const q = fakeQ({ ufc_model_training_runs: [old] });
  const gate = { run_date: '2026-09-16', training_cutoff_at: '2026-09-16T00:00:00Z', champion: { model_version: 'pbe-fight-model-v1' }, parent: { run_id: 'old' }, decision: { newly_graded: 5 } };
  const out = await D.storeTrained({ q, env: { CODE_SHA: 'abc' }, gate, dataset: { dataset_sha256: 'd2', dataset_uri: 'r2://ufc-algo-artifacts/x' }, trained: { status: 'CHALLENGER' }, trigger: 'cron' });
  assert.equal(out.created, true);
  assert.deepEqual(out.superseded, ['old']);
  const patches = q.writes.filter((w) => w.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body), ['superseded_at']);
});

test('dataset loading refuses a dataset that does not re-hash to its recorded sha', async () => {
  const rows = synthetic(50, 1);
  const bucket = fakeBucket({ 'learning/datasets/x.jsonl': C.toJsonl(rows) });
  await assert.rejects(D.loadDataset(bucket, 'r2://ufc-algo-artifacts/learning/datasets/x.jsonl', 'f'.repeat(64)), /re-hash mismatch/);
  assert.equal((await D.loadDataset(bucket, 'r2://ufc-algo-artifacts/learning/datasets/x.jsonl', await C.datasetSha256(rows))).length, 50);
});

/* ------------------------------------------------------------ review + promotion */

const passingRun = (over = {}) => ({
  id: 'run-9', status: 'CHALLENGER', leakage_audit: { all_passed: true, checks: [] },
  walk_forward: { pooled: { brier: 0.2360, log_loss: 0.6650 }, high_confidence_tail: { n: 120, mean_predicted: 0.84, observed: 0.83 } },
  calibration: { ece: 0.013, slope: 1.02 },
  sample_quality: [{ key: 'e. 6+ prior', n: 900, brier: 0.230 }],
  coefficient_drift: { max_abs_move: 0.004, material_sign_flips: [] },
  benchmark_drift: { mean_abs_delta_pts: 0.1, max_abs_delta_pts: 0.6 },
  ...over,
});
const baseline = { walk_forward: { pooled: { brier: 0.2362, log_loss: 0.6652 } }, calibration: { ece: 0.0136, slope: 1.03 }, sample_quality: [{ key: 'e. 6+ prior', n: 880, brier: 0.231 }] };
const pairs = (n, shadowP, champP) => Array.from({ length: n }, (_, i) => ({ bout_id: `p${i}`, shadow: { p_pick: shadowP, result: i % 3 ? 'WIN' : 'LOSS' }, champion: { p_pick: champP, result: i % 3 ? 'WIN' : 'LOSS' } }));

test('a failed leakage audit is REJECT and can never be proposed', () => {
  const r = C.reviewChallenger({ run: passingRun({ leakage_audit: { all_passed: false, checks: [{ name: 'permutation', pass: false }] } }), parentEvidence: baseline, shadowPairs: pairs(80, 0.7, 0.6) });
  assert.equal(r.verdict, 'REJECT');
  assert.match(r.reasons.join(' '), /leakage/);
});

test('a worse challenger stays shadow only (REJECT on regression, REJECT on worse paired shadow Brier)', () => {
  const regress = C.reviewChallenger({ run: passingRun({ walk_forward: { pooled: { brier: 0.2400, log_loss: 0.6700 }, high_confidence_tail: { n: 10 } } }), parentEvidence: baseline, shadowPairs: pairs(80, 0.66, 0.66) });
  assert.equal(regress.verdict, 'REJECT');
  const shadowWorse = C.reviewChallenger({ run: passingRun(), parentEvidence: baseline, shadowPairs: pairs(60, 0.55, 0.66) });
  assert.equal(shadowWorse.verdict, 'REJECT');
  const unstable = C.reviewChallenger({ run: passingRun({ coefficient_drift: { max_abs_move: 0.2, material_sign_flips: ['reach_diff'] } }), parentEvidence: baseline, shadowPairs: pairs(80, 0.66, 0.66) });
  assert.equal(unstable.verdict, 'REJECT');
  const drifted = C.reviewChallenger({ run: passingRun(), parentEvidence: baseline, shadowPairs: pairs(80, 0.66, 0.66), dataIntegrityOk: false });
  assert.equal(drifted.verdict, 'REJECT');
});

test('fewer than 50 paired graded shadow fights is HOLD; 50 with no regression is PROPOSE', () => {
  assert.equal(C.reviewChallenger({ run: passingRun(), parentEvidence: baseline, shadowPairs: pairs(49, 0.7, 0.6) }).verdict, 'HOLD');
  const unpaired = pairs(70, 0.7, 0.6).map((p, i) => (i < 30 ? { ...p, champion: { p_pick: 0.6, result: null } } : p));
  assert.equal(C.reviewChallenger({ run: passingRun(), parentEvidence: baseline, shadowPairs: unpaired }).verdict, 'HOLD', 'ungraded champion side does not count as a pair');
  const ok = C.reviewChallenger({ run: passingRun(), parentEvidence: baseline, shadowPairs: pairs(50, 0.66, 0.6) });
  assert.equal(ok.verdict, 'PROPOSE');
  assert.equal(C.reviewChallenger({ run: null }).verdict, 'NO_CHALLENGER');
});

test('owner decision: only PROPOSE can be decided; the admin path cannot promote; APPROVED goes through ufc_model_promote', async () => {
  const hold = { id: 'rv-hold', verdict: 'HOLD', challenger_run_id: 'run-9', champion_model_version: 'pbe-fight-model-v1' };
  const prop = { id: 'rv-prop', verdict: 'PROPOSE', challenger_run_id: 'run-9', champion_model_version: 'pbe-fight-model-v1' };
  const run = { id: 'run-9', feature_version: FEATURE_VERSION, coefficients: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0.1])), feature_scale: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1])), hyperparameters: { lambda: 5 } };
  const q = fakeQ({ ufc_model_promotion_reviews: [hold, prop], ufc_model_training_runs: [run], ufc_model_versions: [] });
  assert.equal((await R.ownerDecision(q, { reviewId: 'rv-hold', decision: 'APPROVED', modelVersion: 'pbe-fight-model-v1.1' })).status, 409);
  assert.equal((await R.ownerDecision(q, { reviewId: 'rv-prop', decision: 'APPROVED', modelVersion: 'pbe-fight-model-v1' })).status, 400, 'a new minor version name is required');
  assert.equal(q.writes.length, 0);
  const ok = await R.ownerDecision(q, { reviewId: 'rv-prop', decision: 'APPROVED', modelVersion: 'pbe-fight-model-v1.1' });
  assert.equal(ok.status, 200);
  const rpc = q.writes.find((w) => w.method === 'RPC');
  assert.equal(rpc.table, 'ufc_model_promote');
  const expected = await sha256Hex(specCanonical({ model_version: 'pbe-fight-model-v1.1', feature_version: FEATURE_VERSION, beta: FEATURE_KEYS.map(() => 0.1), scale: FEATURE_KEYS.map(() => 1), lambda: 5 }));
  assert.equal(rpc.body.p_spec_sha256, expected);

  const idx = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
  assert.match(idx, /OWNER_PROMOTE_TOKEN !== env\.ADMIN_TRIGGER_TOKEN/, 'the admin token can never be the owner token');
  assert.ok(idx.indexOf("url.pathname === '/admin/promote'") < idx.indexOf('adminOk(req, env)))'), 'promote is matched before the admin gate and uses ownerOk');
});

/* ------------------------------------------------------------ champion + isolation */

test('champion: the single live version of the family; V1 retired after promotion still verifies; two live is blocked', async () => {
  const v1 = await versionRow('pbe-fight-model-v1', TRUE_BETA, { status: 'retired' });
  const v11 = await versionRow('pbe-fight-model-v1.1', TRUE_BETA.map((b) => b + 0.01));
  const c = await resolveChampion(fakeQ({ ufc_model_versions: [v1, v11] }));
  assert.equal(c.live, true);
  assert.equal(c.model_version, 'pbe-fight-model-v1.1');
  const both = await resolveChampion(fakeQ({ ufc_model_versions: [{ ...v1, status: 'live' }, v11] }));
  assert.equal(both.live, false);
  assert.match(both.blocked, /exactly one/);
  const onlyV1 = await resolveChampion(fakeQ({ ufc_model_versions: [await versionRow('pbe-fight-model-v1', TRUE_BETA)] }));
  assert.equal(onlyV1.model_version, 'pbe-fight-model-v1');
});

test('an audit-failed or tampered challenger is never active (so it is never shadow-scored or reviewed)', async () => {
  const beta = FEATURE_KEYS.map(() => 0.05);
  const spec = await sha256Hex(specCanonical({ model_version: C.CHALLENGER_LABEL, feature_version: FEATURE_VERSION, beta, scale: FEATURE_KEYS.map(() => 1), lambda: 5 }));
  const base = { id: 'r1', status: 'CHALLENGER', parent_model_version: 'pbe-fight-model-v1', superseded_at: null, spec_sha256: spec, coefficients: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0.05])), feature_scale: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1])), hyperparameters: { lambda: 5 }, leakage_audit: { all_passed: true } };
  assert.equal((await D.activeChallenger(fakeQ({ ufc_model_training_runs: [base] }), 'pbe-fight-model-v1')).id, 'r1');
  assert.equal(await D.activeChallenger(fakeQ({ ufc_model_training_runs: [{ ...base, leakage_audit: { all_passed: false } }] }), 'pbe-fight-model-v1'), null);
  assert.equal(await D.activeChallenger(fakeQ({ ufc_model_training_runs: [{ ...base, coefficients: { ...base.coefficients, [FEATURE_KEYS[0]]: 9 } }] }), 'pbe-fight-model-v1'), null);
  assert.equal(await D.activeChallenger(fakeQ({ ufc_model_training_runs: [base] }), 'pbe-fight-model-v1.1'), null, 'a challenger of a previous champion is not active');
});

test('import graph: learning code never writes a prediction or a model version', () => {
  const dir = here;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /q\.(post|patch|del)\(\s*[`'"]ufc_model_(predictions|versions|prediction_grades|bout_evaluations)/, `${f} writes an official table`);
  }
  const shadow = fs.readFileSync(path.join(dir, 'shadow.js'), 'utf8');
  assert.doesNotMatch(shadow.replace(/\/\/.*$/gm, ''), /ufc_model_predictions/, 'shadow code does not even read official predictions');
  const wf = fs.readFileSync(path.join(dir, 'workflow.js'), 'utf8') + fs.readFileSync(path.join(dir, 'daily.js'), 'utf8');
  assert.doesNotMatch(wf, /ufc_model_promote/, 'daily learning cannot call promotion');
});
