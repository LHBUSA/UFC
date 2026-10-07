// V2 research invariants. node --test scripts/model/v2/v2.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FEATURE_KEYS } from '../feature_spec.mjs';
import { eloLadder, chooseEloK, ELO_START, opponentQuality, slimSnapshot, extendRow, swapExtra, C2_KEYS, C3_KEYS } from './features_v2.mjs';
import { fitGbm, gbmPredict } from './gbm.mjs';
import { fitShrinkage, applyShrinkage, multiplier } from './shrinkage.mjs';

/* deterministic PRNG for synthetic data */
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

test('Elo: ratings for a date are read before that date\'s results are applied', () => {
  const bouts = [
    { id: 'b1', date: '2020-01-01', f1: 'A', f2: 'B', winner: 'A' },
    { id: 'b2', date: '2020-01-01', f1: 'A', f2: 'C', winner: 'A' }, // same date: must not see b1's result
    { id: 'b3', date: '2020-02-01', f1: 'A', f2: 'D', winner: 'D' },
  ];
  const r = eloLadder(bouts, 32);
  assert.deepEqual(r.get('b1'), { r1: ELO_START, r2: ELO_START, n1: 0, n2: 0 });
  assert.deepEqual(r.get('b2'), { r1: ELO_START, r2: ELO_START, n1: 0, n2: 0 });
  assert.ok(r.get('b3').r1 > ELO_START && r.get('b3').n1 === 2);
});

test('Elo: K is chosen on pre-era bouts only - later results cannot move it', () => {
  const R = rng(3);
  const fighters = Array.from({ length: 40 }, (_, i) => `F${i}`);
  const early = Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, date: `2010-${String(1 + (i % 12)).padStart(2, '0')}-01`, f1: fighters[i % 40], f2: fighters[(i * 7 + 3) % 40], winner: null }))
    .filter((b) => b.f1 !== b.f2).map((b) => ({ ...b, winner: R() < 0.6 ? b.f1 : b.f2 }));
  const late = early.map((b, i) => ({ ...b, id: `l${i}`, date: '2020-06-01', winner: R() < 0.5 ? b.f1 : b.f2 }));
  const a = chooseEloK(early, '2013-01-01');
  const b = chooseEloK([...early, ...late], '2013-01-01');
  assert.equal(a.k, b.k);
  assert.deepEqual(a.scan, b.scan);
});

const snap = (asOf, o) => slimSnapshot({ as_of_date: asOf, sample_stat_bouts: 4, m_sig_diff_per_min: o.sd, m_sig_landed_per_min: 4, m_sig_absorbed_per_min: 3, m_control_share: 0.2, record: { appearances: 5 }, finished_by: { ko_tko: 1 } });
const POP = { sig_diff: 0, ctrl: 0.15, ko_loss: 0.1 };

test('opponent quality is point-in-time: deleting everything dated on/after D leaves it unchanged', () => {
  const rows = [
    { event_date: '2019-01-01', opponent_id: 'O1', outcome: 'W', observed_seconds: 900, stats_coverage: 'complete', totals: { sig_l: 60 }, opp_totals: { sig_l: 40 } },
    { event_date: '2020-01-01', opponent_id: 'O2', outcome: 'L', observed_seconds: 600, stats_coverage: 'complete', totals: { sig_l: 30 }, opp_totals: { sig_l: 50 } },
    { event_date: '2021-06-01', opponent_id: 'O3', outcome: 'W', observed_seconds: 900, stats_coverage: 'complete', totals: { sig_l: 90 }, opp_totals: { sig_l: 10 } }, // the target bout and later
  ];
  const full = new Map([
    ['O1', [snap('2018-06-01', { sd: 1.2 }), snap('2019-01-02', { sd: 9 })]],
    ['O2', [snap('2019-06-01', { sd: -0.5 }), snap('2021-07-01', { sd: 9 })]],
    ['O3', [snap('2021-01-01', { sd: 2 })]],
  ]);
  const D = '2021-06-01';
  const truncated = new Map([...full].map(([k, v]) => [k, v.filter((s) => s.as_of_date < D)]));
  const a = opponentQuality(rows, full, D, POP);
  const b = opponentQuality(rows.filter((r) => r.event_date < D), truncated, D, POP);
  assert.deepEqual(a, b);
  /* O1 is measured as of 2019-01-01 (1.2), not by its later 9; O2 as of 2020-01-01 (-0.5). */
  assert.equal(a.opp_sigdiff, (1.2 - 0.5) / (2 + 2));
});

