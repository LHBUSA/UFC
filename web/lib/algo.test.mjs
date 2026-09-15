/* PBE Algo: presentation arithmetic and the Pro boundary.
 * Run: npm run test:algo
 *
 * Pinned: (1) the "why" panel is the model's own arithmetic in the picked
 * fighter's orientation, so a sign error cannot present a factor against the
 * pick as a factor for it; (2) every per-call reader refuses a caller without
 * UFC Pro, independent of the page; (3) public surfaces never import a
 * per-call reader or the call card; (4) the local QA fixture is refused on
 * Vercel. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./algo.test-hooks.mjs', import.meta.url);
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const artifact = JSON.parse(readFileSync(new URL('./generated/model-v1.json', import.meta.url), 'utf8'));
const view = await import('./algoView.ts');
const algo = await import('./algo.ts');

const LO = '00000000-0000-4000-8000-000000000001';
const HI = 'ffffffff-0000-4000-8000-000000000002';
const keys = artifact.features.map((f) => f.key);
const vec = Object.fromEntries(keys.map((k, i) => [k, ((i * 37) % 11 - 5) * artifact.model.feature_scale[k] * 0.2]));
const avail = Object.fromEntries(keys.map((k) => [k, true]));
const logit1 = keys.reduce((s, k) => s + artifact.model.coefficients[k] * (vec[k] / artifact.model.feature_scale[k]), 0);
const pred = (pick, over = {}) => ({ id: 'p', generated_at: '', locked_at: null, prob_a: 0.6, prob_b: 0.4, pick_fighter_id: pick, pick_probability: 0.6, confidence_band: '60-65', feature_vector: vec, feature_availability: avail, market_implied_prob_pick: null, model_edge_pts: null, ...over });

test('drivers are the canonical log-odds terms, re-signed for the picked corner', () => {
  const asLo = view.drivers(pred(LO), HI, LO); // corner order on the bout does not matter
  const asHi = view.drivers(pred(HI), LO, HI);
  assert.equal(asLo.available, 33);
  for (const d of asLo.supporting) assert.ok(d.contribution > 0);
  for (const d of asLo.opposing) assert.ok(d.contribution < 0);
  // Picking the other corner swaps the lists exactly.
  assert.deepEqual(asHi.supporting.slice(0, 3).map((d) => d.key), asLo.opposing.map((d) => d.key));
  const top = asLo.supporting[0];
  assert.ok(Math.abs(top.contribution - artifact.model.coefficients[top.key] * vec[top.key] / artifact.model.feature_scale[top.key]) < 1e-12);
  assert.ok(Math.abs(top.pickMinusOpponent - vec[top.key]) < 1e-12);
  assert.ok(Number.isFinite(logit1));
});

test('an unavailable feature is never listed as a reason', () => {
  const top = view.drivers(pred(LO), LO, HI).supporting[0].key;
  const d = view.drivers(pred(LO, { feature_availability: { ...avail, [top]: false } }), LO, HI);
  assert.equal(d.available, 32);
  assert.ok(![...d.supporting, ...d.opposing].some((x) => x.key === top));
  assert.equal(view.pickOriented(pred(HI, { feature_availability: { ...avail, sos_diff: false } }), LO, HI, 'sos_diff'), null);
  assert.equal(view.pickOriented(pred(HI), LO, HI, 'sos_diff'), -vec.sos_diff);
});

test('band evidence is the committed walk-forward row with a Wilson interval', () => {
  const e = view.bandEvidence(0.644);
  const row = artifact.evidence.by_confidence_band.find((r) => r.band === '60-65');
  assert.equal(e.band, '60-65');
  assert.equal(e.n, row.n);
  assert.ok(e.lo < e.hitRate && e.hitRate < e.hi && e.hi - e.lo < 0.06);
  assert.equal(view.bandEvidence(null), null);
});

test('status precedence: graded > locked > provisional > no call > awaiting', () => {
  const base = { decision: 'ELIGIBLE', prediction: pred(LO), grade: null };
  assert.equal(view.algoStatus({ ...base, grade: { result: 'WIN' } }).label, 'WIN');
  assert.equal(view.algoStatus({ ...base, prediction: pred(LO, { locked_at: '2026-09-18T16:41:00Z' }) }).label, 'LOCKED');
  assert.equal(view.algoStatus(base).label, 'PROVISIONAL');
  assert.equal(view.algoStatus({ decision: 'NO_MODEL_CALL', prediction: null, grade: null }).label, 'NO MODEL CALL');
  assert.equal(view.algoStatus({ decision: 'NOT_EVALUATED', prediction: null, grade: null }).label, 'AWAITING EVALUATION');
  assert.equal(view.lockedText('2026-09-18T16:41:00Z'), 'Sep 18 · 12:41 PM ET');
});

test('every per-call reader refuses a caller without UFC Pro', async () => {
  for (const denied of [{ pro: false }, {}, null]) {
    await assert.rejects(() => algo.getAlgoCards(denied), algo.ProRequiredError);
    await assert.rejects(() => algo.getAlgoRecord(denied), algo.ProRequiredError);
    await assert.rejects(() => algo.getAlgoBout(denied, LO), algo.ProRequiredError);
  }
  assert.deepEqual(await algo.getAlgoCards({ pro: true }), []);
});

test('the QA fixture is honoured locally and refused on Vercel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'algo-fx-'));
  const file = join(dir, 'fx.json');
  const bout = { bout_id: LO, event_id: 'e', event_name: 'UFC X', event_date: '2026-09-19', event_slug: 'ufc-x', fight_slug: 'a-vs-b', fighter_a: { id: LO, name: 'A' }, fighter_b: { id: HI, name: 'B' }, decision: 'ELIGIBLE', reasons: [], prediction: pred(LO), grade: null };
  writeFileSync(file, JSON.stringify({ bouts: [bout], record: { locked_predictions: 0 } }));
  process.env.PBE_ALGO_FIXTURE_FILE = file;
  try {
    assert.equal((await algo.getAlgoCards({ pro: true })).length, 1);
    process.env.VERCEL = '1';
    assert.deepEqual(await algo.getAlgoCards({ pro: true }), []);
    assert.equal(await algo.algoLive(), false);
  } finally {
    delete process.env.PBE_ALGO_FIXTURE_FILE;
    delete process.env.VERCEL;
  }
});

test('a stale market is never presented as a current edge', () => {
  const NOW = Date.parse('2026-09-15T16:41:00Z');
  const stale = view.marketView({ status: 'STALE', age_minutes: 14900, devigged_pick: 0.17, pbe_delta_pts: null, books: 5, observed_at: '2026-09-08T12:25:03Z', pick_consensus_odds: 491 }, { now: NOW });
  assert.equal(stale.state, 'LAST_OBSERVED');
  assert.equal(stale.delta, null);
  assert.equal(stale.pick.consensus, 491, 'last observed odds stay visible');
  assert.equal(view.marketView({ status: 'STALE', devigged_pick: 0.2, pbe_delta_pts: 40 }, { now: NOW }).delta, null, 'even a stored delta is withheld when stale');
  const legacy = view.marketView({ devigged_pick: 0.17, pbe_delta_pts: 39.9 }, { now: NOW });
  assert.equal(legacy.state, 'LAST_OBSERVED', 'a comparison with no status is treated as stale');
  const current = { status: 'FRESH', age_minutes: 155, devigged_pick: 0.5427, raw_implied_pick: 0.5652, pbe_delta_pts: 10.12, books: 6, observed_at: '2026-09-15T13:06:08.935Z', current_until: '2026-09-15T19:16:08.935Z', freshness_band: 'T-7d', fresh_limit_minutes: 730, pick_consensus_odds: -130, pick_best_odds: -130, pick_best_book: 'BetOnline.ag', opponent_fighter_id: 'p', opponent_consensus_odds: 110, opponent_best_odds: 111, opponent_best_book: 'BetOnline.ag' };
  const cur = view.marketView(current, { now: NOW });
  assert.equal(cur.state, 'CURRENT');
  assert.equal(cur.delta, 10.12);
  assert.equal(cur.pick.consensus, -130);
  assert.equal(cur.opponent.consensus, 110);
  assert.equal(view.agoText(cur.age), '3h 34m ago');
  /* The same stored comparison rendered after current_until: odds stay, edge goes. */
  const later = view.marketView(current, { now: Date.parse('2026-09-15T19:16:08.935Z') });
  assert.equal(later.state, 'LAST_OBSERVED');
  assert.equal(later.delta, null);
  /* A legacy FRESH row without current_until expires at observed_at + its stored limit. */
  assert.equal(view.marketView({ status: 'FRESH', devigged_pick: 0.5, pbe_delta_pts: 3, observed_at: '2026-09-15T15:40:00Z', fresh_limit_minutes: 60 }, { now: NOW }).state, 'LAST_OBSERVED');
  /* A locked call keeps the comparison it locked with. */
  assert.equal(view.marketView(current, { now: Date.parse('2026-09-25T00:00:00Z'), lockedAt: '2026-09-18T16:41:30Z' }).delta, 10.12);
  assert.equal(view.marketView(null).state, 'UNAVAILABLE');
  assert.equal(view.oddsText(-130), '-130');
  assert.equal(view.oddsText(110), '+110');
  assert.equal(view.oddsText(100), '+100');
  assert.equal(view.ageText(14900), '10.3 days');
  assert.equal(view.ageText(42), '42 min');
});

