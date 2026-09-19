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
  assert.equal(view.oddsWithRole(-130), '-130 · FAV');
  assert.equal(view.oddsWithRole(110), '+110 · DOG');
  assert.equal(view.oddsWithRole(100), '+100 · EVEN');
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

/* Upset Radar semantics, exercised through the real reader on a fixture.
 * A "market-opposite" call: the de-vigged market makes the OPPONENT the
 * favourite while PBE picks this fighter at better than 50%. */
const upsetBout = (n, { result, odds, devig, prob = 0.58, locked = true, graded = true }) => {
  const a = { id: `a-${n}`, name: `Pick ${n}` };
  const b = { id: `b-${n}`, name: `Opponent ${n}` };
  return {
    bout_id: `bout-${n}`, event_id: 'e', event_name: 'UFC X', event_date: '2026-09-19', event_slug: 'ufc-x', fight_slug: `f-${n}`,
    fighter_a: a, fighter_b: b, decision: 'ELIGIBLE', reasons: [], pick_fighter_id: a.id,
    market: { pick_consensus_odds: odds, pick_best_odds: odds, devigged_pick: devig, devigged_opponent: 1 - devig },
    prediction: { ...pred(a.id), id: `pred-${n}`, pick_probability: prob, locked_at: locked ? '2026-09-18T16:41:00Z' : null, market_implied_prob_pick: devig, model_edge_pts: (prob - devig) * 100 },
    grade: graded ? { result, revision: 1, graded_at: '2026-09-20T05:00:00Z', revision_reason: null } : null,
  };
};
async function upsetProofFor(bouts) {
  const file = join(mkdtempSync(join(tmpdir(), 'algo-upset-')), 'fx.json');
  writeFileSync(file, JSON.stringify({ bouts, record: { locked_predictions: bouts.length } }));
  process.env.PBE_ALGO_FIXTURE_FILE = file;
  try { return await algo.getAlgoUpsetProof(); } finally { delete process.env.PBE_ALGO_FIXTURE_FILE; }
}

test('PBE Upset Radar aggregate: a graded market-opposite LOSS can never drop out, and the showcase never edits the ledger', async () => {
  const WIN = upsetBout('win', { result: 'WIN', odds: 180, devig: 0.34 });
  const LOSS = upsetBout('loss', { result: 'LOSS', odds: 150, devig: 0.38 });
  const controls = [
    upsetBout('chalk', { result: 'WIN', odds: -200, devig: 0.64, prob: 0.7 }),        // market agrees with PBE: not an upset call
    upsetBout('unlocked', { result: 'WIN', odds: 200, devig: 0.32, locked: false }),   // never locked: not history
    upsetBout('ungraded', { result: 'WIN', odds: 200, devig: 0.32, graded: false }),   // no official grade yet: not history
  ];

  const proof = await upsetProofFor([WIN, LOSS, ...controls]);
  assert.equal(proof.total, 2, 'the WIN and the LOSS, and none of the controls');
  assert.equal(proof.wins, 1);
  assert.equal(proof.losses, 1);
  assert.equal(proof.decided, 2);
  assert.equal(proof.no_decision, 0);
  assert.equal(proof.hit_rate, 0.5, 'the hit rate carries the loss');
  assert.equal(proof.average_consensus_odds, 165, 'average price is over the whole ledger, loss included');
  assert.deepEqual(proof.biggest_wins.map((w) => w.prediction_id), ['pred-win'], 'the showcase is wins only');
  assert.ok(!JSON.stringify(proof.biggest_wins).includes('Opponent loss'), 'a loss is never a showcase card');

  /* The loss cannot be made to disappear: taking it out is the only way to get 1-0. */
  const withoutLoss = await upsetProofFor([WIN, ...controls]);
  assert.deepEqual([withoutLoss.total, withoutLoss.wins, withoutLoss.losses, withoutLoss.hit_rate], [1, 1, 0, 1]);
  assert.notDeepEqual([proof.total, proof.losses, proof.hit_rate], [withoutLoss.total, withoutLoss.losses, withoutLoss.hit_rate]);

  /* Showcase filtering (+120 or longer, wins only, top three) does not touch the aggregate:
   * a market-opposite WIN below the threshold is counted but not showcased. */
  const SHORT = upsetBout('short', { result: 'WIN', odds: 105, devig: 0.47, prob: 0.55 });
  const draw = upsetBout('draw', { result: 'DRAW', odds: 140, devig: 0.4 });
  const wider = await upsetProofFor([WIN, LOSS, SHORT, draw, ...controls]);
  assert.equal(wider.showcase_threshold_odds, 120);
  assert.deepEqual([wider.total, wider.wins, wider.losses, wider.decided, wider.no_decision], [4, 2, 1, 3, 1]);
  assert.equal(wider.hit_rate, 2 / 3);
  assert.deepEqual(wider.biggest_wins.map((w) => w.prediction_id), ['pred-win'], '+105 is in the record and not on the showcase');
  assert.ok(wider.biggest_wins.every((w) => w.result === 'WIN' && w.consensus_odds >= wider.showcase_threshold_odds));

  /* Many big wins: the showcase caps at three, the ledger keeps all of them and the loss. */
  const many = [200, 300, 400, 500].map((o, i) => upsetBout(`big${i}`, { result: 'WIN', odds: o, devig: 0.3 }));
  const capped = await upsetProofFor([...many, LOSS]);
  assert.deepEqual(capped.biggest_wins.map((w) => w.consensus_odds), [500, 400, 300]);
  assert.deepEqual([capped.total, capped.wins, capped.losses], [5, 4, 1]);
  assert.equal(capped.hit_rate, 0.8);

  /* The definition itself. */
  assert.equal(algo.isMarketOppositePick({ devigged_pick: 0.34, devigged_opponent: 0.66 }, 0.58), true);
  assert.equal(algo.isMarketOppositePick({ devigged_pick: 0.64, devigged_opponent: 0.36 }, 0.7), false, 'market already favours the pick');
  assert.equal(algo.isMarketOppositePick({ devigged_pick: 0.34, devigged_opponent: 0.66 }, 0.5), false, 'PBE must actually pick the fighter');
  assert.equal(algo.isMarketOppositePick(null, 0.58), false, 'no market, no upset call');
});

