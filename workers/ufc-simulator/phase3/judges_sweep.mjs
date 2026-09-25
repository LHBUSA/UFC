// Draw calibration (Phase 3B): three-judge decision model, offline.
//
// The engine scores each round once and decides a bout on that ONE card: a draw is any even card. UFC decisions come
// from three judges who disagree on close rounds, and a bout is drawn only on a majority (2+ even cards) or a split
// draw. This sweep re-scores simulated fights with three judges, each seeing the round margin plus independent noise
// (sd `sigma`, in round-score points), under the published PBE round rule, and reports the decision mix against the
// historical record (2015+, decisions incl. draws):
//   3 rd  unanimous 77.4%  split 19.6%  majority 1.4%  draw 1.56%   10-8 per judge-round <= 4.96%  even cards 1.47%
//   5 rd  unanimous 78.3%  split 17.4%  majority 2.6%  draw 1.70%   10-8 per judge-round <= 7.49%  even cards 1.70%
//
//   node --max-old-space-size=8192 phase3/judges_sweep.mjs [--sample 400] [--n 300] [--variants 40:14:0,40:14:6]
import fs from 'node:fs';
import path from 'node:path';
import { buildCohort, boutInput, CACHE } from './dataset.mjs';
import { profileFromSnapshot } from '../src/engine/inputs.mjs';
import { prepareContext, simulateFight, STAT, NSTAT } from '../src/engine/fight.mjs';
import { fightRng } from '../src/engine/rng.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';
import { canonicalOrder } from '../src/engine/fingerprint.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SAMPLE = Number(opt('--sample', 400)), N = Number(opt('--n', 300)), FROM = Number(opt('--from', 2019));
const tilts = new Map(fs.readFileSync(path.join(CACHE, 'eval_fold_n2000.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.anchor && Number.isFinite(r.anchor.tilt)).map((r) => [r.bout_id, r.anchor.tilt]));
const { cohort } = buildCohort();
const elig = cohort.filter((c) => c.year >= FROM && tilts.has(c.bout_id));
const five = elig.filter((c) => c.scheduled_rounds === 5), three = elig.filter((c) => c.scheduled_rounds !== 5);
const pick = (xs, n) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
const sample = [...pick(three, Math.round(SAMPLE * 0.75)), ...pick(five, Math.round(SAMPLE * 0.25))];

// Deterministic normal stream for judge noise (independent of the fight stream).
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(u) { return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); }

function roundMargin(stats, r, P, tilt) {
  const sc = P.score;
  const rs = [0, 1].map((i) => { const o = (r * 2 + i) * NSTAT; return sc.head * stats[o + STAT.head_l] + sc.body * stats[o + STAT.body_l] + sc.leg * stats[o + STAT.leg_l] + sc.kd * stats[o + STAT.kd] + sc.td * stats[o + STAT.td_l] + sc.ctrl_per_min * (stats[o + STAT.ctrl] / 60) + sc.sub * stats[o + STAT.sub]; });
  return { margin: rs[0] - rs[1] + tilt * P.tilt.round_w, kd0: stats[(r * 2) * NSTAT + STAT.kd], kd1: stats[(r * 2 + 1) * NSTAT + STAT.kd] };
}
function score(m, kd0, kd1, sc) {
  let s1 = 10, s2 = 10;
  if (m > sc.draw_eps) { s2 = 9; if (m >= sc.ten_eight_margin || (kd0 >= 1 && m >= sc.ten_eight_kd_margin)) s2 = 8; }
  else if (m < -sc.draw_eps) { s1 = 9; if (-m >= sc.ten_eight_margin || (kd1 >= 1 && -m >= sc.ten_eight_kd_margin)) s1 = 8; }
  return [s1, s2];
}

const variants = opt('--variants', '40:14:0,40:14:4,40:14:6,40:14:8,45:17:6,50:20:6').split(',').map((v) => { const [m, k, s] = v.split(':').map(Number); return { m, k, s }; });
const rows = [];
let checked = 0, mismatches = 0;
for (const v of variants) {
  const P = { ...DEFAULT_PARAMS, score: { ...DEFAULT_PARAMS.score, ten_eight_margin: v.m, ten_eight_kd_margin: v.k } };
  const T = { 3: {}, 5: {} };
  for (const k of [3, 5]) Object.assign(T[k], { dec: 0, fights: 0, jr: 0, j108: 0, cards: 0, evenCards: 0, U: 0, S: 0, M: 0, D: 0, single_draw: 0 });
  for (const c of sample) {
    const input = boutInput(c);
    const [id1] = canonicalOrder(input.fighter_a.fighter.id, input.fighter_b.fighter.id);
    const in1 = input.fighter_a.fighter.id === id1 ? input.fighter_a : input.fighter_b;
    const in2 = in1 === input.fighter_a ? input.fighter_b : input.fighter_a;
    const R = c.scheduled_rounds === 5 ? 5 : 3;
    const ctx = prepareContext(profileFromSnapshot(in1, P), profileFromSnapshot(in2, P), R, P);
    const tilt = tilts.get(c.bout_id);
    const g = T[R];
    const seedHex = c.bout_id.replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const z = normal(mulberry(parseInt(seedHex.slice(0, 8), 16) ^ Math.round(v.s * 1000)));
    for (let i = 0; i < N; i++) {
      const f = simulateFight(ctx, fightRng(seedHex, i), tilt);
      g.fights++;
      if (f.method !== 'DEC' && f.method !== 'DRAW') continue;
      g.dec++; if (f.method === 'DRAW') g.single_draw++;
      const cards = [[0, 0], [0, 0], [0, 0]];
      for (let r = 0; r < f.rounds; r++) {
        const { margin, kd0, kd1 } = roundMargin(f.stats, r, P, tilt);
        if (v.s === 0 && checked < 20000) { const [a, b] = score(margin, kd0, kd1, P.score); checked++; if (a !== f.scores[r * 2] || b !== f.scores[r * 2 + 1]) mismatches++; }
        for (let j = 0; j < 3; j++) {
          const [a, b] = score(margin + (v.s ? v.s * z() : 0), kd0, kd1, P.score);
          cards[j][0] += a; cards[j][1] += b; g.jr++; if (a === 8 || b === 8) g.j108++;
        }
      }
      let w1 = 0, w2 = 0, ev = 0;
      for (const [a, b] of cards) { g.cards++; if (a > b) w1++; else if (b > a) w2++; else { ev++; g.evenCards++; } }
      if (w1 >= 2 || w2 >= 2) { if (w1 === 3 || w2 === 3) g.U++; else if (ev === 1) g.M++; else g.S++; } else g.D++;
    }
  }
  for (const R of [3, 5]) { const g = T[R]; rows.push({ m: v.m, k: v.k, sigma: v.s, R, r108: +(g.j108 / g.jr * 100).toFixed(2), even_cards: +(g.evenCards / g.cards * 100).toFixed(2), unan: +(g.U / g.dec * 100).toFixed(1), split: +(g.S / g.dec * 100).toFixed(1), maj: +(g.M / g.dec * 100).toFixed(1), draw_dec: +(g.D / g.dec * 100).toFixed(2), draw_all: +(g.D / g.fights * 100).toFixed(2), single_card_draw_dec: +(g.single_draw / g.dec * 100).toFixed(2) }); }
  process.stderr.write(`${v.m}:${v.k}:${v.s} done\n`);
}
console.log(`single-judge re-score check: ${checked} rounds, ${mismatches} mismatches with the engine's own scores`);
console.table(rows);
