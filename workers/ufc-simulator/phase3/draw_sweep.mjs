// Draw calibration trace (Phase 3B): simulated per-round 10-8 rate and even-card (draw) rate among decisions,
// on cohort bouts, under the current round-score rule and under candidate 10-8 thresholds.
//
//   node --max-old-space-size=8192 phase3/draw_sweep.mjs [--sample 600] [--n 400] [--from 2019]
//
// Historical reference (ufc_bout_scorecards, 2015+, decisions): implied 10-8 per judge-round <= 4.96% (3 rd) /
// 7.49% (5 rd) (upper bound: deductions count as lost points); even judge cards 1.47% / 1.70%; official draws
// 1.59% / 1.70% of decision bouts.
import fs from 'node:fs';
import path from 'node:path';
import { buildCohort, boutInput, CACHE } from './dataset.mjs';
import { profileFromSnapshot } from '../src/engine/inputs.mjs';
import { prepareContext, simulateFight } from '../src/engine/fight.mjs';
import { fightRng } from '../src/engine/rng.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';
import { canonicalOrder } from '../src/engine/fingerprint.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SAMPLE = Number(opt('--sample', 600)), N = Number(opt('--n', 400)), FROM = Number(opt('--from', 2019)), TO = Number(opt('--to', 2026));
const tilts = new Map(fs.readFileSync(path.join(CACHE, 'eval_fold_n2000.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.anchor && Number.isFinite(r.anchor.tilt)).map((r) => [r.bout_id, r.anchor.tilt]));
const { cohort } = buildCohort();
// Deterministic sample: every k-th eligible bout, both formats represented.
const elig = cohort.filter((c) => c.year >= FROM && c.year <= TO && tilts.has(c.bout_id));
const five = elig.filter((c) => c.scheduled_rounds === 5), three = elig.filter((c) => c.scheduled_rounds !== 5);
const pick = (xs, n) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
const sample = [...pick(three, Math.round(SAMPLE * 0.75)), ...pick(five, Math.round(SAMPLE * 0.25))];

const variants = (opt('--variants', '40:14,50:20,60:25,70:30,80:35')).split(',').map((v) => { const [m, k, rho = 0] = v.split(':').map(Number); return { m, k, rho }; });
const rows = [];
for (const v of variants) {
  const P = { ...DEFAULT_PARAMS, score: { ...DEFAULT_PARAMS.score, ten_eight_margin: v.m, ten_eight_kd_margin: v.k }, ...(v.rho ? { persistence: { rho: v.rho } } : {}) };
  const t = { 3: { fights: 0, dec: 0, draw: 0, rounds: 0, r108: 0 }, 5: { fights: 0, dec: 0, draw: 0, rounds: 0, r108: 0 } };
  const shapes = { 3: {}, 5: {} };
  for (const c of sample) {
    const input = boutInput(c);
    const [id1] = canonicalOrder(input.fighter_a.fighter.id, input.fighter_b.fighter.id);
    const in1 = input.fighter_a.fighter.id === id1 ? input.fighter_a : input.fighter_b;
    const in2 = in1 === input.fighter_a ? input.fighter_b : input.fighter_a;
    const R = c.scheduled_rounds === 5 ? 5 : 3;
    const ctx = prepareContext(profileFromSnapshot(in1, P), profileFromSnapshot(in2, P), R, P);
    const tilt = tilts.get(c.bout_id);
    const g = t[R];
    for (let i = 0; i < N; i++) {
      const f = simulateFight(ctx, fightRng(c.bout_id.replace(/-/g, '').padEnd(64, '0').slice(0, 64), i), tilt);
      g.fights++;
      if (f.method !== 'DEC' && f.method !== 'DRAW') continue;
      g.dec++; if (f.method === 'DRAW') g.draw++;
      let a1 = 0, a2 = 0;
      for (let r = 0; r < f.rounds; r++) { g.rounds++; a1 += f.scores[r * 2]; a2 += f.scores[r * 2 + 1]; if (f.scores[r * 2] === 8 || f.scores[r * 2 + 1] === 8) g.r108++; }
      const key = `${Math.max(a1, a2)}-${Math.min(a1, a2)}`; shapes[R][key] = (shapes[R][key] || 0) + 1;
    }
  }
  for (const R of [3, 5]) { const g = t[R]; rows.push({ ten_eight_margin: v.m, kd_margin: v.k, rho: v.rho, R, bouts: sample.filter((c) => (c.scheduled_rounds === 5 ? 5 : 3) === R).length, r108_pct: +(g.r108 / g.rounds * 100).toFixed(2), draw_of_dec_pct: +(g.draw / g.dec * 100).toFixed(2), draw_of_all_pct: +(g.draw / g.fights * 100).toFixed(2), dec_pct: +(g.dec / g.fights * 100).toFixed(1) }); }
  for (const R of [3, 5]) { const tot = Object.values(shapes[R]).reduce((a, b) => a + b, 0); console.log(`${v.m}:${v.k}:${v.rho} ${R}rd cards`, Object.entries(shapes[R]).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, n]) => `${k} ${(n / tot * 100).toFixed(1)}%`).join(' | ')); }
  process.stderr.write(`${v.m}:${v.k} done\n`);
}
console.table(rows);