function syntheticRow(R) {
  const side = () => ({
    prior_bouts: Math.floor(R() * 12), stat_bouts: Math.floor(R() * 10), age_years: 22 + R() * 15, reach_in: 66 + R() * 10,
    td_landed_per15: R() * 4, td_defense: R(), kd_per15: R(), ko_loss_rate: R() * 0.4, slpm: 2 + R() * 4, sig_defense: 0.4 + R() * 0.3,
  });
  const s1 = side(), s2 = side();
  const x = FEATURE_KEYS.map(() => (R() - 0.5) * 2);
  return { s1, s2, x, scheduled_rounds: R() < 0.2 ? 5 : 3, weight_class: R() < 0.3 ? 'HEAVYWEIGHT' : 'LIGHTWEIGHT', is_title: R() < 0.1 };
}

test('V2 features are exactly antisymmetric under a corner swap', () => {
  const R = rng(11);
  for (let i = 0; i < 200; i++) {
    const g = syntheticRow(R);
    const extra = { elo: { r1: 1400 + R() * 300, r2: 1400 + R() * 300 }, oq1: { opp_sigdiff: R(), opp_ctrl: R(), opp_durability: R(), perf_vs_expect: R(), dna_quality_wins: R() }, oq2: { opp_sigdiff: R(), opp_ctrl: R(), opp_durability: R(), perf_vs_expect: R(), dna_quality_wins: R() }, snap1: { dist_share: R() }, snap2: { dist_share: R() } };
    const row = { x: g.x, side_1: g.s1, side_2: g.s2, scheduled_rounds: g.scheduled_rounds, weight_class: g.weight_class, is_title: g.is_title };
    const swapped = { x: g.x.map((v) => -v), side_1: g.s2, side_2: g.s1, scheduled_rounds: g.scheduled_rounds, weight_class: g.weight_class, is_title: g.is_title };
    const a = extendRow(row, extra), b = extendRow(swapped, swapExtra(extra));
    assert.equal(a.c2.length, C2_KEYS.length);
    assert.equal(a.c3.length, C3_KEYS.length);
    a.c2.forEach((v, j) => assert.ok(Math.abs(v + b.c2[j]) < 1e-12, `${C2_KEYS[j]} not antisymmetric`));
    a.c3.forEach((v, j) => assert.ok(Math.abs(v + b.c3[j]) < 1e-12, `${C3_KEYS[j]} not antisymmetric`));
  }
});

test('GBM: p(x) + p(-x) = 1 exactly, and fitting is deterministic', () => {
  const R = rng(5);
  const X = Array.from({ length: 600 }, () => [R() - 0.5, R() - 0.5, R() - 0.5]);
  const y = X.map((x) => (x[0] + 0.5 * x[1] * Math.abs(x[1]) + (R() - 0.5) * 0.6 > 0 ? 1 : 0));
  const m1 = fitGbm(X, y, { maxTrees: 30, minLeaf: 20 });
  const m2 = fitGbm(X, y, { maxTrees: 30, minLeaf: 20 });
  for (const x of X.slice(0, 100)) {
    assert.ok(Math.abs(gbmPredict(m1, x) + gbmPredict(m1, x.map((v) => -v)) - 1) < 1e-12);
    assert.equal(gbmPredict(m1, x), gbmPredict(m2, x));
  }
  assert.equal(gbmPredict(m1, [0, 0, 0]), 0.5);
});

test('shrinkage keeps complementarity, is symmetric in the corners, and refuses tiny samples', () => {
  const R = rng(9);
  const oof = Array.from({ length: 800 }, () => {
    const p = 0.2 + R() * 0.6;
    return { p, y: R() < p ? 1 : 0, min_prior_bouts: Math.floor(R() * 10), min_stat_bouts: Math.floor(R() * 8), available_count: 20 + Math.floor(R() * 14), features_total: 33 };
  });
  const shr = fitShrinkage(oof);
  assert.ok(shr && shr.c.length === 4);
  for (const r of oof.slice(0, 50)) {
    const a = applyShrinkage(shr, r.p, r), b = applyShrinkage(shr, 1 - r.p, r);
    assert.ok(Math.abs(a + b - 1) < 1e-12);
    assert.ok(Number.isFinite(multiplier(shr, r)));
  }
  assert.equal(fitShrinkage(oof.slice(0, 100)), null);
  assert.equal(applyShrinkage(null, 0.7, oof[0]), 0.7);
});

test('no V2 research file reads a market price', () => {
  for (const f of ['features_v2.mjs', 'gbm.mjs', 'shrinkage.mjs']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/market|odds|price/i.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), `${f} references market data`);
  }
  const research = fs.readFileSync(new URL('research.mjs', import.meta.url), 'utf8');
  assert.ok(!/market\.jsonl|ufc_market_observations/.test(research), 'research.mjs must not load the market extract');
});
