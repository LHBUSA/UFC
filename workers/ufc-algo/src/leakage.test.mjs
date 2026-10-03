// Prediction-market leakage guard (owner 2026-10-03): Kalshi / Polymarket prices never enter a PBE model
// input or output. pbe-fight-model-v1 is ARMED + FROZEN, so the guard is enforced here, at the feature-builder
// input boundary, against the real loadCard -> assembleBoutRow -> predictOne path and the real runCycle
// (fake PostgREST, real V1 release artifact). Nothing in the deployed Worker changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return next(url, context);
}`), pathToFileURL('./'));

const { runCycle, loadCard, resolveModel } = await import('./cycle.js');
const { db } = await import('./supabase.js');
const { FEATURE_KEYS } = await import('../../../scripts/model/feature_spec.mjs');
const { SNAPSHOT_SELECT, SNAPSHOT_METRICS, assembleBoutRow } = await import('../../../scripts/model/features_core.mjs');
const { predictOne } = await import('../../../scripts/model/logistic.mjs');
const G = await import('./leakageGuard.js');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const EVENT = { id: 'e-leak', name: 'UFC 999: Leakage Fixture', event_date: '2026-10-06', card_status: 'announced' };
const CORNERS = [['fa1', 'fb1'], ['fa2', 'fb2']];
const BOUTS = CORNERS.map(([a, b], i) => ({ id: `bout-${i + 1}`, event_id: EVENT.id, espn_competition_id: null, fighter_a_id: a, fighter_b_id: b, weight_class: 'LW', is_womens: false, is_title: i === 0, scheduled_rounds: i === 0 ? 5 : 3, card_position: 'main', bout_order: 10 - i, status: 'scheduled' }));
const FIGHTER_IDS = CORNERS.flat();

// Deterministic, realistic-shape fixture. Corners differ strongly so V1 makes confident calls.
const seed = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
const FIGHTERS = FIGHTER_IDS.map((id, i) => ({ id, name: `Fighter ${id.toUpperCase()}`, dob: `${1988 + (i % 2) * 6}-0${1 + i}-15`, height_in: 70 + (i % 2 ? -1 : 2), reach_in: 72 + (i % 2 ? -3 : 3), stance: i % 2 ? 'ORTHODOX' : 'SOUTHPAW' }));
const OUTCOMES = { fa1: 'WWWWLW', fb1: 'LWLLWL', fa2: 'WWLWWW', fb2: 'LLWLWL' };
const ROWS = [];
for (const id of FIGHTER_IDS) {
  [...OUTCOMES[id]].forEach((o, k) => {
    const opp = `opp-${id}-${k}`;
    const date = `${2020 + k}-0${1 + (k % 9)}-1${k}`;
    const bout = `hist-${id}-${k}`;
    const s = seed(id + k);
    ROWS.push({ fighter_id: id, bout_id: bout, opponent_id: opp, event_date: date, outcome: o, opp_totals: { kd: 0, sig_l: 30 + (s % 20), sig_a: 70 + (s % 30), td_l: 1 + (s % 3), td_a: 4 + (s % 4), sub: s % 2, ctrl: 60 + (s % 120) } });
    ROWS.push({ fighter_id: opp, bout_id: bout, opponent_id: id, event_date: date, outcome: o === 'W' ? 'L' : 'W' });
    ROWS.push({ fighter_id: opp, bout_id: `opp-prior-${opp}`, opponent_id: `x-${opp}`, event_date: '2019-06-01', outcome: s % 2 ? 'W' : 'L' });
  });
}
const SNAPS = Object.fromEntries(FIGHTER_IDS.map((id, i) => {
  const w = [...OUTCOMES[id]].filter((o) => o === 'W').length;
  const strong = i % 2 === 0;
  const snap = { fighter_id: id, as_of_date: '2026-06-01', definition_version: 1, sample_bouts: 6, sample_completed_bouts: 6, sample_stat_bouts: 6, sample_rounds: 15, sample_seconds: 4100, coverage_status: 'complete',
    record: { appearances: 6, w, l: 6 - w }, included_bouts: [...OUTCOMES[id]].map((_, k) => `hist-${id}-${k}`), finished_by: { ko_tko: strong ? 0 : 2, submission: strong ? 0 : 1 },
    five_round_apps: strong ? '3' : '0', title_apps: strong ? '2' : '0', main_event_apps: strong ? '3' : '0' };
  SNAPSHOT_METRICS.forEach((m, j) => { snap[`m_${m}`] = String(((strong ? 1.6 : 0.7) + (j % 7) * 0.11 + seed(id + m) / 99730).toFixed(4)); });
  return [id, snap];
}));

// Sportsbook (The Odds API) h2h snapshot: a POST-model comparison input, never a feature.
const sportsbook = (shift = 0) => BOUTS.flatMap((b) => ['dk', 'fd', 'mgm'].flatMap((book, j) => [
  { bout_id: b.id, run_id: 'odds-run-1', bookmaker_key: book, bookmaker_name: book, market_key: 'h2h', outcome_fighter_id: b.fighter_a_id, price: -180 - 10 * j + shift, source_last_update: '2026-10-03T11:40:00Z', observed_at: '2026-10-03T11:45:00Z' },
  { bout_id: b.id, run_id: 'odds-run-1', bookmaker_key: book, bookmaker_name: book, market_key: 'h2h', outcome_fighter_id: b.fighter_b_id, price: 150 + 10 * j - shift, source_last_update: '2026-10-03T11:40:00Z', observed_at: '2026-10-03T11:45:00Z' },
]));

// Prediction-market venues: present, reachable and perturbed to absurd values between scenarios.
// UFC has no Polymarket path at all; it is injected anyway (tables, endpoint, service binding, extra fields on the
// sportsbook rows) so the test proves nothing reads it. Prices in cents (0..100) and basis points.
//   base    realistic venue prices
//   zero    every price 0c       max  every price 99c       random  seeded pseudo-random
const PERTURBATIONS = ['zero', 'max', 'random'];
function priceFn(mode) {
  let st = 0x2f6e2b1;
  const rnd = () => { st = (st * 1103515245 + 12345) % 2147483648; return st / 2147483648; };
  return mode === 'zero' ? () => 0 : mode === 'max' ? () => 99 : mode === 'random' ? () => Math.floor(rnd() * 100) : (() => { let k = 0; return () => [55, 57, 44, 46, 56, 45][k++ % 6]; })();
}
const venues = (mode = 'base') => {
  const c = priceFn(mode);
  return {
    kalshi: BOUTS.map((b) => ({ bout_id: b.id, ticker: `KXUFCFIGHT-${b.id}`, yes_bid: c(), yes_ask: c(), no_bid: c(), no_ask: c(), last_price: c(), yes_bid_bp: c() * 100, yes_ask_bp: c() * 100, last_price_bp: c() * 100, volume: c() * 1000, open_interest: c() * 500, liquidity: c() * 10000 })),
    polymarket: BOUTS.map((b) => ({ bout_id: b.id, token_id: `pm-${b.id}`, condition_id: `cond-${b.id}`, best_bid: c() / 100, best_ask: c() / 100, best_bid_bp: c() * 100, best_ask_bp: c() * 100, midpoint: c() / 100, spread: c() / 100, last_trade_price: c() / 100, order_book: { bids: [[c() / 100, 100]], asks: [[c() / 100, 100]] }, liquidity: c() * 1000, volume: c() * 1000 })),
    // Extra venue fields smuggled onto the SPORTSBOOK rows the scheduler does read (market comparison only).
    extra: () => ({ kalshi_yes_bid_bp: c() * 100, kalshi_yes_ask_bp: c() * 100, polymarket_best_bid_bp: c() * 100, polymarket_best_ask_bp: c() * 100, venue_mid_bp: c() * 100, consensus_prob: c() / 100 }),
  };
};
/** Fake propsports-markets service binding + venue URLs on env: any call is recorded as a venue hit. */
function venueEnv(V, hits) {
  const svc = { fetch: async (req) => { hits.push(`binding ${typeof req === 'string' ? req : req.url}`); return new Response(JSON.stringify({ kalshi: V.kalshi, polymarket: V.polymarket })); } };
  return { MARKETS: svc, PROPSPORTS_MARKETS: svc, KALSHI_API_URL: 'https://api.elections.kalshi.com/trade-api/v2', POLYMARKET_CLOB_URL: 'https://clob.polymarket.com', POLYMARKET_GAMMA_URL: 'https://gamma-api.polymarket.com', PROPSPORTS_MARKETS_URL: 'https://propsports-markets.example.workers.dev' };
}

const ids = (u, col) => { const v = u.searchParams.get(col) || ''; const m = v.match(/^in\.\((.*)\)$/); if (m) return m[1].split(',').map((s) => s.replace(/"/g, '')); return v.startsWith('eq.') ? [v.slice(3)] : []; };

function fakePostgrest({ venue = 'base', bookShift = 0, poison = false } = {}) {
  const reads = [];       // every GET (path + query), i.e. everything any model input could have been read from
  const venueHits = [];   // any request that reached venue data
  const writes = [];
  const V = venues(venue);
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (u.host !== 'db.test') { venueHits.push(String(url)); return ok({ markets: [...V.kalshi, ...V.polymarket] }); }
    const path = u.pathname.replace('/rest/v1/', '');
    if (method !== 'GET') { writes.push({ method, path }); return method === 'POST' && path === 'ufc_model_runs' ? ok([{ id: 'run-1' }]) : new Response(null, { status: 204 }); }
    reads.push(`${path}${decodeURIComponent(u.search)}`);
    if (/^(kalshi|market_intel_|market_venue_|algo_market_)/.test(path)) { venueHits.push(path); return ok(path.includes('venue') ? V.polymarket : V.kalshi); }
    if (/^polymarket/.test(path)) { venueHits.push(path); return ok(V.polymarket); }
    switch (path) {
      case 'ufc_model_versions': return ok([]); // dry run scores with the bundled V1 release artifact (real coefficients)
      case 'ufc_events': return ok([EVENT]);
      case 'ufc_bouts': return ok(u.searchParams.has('or') ? [] : BOUTS);
      case 'ufc_fighters': return ok(FIGHTERS.filter((f) => ids(u, 'id').includes(f.id)));
      case 'ufc_fighter_dna_snapshots': return ok(ids(u, 'fighter_id').map((id) => (poison ? { ...SNAPS[id], kalshi_yes_bid_bp: 9700 } : SNAPS[id])).filter(Boolean));
      case 'ufc_fighter_bout_features': { const want = new Set(ids(u, 'fighter_id')); return ok(ROWS.filter((r) => want.has(r.fighter_id))); }
      case 'ufc_fighter_aliases': return ok([]);
      case 'ufc_market_run_quotes': { const b = ids(u, 'bout_id'); return ok(sportsbook(bookShift).filter((r) => b.includes(r.bout_id)).map((r) => ({ ...r, ...V.extra() }))); }
      case 'ufc_market_observations': return ok([]);
      default: return ok([]);
    }
  };
  return { handler, reads, venueHits, writes, env: { ...ENV, ...venueEnv(V, venueHits) } };
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const ENV = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ALGO_MODE: 'dry_run' };

/** The PBE side of a cycle: what the model saw and said. Market fields excluded. */
const pbeSide = (report) => report.cards.flatMap((c) => c.bouts.map((b) => ({
  bout_id: b.bout_id, decision: b.decision, reasons: b.reasons, confidence: b.confidence,
  pick_fighter_id: b.pick_fighter_id, pick_probability: b.pick_probability, prob_a: b.prob_a ?? null, band: b.band,
  features_available: b.features_available, sample: b.sample, feature_vector: b.feature_vector ?? null, feature_availability: b.feature_availability ?? null,
})));
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Model-input boundary: the exact assembleBoutRow arguments plus V1 scoring, via the real loadCard. */
async function boundary(opts) {
  const f = fakePostgrest(opts);
  const out = await withFetch(f.handler, async () => {
    const q = db(f.env);
    const card = await loadCard(q, EVENT, NOW_ISO);
    G.assertModelInputsMarketFree({ fighters: card.fighters, snapsOf: card.snapsOf, rowsOf: card.rowsOf });
    const model = await resolveModel(q, 'dry_run');
    return BOUTS.map((b) => {
      const row = assembleBoutRow(b, EVENT, card.fighters, card.snapsOf, card.rowsOf);
      const featureVector = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]]));
      G.assertMarketFree(featureVector);
      return { bout_id: b.id, featureVector, available: row.available, p1: predictOne(row.x, model.beta, model.scale), model: model.spec_sha256 };
    });
  });
  return { ...f, out };
}

// Golden: produced by this fixture against the unmodified scheduler/model code of main 8f7c046 with the V1 release
// artifact (bout-1 fa1 prob_a 0.87656999, bout-2 fa2 0.88722305).
// Any drift means the model path changed — that is a frozen-model regression, not a test to re-pin.
const GOLDEN_PBE_SIDE_SHA256 = 'aad1aeda0a09f5ef6bb53f2558d494ad47e281d0d12d2c5159c2eff4f8d4b118';

test('guard rejects every prediction-market key at any depth (incl. Map/Set containers)', () => {
  for (const k of ['kalshi_mid', 'polymarket_price', 'best_bid_bp', 'best_ask', 'yes_ask_bp', 'no_bid', 'midpoint', 'mid', 'mid_bp', 'venue_mid', 'comparable_mid_bp', 'spread_bp', 'order_book_depth', 'book_hash', 'depth', 'last_trade_bp', 'last_price', 'venue_gap_pts', 'consensus_prob', 'market_volume', 'volume', 'liquidity', 'open_interest', 'token_id', 'condition_id', 'clob_price', 'gamma_market', 'prediction_market_prob', 'bid', 'ask', 'implied_prob']) {
    assert.throws(() => G.assertMarketFree({ features: { nested: [{ [k]: 1 }] } }), G.MarketLeakageError, k);
    assert.throws(() => G.assertModelInputsMarketFree({ fighters: new Map([['f', { [k]: 1 }]]), snapsOf: new Map(), rowsOf: new Map() }), G.MarketLeakageError, k);
  }
  assert.deepEqual(G.findMarketKeys({ a: { venue_mid_bp: 1 } }), ['$.a.venue_mid_bp']);
  for (const t of ['market_venue_observations?select=*', 'market_intel_snapshots?select=*', 'kalshi_markets', 'polymarket_books', 'algo_market_comparisons_current', 'ufc_market_run_quotes?select=price']) {
    assert.throws(() => G.assertModelSourceTable(t), G.MarketLeakageError, t);
  }
  for (const u of ['https://propsports-markets.example.workers.dev/admin/kalshi', 'https://api.elections.kalshi.com/trade-api/v2/markets', 'https://clob.polymarket.com/book', 'https://gamma-api.polymarket.com/markets']) {
    assert.throws(() => G.assertModelSourceUrl(u), G.MarketLeakageError, u);
  }
});

test('guard has no false positive on the real V1 contract: 33 feature keys, Fight DNA select, bout-row totals, fighter profile', () => {
  assert.doesNotThrow(() => G.assertMarketFree(Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0]))));
  const snapKeys = SNAPSHOT_SELECT.split(',').map((s) => s.split(':')[0]);
  assert.doesNotThrow(() => G.assertMarketFree(Object.fromEntries(snapKeys.map((k) => [k, 0]))));
  const totals = ['kd', 'sig_l', 'sig_a', 'tot_l', 'tot_a', 'td_l', 'td_a', 'sub', 'rev', 'ctrl', 'head_l', 'head_a', 'body_l', 'body_a', 'leg_l', 'leg_a', 'dist_l', 'dist_a', 'clinch_l', 'clinch_a', 'ground_l', 'ground_a', 'rounds', 'seconds'];
  assert.doesNotThrow(() => G.assertMarketFree({ fighter_id: 1, bout_id: 1, opponent_id: 1, event_date: 1, outcome: 1, opp_totals: Object.fromEntries(totals.map((k) => [k, 0])) }));
  assert.doesNotThrow(() => G.assertMarketFree({ id: 1, name: 1, dob: 1, height_in: 1, reach_in: 1, stance: 1 }));
  assert.doesNotThrow(() => G.assertModelSourceTable(`ufc_fighter_dna_snapshots?select=${SNAPSHOT_SELECT}`));
});

test('boundary: the real loadCard model inputs are market-free and read no venue table or endpoint', async () => {
  const r = await boundary({});
  assert.deepEqual(r.venueHits, [], 'no venue table or venue endpoint reached');
  const modelInputTables = ['ufc_bouts', 'ufc_fighters', 'ufc_fighter_dna_snapshots', 'ufc_fighter_bout_features', 'ufc_model_versions'];
  const inputReads = r.reads.filter((p) => modelInputTables.includes(p.split('?')[0]));
  assert.ok(inputReads.length >= 5);
  for (const p of inputReads) assert.doesNotThrow(() => G.assertModelSourceTable(p), p);
  assert.ok(r.out.every((o) => o.p1 > 0 && o.p1 < 1));
  // Negative control: a venue price smuggled into a Fight DNA snapshot is rejected at the boundary.
  await assert.rejects(() => boundary({ poison: true }), G.MarketLeakageError);
});

test('static: no model / scheduler module references a prediction-market venue; the Worker bundle does not include the guard', () => {
  const files = ['./cycle.js', './market.js', './champion.js', './cardTruth.js', './marketRefresh.js', './index.js', './learning/shadow.js', './learning/core.js', './learning/assemble.js', './learning/daily.js',
    '../../../scripts/model/features_core.mjs', '../../../scripts/model/feature_spec.mjs', '../../../scripts/model/logistic.mjs', '../../../scripts/model/eligibility.mjs', '../../../scripts/model/market_baseline.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/kalshi|polymarket|market_venue_|market_intel_|propsports-markets|clob|token_id|best_bid|best_ask/i.test(src), f);
  }
  assert.ok(!/leakageGuard/.test(fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')));
  assert.ok(!/leakageGuard/.test(fs.readFileSync(new URL('./cycle.js', import.meta.url), 'utf8')));
});

test('INVARIANT: Kalshi + Polymarket at 0c / 99c / seeded random leave every V1 feature and forecast byte-identical', async () => {
  const run = async (venue) => {
    const bnd = await boundary({ venue });
    const f = fakePostgrest({ venue });
    const report = await withFetch(f.handler, () => runCycle(f.env, { trigger: 'admin', mode: 'dry_run', now: NOW }));
    const side = pbeSide(report);
    return {
      bnd, f, report, side,
      features: sha({ boundary: bnd.out.map((o) => [o.bout_id, o.featureVector, o.available]), cycle: side.map((x) => [x.bout_id, x.feature_vector, x.feature_availability]) }),
      forecast: sha({ boundary: bnd.out.map((o) => [o.bout_id, o.p1]), cycle: side.map((x) => [x.bout_id, x.decision, x.reasons, x.confidence, x.pick_fighter_id, x.pick_probability, x.prob_a, x.band]) }),
    };
  };
  const base = await run('base');
  assert.equal(base.report.model.source, 'artifact_unregistered', 'scored with the real V1 release artifact');
  assert.ok(base.side.length === 2 && base.side.every((x) => x.decision === 'ELIGIBLE' && x.feature_vector), 'fixture produces real V1 calls');
  assert.deepEqual(base.bnd.venueHits, []);
  assert.deepEqual(base.f.venueHits, [], 'no venue table, endpoint or binding reached');
  for (const x of base.side) G.assertMarketFree(x.feature_vector);
  assert.equal(sha(base.side), GOLDEN_PBE_SIDE_SHA256, 'golden: V1 outputs unchanged vs pre-guard main');

  for (const venue of PERTURBATIONS) {
    const p = await run(venue);
    assert.notDeepEqual(venues(venue).kalshi, venues('base').kalshi, `${venue}: Kalshi prices actually perturbed`);
    assert.notDeepEqual(venues(venue).polymarket, venues('base').polymarket, `${venue}: Polymarket prices actually perturbed`);
    assert.deepEqual(p.bnd.venueHits, [], venue);
    assert.deepEqual(p.f.venueHits, [], `${venue}: no venue table, endpoint or binding reached`);
    assert.deepEqual(p.bnd.reads, base.bnd.reads, `${venue}: model input reads identical`);
    assert.deepEqual(p.f.reads, base.f.reads, `${venue}: cycle reads identical`);
    assert.equal(p.features, base.features, `${venue}: feature vectors byte-identical (sha256)`);
    assert.equal(p.forecast, base.forecast, `${venue}: V1 forecasts byte-identical (sha256)`);
    assert.equal(JSON.stringify(p.side), JSON.stringify(base.side), `${venue}: PBE side JSON byte-identical`);
    assert.equal(sha(p.side), GOLDEN_PBE_SIDE_SHA256, `${venue}: golden`);
  }
});

test('sportsbook prices are not V1 features either: a radical book move changes only the market comparison', async () => {
  const ra = fakePostgrest({ bookShift: 0 });
  const rb = fakePostgrest({ bookShift: 400 });
  const A = await withFetch(ra.handler, () => runCycle(ra.env, { trigger: 'admin', mode: 'dry_run', now: NOW }));
  const B = await withFetch(rb.handler, () => runCycle(rb.env, { trigger: 'admin', mode: 'dry_run', now: NOW }));
  const keep = (r) => pbeSide(r).map(({ bout_id, pick_fighter_id, pick_probability, prob_a, feature_vector, decision }) => ({ bout_id, pick_fighter_id, pick_probability, prob_a, feature_vector, decision }));
  assert.equal(JSON.stringify(keep(A)), JSON.stringify(keep(B)));
  const mk = (r) => JSON.stringify(r.cards.flatMap((c) => c.bouts.map((x) => x.market)));
  assert.notEqual(mk(A), mk(B), 'only the market comparison moved');
});
