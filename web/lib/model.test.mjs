/* PBE MODEL card arithmetic and the tracker's empty states.
 * Run: npm run test:model
 *
 * Two things are pinned here. First, the subtraction the card puts on screen:
 * a sign error in the edge would read as a confident recommendation to back
 * the wrong corner, and it would look entirely plausible. Second, the empty
 * state, because the whole product claim is that the live record starts at
 * nothing and says so - a bug that renders 0-0 as though picks had been
 * published and lost would be worse than a crash.
 *
 * See model.test-hooks.mjs for what node needs stubbed to import model.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./model.test-hooks.mjs', import.meta.url);

/* model.ts reads its connection at module scope. Placeholders: nothing in this
   file makes a request, and a real key must never be needed to run tests. */
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key-not-a-real-credential';

const {
  pickSide, marketProbForPick, modelEdgePts, bandOf, bandEvidence, pct, pts, num3,
  PRE_LAUNCH_REASON, MODEL,
} = await import('./model.ts');

const { SPECIMEN, SPECIMEN_UNDERDOG, SPECIMEN_NO_MARKET } = await import('./model.fixtures.mjs');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !== ${b}`);

/* ---- the card's arithmetic ------------------------------------------- */

test('the picked side is the higher probability, either way round', () => {
  const fwd = pickSide({ name: 'A', prob: 0.618 }, { name: 'B', prob: 0.382 });
  assert.equal(fwd.pick.name, 'A');
  assert.equal(fwd.aFavoured, true);

  const rev = pickSide({ name: 'A', prob: 0.382 }, { name: 'B', prob: 0.618 });
  assert.equal(rev.pick.name, 'B');
  assert.equal(rev.aFavoured, false);
});

test('an exact coin flip picks corner A rather than throwing', () => {
  const { pick, aFavoured } = pickSide({ name: 'A', prob: 0.5 }, { name: 'B', prob: 0.5 });
  assert.equal(pick.name, 'A');
  assert.equal(aFavoured, true);
});

test('the market probability is read on the side the MODEL picked', () => {
  // Model likes A, market quotes A at 0.554: same corner, use it directly.
  near(marketProbForPick(0.554, true), 0.554);
  // Model likes B: the market number for B is one minus the number for A.
  near(marketProbForPick(0.554, false), 0.446);
});

test('the edge is model minus market in percentage points, and keeps its sign', () => {
  const fwd = pickSide(SPECIMEN.a, SPECIMEN.b);
  const market = marketProbForPick(SPECIMEN.marketImpliedA, fwd.aFavoured);
  near(modelEdgePts(fwd.pick.prob, market), SPECIMEN.expectedEdgePts, 1e-9);

  // The mirror case. If the sign were dropped anywhere, this reads positive.
  const rev = pickSide(SPECIMEN_UNDERDOG.a, SPECIMEN_UNDERDOG.b);
  const revMarket = marketProbForPick(SPECIMEN_UNDERDOG.marketImpliedA, rev.aFavoured);
  near(modelEdgePts(rev.pick.prob, revMarket), SPECIMEN_UNDERDOG.expectedEdgePts, 1e-9);
  assert.ok(modelEdgePts(rev.pick.prob, revMarket) > 0);

  // And a genuinely negative edge stays negative.
  assert.ok(modelEdgePts(0.55, 0.62) < 0);
});

test('no price means no edge, never a zero', () => {
  const { pick, aFavoured } = pickSide(SPECIMEN_NO_MARKET.a, SPECIMEN_NO_MARKET.b);
  const market = marketProbForPick(SPECIMEN_NO_MARKET.marketImpliedA, aFavoured);
  assert.equal(market, null);
  assert.equal(modelEdgePts(pick.prob, market), null);
  assert.equal(marketProbForPick(undefined, true), null);
  assert.equal(marketProbForPick(Number.NaN, true), null);
});

/* ---- bands and formatting -------------------------------------------- */

test('confidence bands fold both corners onto the same label', () => {
  assert.equal(bandOf(0.618), '60-65');
  assert.equal(bandOf(0.382), '60-65', 'the underdog side of the same fight must land in the same band');
  assert.equal(bandOf(0.5), '50-55');
  assert.equal(bandOf(0.999), '80-100');
  assert.equal(bandOf(0.001), '80-100');
});

test('band labels match the values the prediction table constrains', () => {
  const allowed = new Set(['50-55', '55-60', '60-65', '65-70', '70-80', '80-100']);
  for (const p of [0.5, 0.54, 0.57, 0.62, 0.68, 0.75, 0.9, 0.999]) {
    assert.ok(allowed.has(bandOf(p)), `${p} produced band ${bandOf(p)}`);
  }
  for (const row of MODEL.evidence.by_confidence_band) {
    assert.ok(allowed.has(row.band), `backtest reported band ${row.band}, which the schema would reject`);
  }
});

test('band evidence comes from the backtest and reports its sample size', () => {
  const e = bandEvidence(0.618);
  assert.equal(e.band, '60-65');
  assert.ok(e.n > 0);
  assert.ok(e.hit_rate > 0.5 && e.hit_rate < 1);
});

test('a missing number formats as an em dash, never as zero', () => {
  assert.equal(pct(null), '—');
  assert.equal(pct(undefined), '—');
  assert.equal(num3(null), '—');
  assert.equal(pts(null), '—');
  assert.equal(pct(0), '0.0%', 'a real zero still prints as zero');
});

test('the edge is signed in the copy the reader sees', () => {
  assert.equal(pts(6.4), '+6.4 pts');
  assert.ok(pts(-6.4).startsWith('−'), 'a negative edge should use a real minus sign');
});

/* ---- the empty state -------------------------------------------------- */

test('the pre-launch reason says nothing about deployments', () => {
  const forbidden = ['migration', 'provisioned', 'environment', 'supabase', '010', '011'];
  for (const word of forbidden) {
    assert.ok(!PRE_LAUNCH_REASON.toLowerCase().includes(word),
      `public copy leaks the implementation detail "${word}": ${PRE_LAUNCH_REASON}`);
  }
  assert.ok(/lock/i.test(PRE_LAUNCH_REASON));
});

test('the released artifact is a candidate and carries no live record', () => {
  // A guard against shipping a model marked live before anyone decided to.
  assert.equal(MODEL.model.status, 'candidate');
  assert.ok(MODEL.evidence.out_of_sample.n > 1000);
  assert.equal(MODEL.evidence.market.n, 0, 'market benchmark should still be empty');
});

test('every worked example on the page is a backtest bout with a real result', () => {
  assert.ok(MODEL.examples.length >= 3);
  for (const e of MODEL.examples) {
    assert.ok(['WIN', 'LOSS'].includes(e.outcome));
    assert.ok(e.bout_id && e.event_date && e.winner_name);
    // Fabricated names would defeat the point of showing real calls.
    assert.notEqual(e.fighter_a.name, 'Fighter A');
    assert.notEqual(e.fighter_b.name, 'Fighter B');
    near(e.fighter_a.prob + e.fighter_b.prob, 1, 1e-9);
  }
  assert.ok(MODEL.examples.some((e) => e.outcome === 'LOSS'), 'the page must show the model being wrong');
});