test('product claims follow active official calls, not registration', () => {
  const web = new URL('../', import.meta.url);
  for (const f of ['app/pro/page.tsx', 'app/fights/[slug]/page.tsx', 'components/StoryView.tsx']) {
    const src = readFileSync(new URL(f, web), 'utf8');
    assert.doesNotMatch(src, /algoLive\(/, `${f} must use algoCallsActive(), not algoLive()`);
  }
});

test('public surfaces never import a per-call reader or the call card', () => {
  const web = new URL('../', import.meta.url);
  for (const f of ['app/algo/page.tsx', 'app/pro/page.tsx', 'app/about/page.tsx', 'components/Market.tsx']) {
    const src = readFileSync(new URL(f, web), 'utf8');
    assert.doesNotMatch(src, /getAlgoCards|getAlgoBout|getAlgoRecord|AlgoPick|pick_probability|feature_vector/, f);
  }
  const card = readFileSync(new URL('app/algo/card/page.tsx', web), 'utf8');
  assert.match(card, /robots: \{ index: false/);
});

test('PBE PICKS is a primary nav item pointing at the existing /algo/card surface; no duplicate route', () => {
  const web = new URL('../', import.meta.url);
  const site = readFileSync(new URL('lib/site.ts', web), 'utf8');
  assert.match(site, /\{ href: "\/algo\/card", label: "PBE PICKS", place: "primary" \}/);
  assert.doesNotMatch(site, /href: "\/picks"/);
  const card = readFileSync(new URL('app/algo/card/page.tsx', web), 'utf8');
  assert.match(card, /<h1 className="pp-hero-title">PBE PICKS<\/h1>/);
  assert.match(card, /access\.pro && fighterIds\.length\s*\? await Promise\.all\(\[getImagesForFighters/, 'portraits and fighter rows are read only after the Pro gate');
  for (const f of ['app/algo/card/page.tsx', 'components/AlgoPick.tsx', 'lib/algo.ts', 'lib/algoView.ts']) {
    assert.doesNotMatch(readFileSync(new URL(f, web), 'utf8'), /shadow|challenger|training_run/i, `${f} must never touch shadow/challenger data`);
  }
  assert.match(card, /Official PropBetEdge model selections/);
  assert.match(card, /href="\/algo" className="btn">How PBE Algo works/);
  assert.match(card, /href="\/algo\/record" className="btn gold">Track Record/);
  assert.match(card, /const cards = access\.pro \? await getAlgoCards\(access\) : \[\];/, 'entitlement read unchanged');
  let picksRoute = true;
  try { readFileSync(new URL('app/picks/page.tsx', web)); } catch { picksRoute = false; }
  assert.equal(picksRoute, false);
});
