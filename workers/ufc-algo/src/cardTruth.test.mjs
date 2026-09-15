// D1 regression: a matchup the authoritative current card no longer lists can
// never regenerate or lock just because ufc_bouts.status still says 'announced'.
// Pure card-truth states, the eligibility composition, and the real cycle
// against a fake PostgREST that records every write.
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

const { cardTruth, CARD_TRUTH_BLOCKING } = await import('./cardTruth.js');
const { runCycle } = await import('./cycle.js');
const { evaluateBout } = await import('../../../scripts/model/eligibility.mjs');
const { FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } = await import('../../../scripts/model/feature_spec.mjs');

const obs = (over = {}) => ({ observed_at: '2026-09-18T06:03:00Z', source: 'espn', competition_ids: ['c2', 'c3'], placeholder_ids: ['c9'], complete: true, ...over });

test('card truth states: only a listed competition (or no observation yet) keeps V1 behaviour', () => {
  assert.equal(cardTruth({ espn_competition_id: 'c2' }, obs()).state, 'confirmed');
  assert.equal(cardTruth({ espn_competition_id: 'c2' }, null).state, 'unobserved');
  assert.equal(cardTruth({ espn_competition_id: 'c1' }, obs()).state, 'missing');
  assert.equal(cardTruth({ espn_competition_id: 'c9' }, obs()).state, 'placeholder');
  assert.equal(cardTruth({ espn_competition_id: null }, obs()).state, 'no_source_id');
  assert.equal(cardTruth({ espn_competition_id: 'c2' }, obs({ complete: false })).state, 'incomplete');
  assert.deepEqual([...CARD_TRUTH_BLOCKING].sort(), ['incomplete', 'missing', 'no_source_id', 'placeholder']);
  for (const s of ['confirmed', 'unobserved']) assert.equal(CARD_TRUTH_BLOCKING.includes(s), false);
});

test('composition: an otherwise ELIGIBLE bout is NO_MODEL_CALL (BOUT_NOT_SCHEDULED) when the card no longer lists it; confirmed is unchanged', () => {
  const input = (activeCardChange) => ({
    event: { name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19' }, nowIso: '2026-09-18T16:41:00Z', modelLive: true, pickProbability: 0.64,
    bout: { status: 'announced', has_result: false, fighter_a_id: 'a', fighter_b_id: 'b', active_card_change: activeCardChange },
    corners: [1, 2].map(() => ({ fighter_exists: true, open_alias_review: false, record_reconciles: true, stale: false })),
    row: { min_prior_bouts: 6, min_stat_bouts: 6, available_count: 32 }, marketDisagreementPts: null, regenerationDriftPts: null,
  });
  for (const [state, expect] of [['confirmed', 'ELIGIBLE'], ['unobserved', 'ELIGIBLE'], ['missing', 'NO_MODEL_CALL'], ['placeholder', 'NO_MODEL_CALL'], ['no_source_id', 'NO_MODEL_CALL'], ['incomplete', 'NO_MODEL_CALL']]) {
    const blocking = CARD_TRUTH_BLOCKING.includes(state);
    const r = evaluateBout(input(blocking));
    assert.equal(r.decision, expect, state);
    if (blocking) assert.ok(r.reasons.includes('BOUT_NOT_SCHEDULED'), state);
  }
  // A news-blocked bout stays blocked whatever the card says: card truth only ORs in (D2 stays deferred).
  assert.equal(evaluateBout(input(true)).decision, 'NO_MODEL_CALL');
});

/* ---- the real cycle ---------------------------------------------------- */

function registered() {
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, (i % 5) * 0.1 - 0.2]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 1]));
  const canonical = JSON.stringify({ model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => coefficients[k]), scale: FEATURE_KEYS.map((k) => feature_scale[k]), lambda: 2 });
  return { model_version: MODEL_VERSION, model_family: 'pbe-fight-model', feature_version: FEATURE_VERSION, status: 'live', coefficients, feature_scale, spec_sha256: createHash('sha256').update(canonical).digest('hex'), hyperparameters: { lambda: 2 } };
}
const EVENT = { id: 'e331', name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19', card_status: 'announced' };
const LOCK_PASS = Date.parse('2026-09-18T16:41:00Z');
const bout = (id, comp, a, b, order) => ({ id, event_id: 'e331', espn_competition_id: comp, fighter_a_id: a, fighter_b_id: b, weight_class: 'LW', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: order, status: 'announced' });

async function run({ bouts, preds = [], observation = null }) {
  const writes = [];
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname.replace('/rest/v1/', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') writes.push({ method, path, query: decodeURIComponent(u.search), body: init.body ? JSON.parse(init.body) : null });
    if (method === 'POST' && path === 'ufc_model_runs') return ok([{ id: 'run-1' }]);
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (path === 'ufc_model_versions') return ok([registered()]);
    if (path === 'ufc_events') return ok([EVENT]);
    if (path === 'ufc_bouts') return ok(u.searchParams.has('or') ? [] : bouts);
    if (path === 'ufc_fighters') return ok([...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))].map((id) => ({ id, name: id })));
    if (path === 'ufc_model_predictions') return ok(preds);
    if (path === 'ufc_event_card_observations') return ok(observation ? [observation] : []);
    return ok([]);
  };
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    const r = await runCycle({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ALGO_MODE: 'armed' }, { trigger: 'cron', mode: 'armed', now: LOCK_PASS });
    return { r, writes, report: new Map(r.cards[0].bouts.map((b) => [b.bout_id, b])) };
  } finally { globalThis.fetch = real; }
}