test('PBE Upset Radar aggregate, production read path: the same ledger rules over PostgREST rows', async () => {
  /* The fixture branch above and the database branch aggregate separately, so the
   * database branch gets the same proof: a second module instance with a database
   * configured, and fetch answered from rows shaped like the three real reads. */
  const rowsFor = (bouts) => ({
    ufc_model_predictions: bouts.filter((b) => b.prediction.locked_at).map((b) => ({
      id: b.prediction.id, bout_id: b.bout_id, locked_at: b.prediction.locked_at, pick_fighter_id: b.pick_fighter_id,
      pick_probability: String(b.prediction.pick_probability), market_implied_prob_pick: b.prediction.market_implied_prob_pick,
      model_edge_pts: b.prediction.model_edge_pts, sample_context: { market: b.market },
    })),
    ufc_model_prediction_current_grade: bouts.filter((b) => b.grade).map((b) => ({ prediction_id: b.prediction.id, result: b.grade.result })),
    ufc_bouts: bouts.map((b) => ({ id: b.bout_id, fighter_a: b.fighter_a, fighter_b: b.fighter_b, event: { name: b.event_name, event_date: b.event_date } })),
  });
  const realFetch = globalThis.fetch;
  const asked = [];
  let tables = {};
  process.env.SUPABASE_URL = 'https://db.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  try {
    globalThis.fetch = async (url) => {
      const path = String(url).split('/rest/v1/')[1];
      asked.push(path);
      return { ok: true, status: 200, json: async () => tables[path.split('?')[0]] ?? [] };
    };
    const db = await import('./algo.ts?production-read-path');

    const WIN = upsetBout('win', { result: 'WIN', odds: 180, devig: 0.34 });
    const LOSS = upsetBout('loss', { result: 'LOSS', odds: 150, devig: 0.38 });
    const SHORT = upsetBout('short', { result: 'WIN', odds: 105, devig: 0.47, prob: 0.55 });
    const controls = [
      upsetBout('chalk', { result: 'WIN', odds: -200, devig: 0.64, prob: 0.7 }),
      upsetBout('ungraded', { result: 'WIN', odds: 200, devig: 0.32, graded: false }),
    ];

    tables = rowsFor([WIN, LOSS, ...controls]);
    const proof = await db.getAlgoUpsetProof();
    assert.deepEqual([proof.total, proof.wins, proof.losses, proof.decided, proof.hit_rate], [2, 1, 1, 2, 0.5]);
    assert.equal(proof.average_consensus_odds, 165);
    assert.deepEqual(proof.biggest_wins.map((w) => [w.prediction_id, w.pick_name, w.result]), [['pred-win', 'Pick win', 'WIN']]);

    /* Only locked predictions are ever requested, and grades come from the official current-grade view. */
    assert.match(asked[0], /^ufc_model_predictions\?.*locked_at=not\.is\.null/);
    assert.ok(asked.some((q) => q.startsWith('ufc_model_prediction_current_grade?')));

    tables = rowsFor([WIN, LOSS, SHORT, ...controls]);
    const wider = await db.getAlgoUpsetProof();
    assert.deepEqual([wider.total, wider.wins, wider.losses], [3, 2, 1], 'the sub-threshold win is in the ledger');
    assert.equal(wider.hit_rate, 2 / 3);
    assert.deepEqual(wider.biggest_wins.map((w) => w.prediction_id), ['pred-win'], 'and the showcase is unchanged by it');

    tables = rowsFor([LOSS]);
    const onlyLoss = await db.getAlgoUpsetProof();
    assert.deepEqual([onlyLoss.total, onlyLoss.wins, onlyLoss.losses, onlyLoss.hit_rate, onlyLoss.biggest_wins.length], [1, 0, 1, 0, 0], 'a ledger of one loss reads 0-1, not empty');
  } finally {
    globalThis.fetch = realFetch;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  }
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
  assert.match(data, /marketOpponent > marketPick[\s\S]*modelPick > 0\.5/, 'Upset Radar requires the market to favor the opponent while PBE picks the opposite fighter');
  assert.match(data, /result === "WIN" && r\.consensus_odds >= UPSET_SHOWCASE_THRESHOLD_ODDS/, 'showcase cards are +120-or-longer wins');
  /* 'Losses stay in the aggregate' is proven by behavior in the next test, not by matching a comment. */

  assert.match(page, /getAlgoUpsetProof\(\)/);
  assert.match(page, /<PbeUpsetRadar access=\{access\} proof=\{upsetProof\} \/>/);
  assert.doesNotMatch(page, /getAlgoCards|getAlgoBout|getAlgoRecord|pick_probability|feature_vector/, 'public /pro does not directly read an upcoming call');
  assert.match(picksPage, /<PbeUpsetRadar access=\{access\} proof=\{upsetProof\} cards=\{cards\} imgs=\{imgs\} surface="picks" \/>/, 'Upset Radar must render its PBE Picks-native variant on the actual PBE PICKS route');
  assert.match(picksPage, /getAlgoUpsetProof\(\)/, 'PBE PICKS loads the historical upset ledger');
  assert.match(picksPage, /<aside className="pp-picks-sidecar" aria-label="PBE Upset Radar">/, 'Upset Radar is a sidecar, not the PBE Picks hero');
  assert.match(radar, /pbe-upset-rail-window/, 'PBE Picks uses the compact side-window variant');
  assert.match(radar, /UPSET RADAR[\s\S]*AUTO · 60S/, 'the rail advertises its automatic one-minute page refresh');
  assert.match(picksPage, /imgs=\{imgs\}/, 'PBE Picks passes its rights-cleared fighter portraits into Upset Radar');
  assert.match(radar, /pbe-upset-radar-svg/, 'Upset Radar includes the implemented radar visualization');
  assert.match(radar, /primaryImg\.card \|\| primaryImg\.portrait/, 'the live signal uses the selected fighter portrait already approved for PBE Picks');
  assert.match(radar, /getVerifiedDisplayImagesForFighters/, 'a live upset signal gets one targeted verified portrait fallback instead of text-only degradation');
  const picksCss = readFileSync(new URL('app/algo-picks.css', web), 'utf8');
  assert.match(picksCss, /@keyframes pbe-upset-radar-spin/, 'the side window has a real radar sweep');
  assert.match(picksCss, /\.pbe-upset-radar-scan-copy,[\s\S]*display: none !important/, 'the old text-only scanning placeholder is retired');
  assert.match(picksCss, /prefers-reduced-motion: reduce[\s\S]*pbe-upset-radar-svg \.scope-sweep/, 'radar animation respects reduced-motion');
  assert.match(radar, /WHY PBE SEES THE UPSET/, 'the live signal explains the model disagreement');
  assert.match(radar, /isMarketOppositePick\(b\.market, p\.pick_probability\)/, 'live Upset Radar uses the same market-opposite definition as the historical ledger');
  assert.match(radar, /Market favorite:/, 'the UI names the market favorite explicitly instead of using ambiguous favorite/underdog copy');
  assert.match(radar, /drivers\(p, b\.fighter_a\.id, b\.fighter_b\.id\)/, 'the explainer comes from model coefficient math, not generated copy');
  assert.match(radar, /stored pre-fight feature vector × the live model coefficients/, 'the explainer states its provenance');
  assert.match(radar, /mv\.state === "UNAVAILABLE"/, 'last-observed plus-money calls stay visible instead of dropping the fighter photo during a freshness handoff');
  /* The "LIVE UPSET / LAST OBSERVED" badge left with the compact rail (1098013). On the PBE Picks rail a
   * stale market is now labelled three ways, and its number is only ever the edge stored with that evaluation. */
  assert.match(radar, /edgePts: mv\.state === "CURRENT" \? \(mv\.delta \?\? [^\n]*\) : mv\.historicalDelta,/, 'a last-observed market never gets a current edge, only the stored one');
  assert.match(radar, /<em>\{x\.marketState === "CURRENT" \? "EDGE" : "LAST EDGE"\}<\/em>/, 'stale market state is labeled, never presented as live');
  assert.match(radar, /\{x\.marketState === "CURRENT" \? "edge" : "stored gap"\}/, 'the explainer sentence names a stored gap, not an edge');
  assert.match(radar, /<span>MARKET \{agoText\(x\.marketAgeMinutes\)\}<\/span>/, 'the age of the market is on the signal');
  /* The full /pro surface makes the same distinction as the rail: same stored number, different words. */
  assert.match(radar, /<em>\{x\.marketState === "CURRENT" \? "PBE EDGE" : "LAST EDGE"\}<\/em><b>\{deltaText\(x\.edgePts\)\}<\/b>/, '/pro: a current market says PBE EDGE, a last-observed one says LAST EDGE');
  assert.match(radar, /\$\{x\.marketState === "CURRENT" \? "probability-point gap" : "stored probability-point gap"\}/, '/pro: the stale thesis says stored');
  assert.match(radar, /x\.marketState === "CURRENT" \? "CURRENT MARKET" : `LAST OBSERVED · \$\{agoText\(x\.marketAgeMinutes\)\}`/, '/pro: the market state and its age are on the card');
  assert.doesNotMatch(radar, /<em>PBE EDGE<\/em>/, 'no surface labels an edge without checking the market state');

  /* Behavior behind those labels: what the component receives for each market state. */
  const NOW_ = Date.parse('2026-09-15T16:41:00Z');
  const staleMv = view.marketView({ status: 'STALE', devigged_pick: 0.1621, stale_delta_pts: 40.98, pbe_delta_pts: null, observed_at: '2026-09-15T13:06:08.935Z' }, { now: NOW_ });
  assert.deepEqual([staleMv.state, staleMv.delta, staleMv.historicalDelta], ['LAST_OBSERVED', null, 40.98], 'stale: no current edge exists, only the stored one');
  const freshMv = view.marketView({ status: 'FRESH', devigged_pick: 0.54, pbe_delta_pts: 10.12, observed_at: '2026-09-15T16:00:00Z', current_until: '2026-09-15T19:00:00Z' }, { now: NOW_ });
  assert.deepEqual([freshMv.state, freshMv.delta, freshMv.historicalDelta], ['CURRENT', 10.12, null]);
  const refresh = readFileSync(new URL('components/PbePicksAutoRefresh.tsx', web), 'utf8');
  assert.match(picksPage, /<PbePicksAutoRefresh intervalMs=\{60_000\} \/>/, 'PBE Picks refreshes the server tree every minute');
  assert.match(refresh, /router\.refresh\(\)/);
  assert.match(refresh, /visibilitychange/);
  assert.match(refresh, /navigator\.onLine/);

  assert.match(radar, /if \(access\.pro === true\) \{\s*const cards = providedCards \?\? await getAlgoCards\(access\);/, 'current fighter identities are fetched only after verified Pro access');
  assert.match(radar, /public ledger shows only already-graded historical proof/i);
  assert.match(radar, /No hindsight\. No backfill\. No edited losses\./);
  assert.doesNotMatch(radar, /Open full PBE Picks/, 'the PBE Picks page must never link to itself from Upset Radar');
  assert.match(radar, /AUTO-RANKED · EDGE FIRST/, 'the native PBE Picks surface shows signal state instead of redundant navigation');
  assert.match(radar, /MARKET[\s\S]*favors opponent[\s\S]*PBE[\s\S]*picks opposite/, 'the signal standard is explicit');
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
