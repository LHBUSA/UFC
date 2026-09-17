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
  assert.equal(stale.historicalDelta, null, 'a stored STALE row without a stored stale delta has no historical edge');
  const storedStale = view.marketView({ status: 'STALE', devigged_pick: 0.1621, stale_delta_pts: 40.98, pbe_delta_pts: null, observed_at: '2026-09-15T13:06:08.935Z' }, { now: NOW });
  assert.equal(storedStale.delta, null, 'never a current edge');
  assert.equal(storedStale.historicalDelta, 40.98, 'the edge stored with that same evaluation is shown as history');
  assert.equal(storedStale.implied, 0.1621);
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
  assert.equal(later.historicalDelta, 10.12, 'expired at render: the stored pair becomes history, not a recomputation');
  assert.equal(cur.historicalDelta, null, 'a current market has no historical edge');
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

test('PBE Upset Radar exposes only graded locked history publicly and gates current fighter calls behind Pro', () => {
  const web = new URL('../', import.meta.url);
  const data = readFileSync(new URL('lib/algo.ts', web), 'utf8');
  const page = readFileSync(new URL('app/pro/page.tsx', web), 'utf8');
  const picksPage = readFileSync(new URL('app/algo/card/page.tsx', web), 'utf8');
  const radar = readFileSync(new URL('components/PbeUpsetRadar.tsx', web), 'utf8');

  assert.match(data, /export async function getAlgoUpsetProof\(\)/);
  assert.match(data, /locked_at=not\.is\.null/, 'historical proof can only come from locked predictions');
  assert.match(data, /ufc_model_prediction_current_grade/, 'historical proof requires an official current grade');
  assert.match(data, /odds <= UPSET_THRESHOLD_ODDS/, 'underdog classification is mechanical: consensus must be longer than +100');
  assert.match(data, /result === "WIN" && r\.consensus_odds >= UPSET_SHOWCASE_THRESHOLD_ODDS/, 'showcase cards are +120-or-longer wins');
  assert.match(data, /The record above includes every graded PBE underdog call|every graded underdog call so losses cannot disappear/i, 'losses stay in the aggregate');

  assert.match(page, /getAlgoUpsetProof\(\)/);
  assert.match(page, /<PbeUpsetRadar access=\{access\} proof=\{upsetProof\} \/>/);
  assert.doesNotMatch(page, /getAlgoCards|getAlgoBout|getAlgoRecord|pick_probability|feature_vector/, 'public /pro does not directly read an upcoming call');
  assert.match(picksPage, /<PbeUpsetRadar access=\{access\} proof=\{upsetProof\} cards=\{cards\} surface="picks" \/>/, 'Upset Radar must render its PBE Picks-native variant on the actual PBE PICKS route');
  assert.match(picksPage, /getAlgoUpsetProof\(\)/, 'PBE PICKS loads the historical upset ledger');
  assert.match(picksPage, /<aside className="pp-picks-sidecar" aria-label="PBE Upset Radar">/, 'Upset Radar is a sidecar, not the PBE Picks hero');
  assert.match(radar, /pbe-upset-rail-window/, 'PBE Picks uses the compact side-window variant');
  assert.match(radar, /UPSET RADAR[\s\S]*WATCHING/, 'the rail keeps a visible status tab even when no live signal exists');

  assert.match(radar, /if \(access\.pro === true\) \{\s*const cards = providedCards \?\? await getAlgoCards\(access\);/, 'current fighter identities are fetched only after verified Pro access');
  assert.match(radar, /public ledger shows only already-graded historical proof/i);
  assert.match(radar, /No hindsight\. No backfill\. No edited losses\./);
  assert.doesNotMatch(radar, /Open full PBE Picks/, 'the PBE Picks page must never link to itself from Upset Radar');
  assert.match(radar, /AUTO-RANKED · EDGE FIRST/, 'the native PBE Picks surface shows signal state instead of redundant navigation');
  assert.match(radar, /PBE PICK[\s\S]*PLUS MONEY[\s\S]*CURRENT SNAPSHOT/, 'the signal standard is explicit');
});

test('PBE PICKS is a primary nav item pointing at the existing /algo/card surface; no duplicate route', () => {
  const web = new URL('../', import.meta.url);
  const site = readFileSync(new URL('lib/site.ts', web), 'utf8');
  assert.match(site, /\{ href: "\/algo\/card", label: "PBE PICKS", place: "primary", flagship: true \}/);
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
  assert.match(card, /access\.pro \? getAlgoCards\(access\) : Promise\.resolve\(\[\]\)/, 'entitlement gate remains in front of the PBE Picks read');
  let picksRoute = true;
  try { readFileSync(new URL('app/picks/page.tsx', web)); } catch { picksRoute = false; }
  assert.equal(picksRoute, false);
});

/* ---- flagship product copy: pinned to what production runs ---------------- */

test('product copy constants mirror the production eligibility rules and fight-week windows', async () => {
  const prod = await import('../../scripts/model/eligibility.mjs');
  const cadence = await import('../../scripts/odds/fight_week_cadence.mjs');
  const product = await import('./pbeProduct.ts');
  const R = product.ALGO_RULES;
  assert.equal(R.minPriorBoutsPerCorner, prod.RULES.minPriorBoutsPerCorner);
  assert.equal(R.minFeaturesAvailable, prod.RULES.minFeaturesAvailable);
  assert.equal(R.minPickProbability, prod.RULES.minPickProbability);
  assert.deepEqual({ ...R.high }, { ...prod.RULES.high });
  /* Medium has no named constant in production: pin it by behaviour. */
  const row = { min_prior_bouts: 9, available_count: 33 };
  assert.equal(prod.confidenceLabel(R.medium.minPickProbability - 1e-9, row), 'LEAN');
  assert.equal(prod.confidenceLabel(R.medium.minPickProbability, row), 'MEDIUM');
  assert.equal(prod.confidenceLabel(R.high.minPickProbability, row), 'HIGH');
  assert.equal(prod.confidenceLabel(0.95, { min_prior_bouts: R.high.minPriorBoutsPerCorner - 1, available_count: 33 }), 'MEDIUM', 'thin samples capped at Medium');
  assert.deepEqual(product.FIGHT_WEEK_WINDOWS.map((w) => [w.band, w.captureEveryMinutes, w.currentMinutes]), cadence.FIGHT_WEEK_BANDS.map((b) => [b.band, b.intervalMinutes, b.currentMinutes]));
  assert.equal(product.MODEL_FACTS.featureCount, artifact.features.length);
  assert.equal(product.MODEL_FACTS.featureCount, 33);
  assert.equal(product.MODEL_FACTS.sportsbookInputs, 0);
  assert.match(product.RULE_TEXT.confidence, /Lean below 60%, Medium from 60%, High from 70%/);
  assert.equal(view.REASON_COPY.INSUFFICIENT_FEATURES, 'Fewer than 20 of 33 features available');
  assert.equal(view.REASON_COPY.LOW_CONFIDENCE, 'Too close to call (below 55%)');
});

test('the /model explainer is illustrative, uses the production price math, and reads 64.0 / 54.0 / +10.0', async () => {
  const product = await import('./pbeProduct.ts');
  const { impliedFromAmerican } = await import('../../scripts/model/market_baseline.mjs');
  for (const price of [-130, 108, 100, -100, 491, -700]) assert.equal(product.impliedFromAmerican(price), impliedFromAmerican(price));
  const x = product.illustrativeEdge();
  assert.equal((x.modelProbability * 100).toFixed(1), '64.0');
  assert.equal((x.devigPick * 100).toFixed(1), '54.0');
  assert.equal(x.edgePts.toFixed(1), '10.0');
  assert.ok(x.overround > 1, 'raw implied carries the vig');
  const page = readFileSync(new URL('../app/model/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /Illustrative example — not a current pick/);
  assert.match(page, /illustrativeEdge\(\)/);
});

test('public PBE surfaces carry no stale pre-launch copy and never read a call', () => {
  const web = new URL('../', import.meta.url);
  const customer = ['app/model/page.tsx', 'app/algo/page.tsx', 'app/algo/card/page.tsx', 'app/algo/record/page.tsx', 'app/pro/page.tsx', 'components/ProPreview.tsx', 'components/AlgoPick.tsx', 'components/PbeFamilyNav.tsx', 'lib/model.ts'];
  for (const f of customer) {
    const src = readFileSync(new URL(f, web), 'utf8');
    assert.doesNotMatch(src, /PBE delta/i, `${f}: customer copy says PBE Edge`);
    assert.doesNotMatch(src, /no live pick/i, `${f}: PBE Picks are live`);
    assert.doesNotMatch(src, /after (official )?weigh-ins/i, `${f}: weigh-ins are not a lock prerequisite`);
  }
  const model = readFileSync(new URL('app/model/page.tsx', web), 'utf8');
  assert.doesNotMatch(model, /· candidate|picks at 65% or better/, 'no candidate eyebrow or stale threshold on /model');
  for (const f of ['app/model/page.tsx', 'components/PbeFamilyNav.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(f, web), 'utf8'), /getAlgoCards|getAlgoBout|getAlgoRecord|AlgoPick|pick_probability|feature_vector|model_edge_pts/, `${f} must not read a call`);
  }
  assert.match(model, /access\.pro\s*\? <Link href="\/algo\/card" className="btn gold mdl-cta-main">Open PBE Picks<\/Link>\s*: <Link href="\/pro" className="btn gold mdl-cta-main">Unlock PBE Picks<\/Link>/);
});

test('last observed market reads as history, never Hidden, and never recomputes the edge on the web', () => {
  const card = readFileSync(new URL('../components/AlgoPick.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(card, />Hidden<|"Hidden"|Not current<|Not recorded/, 'customer copy uses Last observed / Unavailable');
  assert.match(card, /Last observed · not current/);
  assert.match(card, /const histDelta = lastObserved \? mv\.historicalDelta : null;/, 'the historical edge is the stored value');
  assert.doesNotMatch(card, /pick_probability\s*-\s*mv\.implied|prob\s*-\s*mv\.implied/, 'no web-side edge arithmetic');
});

test('PBE PICKS nav treatment: flagship class, PRO badge (never LIVE), reduced motion respected', () => {
  const web = new URL('../', import.meta.url);
  const nav = readFileSync(new URL('components/NavLinks.tsx', web), 'utf8');
  assert.match(nav, /className="nav-pbe-picks"/);
  assert.match(nav, /<span className="nav-pro">PRO<\/span>/);
  assert.doesNotMatch(nav, />LIVE</);
  assert.match(nav, /<span>\{n\.label\}<\/span>/, 'the visible label is the registry label, unchanged');
  const css = readFileSync(new URL('app/pbe-flagship.css', web), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.nav-signal \{ animation: none; \}/);
  assert.deepEqual([...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]), ['nav-signal-breathe'], 'the signal dot is the only animation');
});

test('bout market read path: refreshed prediction context first for unlocked calls; locked and no-call rows unchanged', () => {
  const evalOld = { decision: 'ELIGIBLE', market: { status: 'FRESH', observed_at: '2026-09-15T13:06:08.935Z' } };
  const refreshed = { status: 'FRESH', observed_at: '2026-09-15T18:57:09.217Z' };
  assert.equal(view.selectBoutMarket({ locked_at: null, sample_context: { market: refreshed } }, evalOld), refreshed, 'unlocked: the A+ refreshed context wins over the hourly evaluation');
  assert.equal(view.selectBoutMarket({ locked_at: null, sample_context: {} }, evalOld), evalOld.market, 'falls back to the latest evaluation');
  assert.equal(view.selectBoutMarket({ locked_at: '2026-09-18T16:41:30Z', sample_context: { market: evalOld.market } }, { decision: 'ELIGIBLE', market: refreshed }), evalOld.market, 'locked: exactly the stored lock-time context');
  assert.equal(view.selectBoutMarket({ locked_at: null, sample_context: { market: refreshed } }, { decision: 'NO_MODEL_CALL', market: null }), null, 'no-calls stay evaluation-driven');
  assert.equal(view.selectBoutMarket(null, evalOld), evalOld.market);
  assert.equal(view.selectBoutMarket(null, undefined), null);
  const src = readFileSync(new URL('./algo.ts', import.meta.url), 'utf8');
  assert.match(src, /market: selectBoutMarket\(p, e\),/);
});