test('stale old matchup + authoritative replacement: old draft withdrawn, never published, BOUT_NOT_SCHEDULED', async () => {
  const bouts = [bout('old', 'c1', 'moicano', 'ortega', 3), bout('new', 'c2', 'moicano', 'replacement', 4)];
  const preds = [{ id: 'p-old', bout_id: 'old', locked_at: null, model_version: MODEL_VERSION, prob_a: 0.6, pick_probability: 0.6 }];
  const { r, writes, report } = await run({ bouts, preds, observation: obs({ competition_ids: ['c2'], placeholder_ids: [] }) });
  assert.equal(r.error, undefined);
  assert.equal(report.get('old').card_truth, 'missing');
  assert.equal(report.get('old').decision, 'NO_MODEL_CALL');
  assert.ok(report.get('old').reasons.includes('BOUT_NOT_SCHEDULED'));
  assert.ok(writes.some((w) => w.method === 'DELETE' && w.path === 'ufc_model_predictions' && w.query.includes('id=eq.p-old') && w.query.includes('locked_at=is.null')));
  assert.ok(!writes.some((w) => w.path.startsWith('rpc/ufc_model_publish_prediction')), 'nothing is locked');
  assert.equal(report.get('new').card_truth, 'confirmed');
  assert.ok(!report.get('new').reasons.includes('BOUT_NOT_SCHEDULED'), 'the replacement is evaluated on its own merits, not blocked by the old matchup');
  const evalOld = writes.find((w) => w.path === 'ufc_model_bout_evaluations' && w.body.bout_id === 'old');
  assert.equal(evalOld.body.identity.card_truth.state, 'missing', 'provenance recorded on the evaluation');
});

test('stale old matchup still announced in the DB, no news status, no replacement listed: still cannot regenerate or lock', async () => {
  const bouts = [bout('old', 'c1', 'moicano', 'ortega', 3), bout('other', 'c3', 'x', 'y', 2)];
  const preds = [{ id: 'p-old', bout_id: 'old', locked_at: null, model_version: MODEL_VERSION, prob_a: 0.6, pick_probability: 0.6 }];
  const { writes, report } = await run({ bouts, preds, observation: obs({ competition_ids: ['c3'], placeholder_ids: [] }) });
  assert.equal(bouts[0].status, 'announced');
  assert.equal(report.get('old').decision, 'NO_MODEL_CALL');
  assert.equal(report.get('old').card_truth, 'missing');
  assert.ok(report.get('old').reasons.includes('BOUT_NOT_SCHEDULED'), 'blocked by card truth itself, not only by thin data');
  assert.ok(!writes.some((w) => w.method === 'PATCH' && w.path === 'ufc_model_predictions'), 'no regeneration');
  assert.ok(!writes.some((w) => w.path.startsWith('rpc/')), 'no lock');
  assert.ok(!writes.some((w) => w.path === 'ufc_bouts'), 'ufc_bouts is never mutated');
});

test('canonical unchanged matchup: identical decisions with a confirming observation and with none (V1 behaviour)', async () => {
  const bouts = [bout('b1', 'c2', 'f1', 'f2', 2), bout('b2', 'c3', 'f3', 'f4', 1)];
  const strip = (m) => [...m.values()].map(({ card_truth: _c, ...x }) => x);
  const a = await run({ bouts, observation: null });
  const b = await run({ bouts, observation: obs() });
  assert.deepEqual(strip(b.report), strip(a.report));
  assert.deepEqual(b.writes.map((w) => `${w.method} ${w.path} ${w.query}`), a.writes.map((w) => `${w.method} ${w.path} ${w.query}`));
  assert.deepEqual([...b.report.values()].map((x) => x.card_truth), ['confirmed', 'confirmed']);
});

test('uncertain card truth fails closed: placeholder, missing ESPN id, incomplete observation -> no call', async () => {
  for (const [b, o, state] of [
    [bout('p', 'c9', 'f1', 'f2', 1), obs(), 'placeholder'],
    [bout('n', null, 'f1', 'f2', 1), obs(), 'no_source_id'],
    [bout('i', 'c2', 'f1', 'f2', 1), obs({ complete: false }), 'incomplete'],
  ]) {
    const { report, writes } = await run({ bouts: [b], observation: o });
    const x = report.get(b.id);
    assert.equal(x.card_truth, state);
    assert.equal(x.decision, 'NO_MODEL_CALL');
    assert.ok(x.reasons.includes('BOUT_NOT_SCHEDULED'), state);
    assert.ok(!writes.some((w) => w.path.startsWith('rpc/')));
  }
});

test('a locked prediction on a vanished matchup is never modified or deleted', async () => {
  const bouts = [bout('old', 'c1', 'moicano', 'ortega', 3)];
  const preds = [{ id: 'p-locked', bout_id: 'old', locked_at: '2026-09-18T16:41:07Z', model_version: MODEL_VERSION, prob_a: 0.6, pick_probability: 0.6, pick_fighter_id: 'moicano', fighter_a_id: 'moicano', fighter_b_id: 'ortega' }];
  const { writes, report } = await run({ bouts, preds, observation: obs({ competition_ids: [], placeholder_ids: [] }) });
  assert.equal(report.get('old').locked_at, '2026-09-18T16:41:07Z');
  assert.ok(!writes.some((w) => w.path === 'ufc_model_predictions' && ['PATCH', 'DELETE'].includes(w.method)));
});
