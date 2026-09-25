// Walk-forward evaluation: simulate every cohort bout of year Y with the
// parameters fitted on years < Y, anchored on the champion's fold prediction,
// and record everything the report needs. Resumable JSONL output.
//
//   node --max-old-space-size=8192 phase3/evaluate.mjs [--n 2000] [--from 2016] [--to 2026] [--limit N] [--params prior]
import fs from 'node:fs';
import path from 'node:path';
import { buildCohort, boutInput, boutTruth, CACHE } from './dataset.mjs';
import { simulate } from '../src/engine/simulate.mjs';
import { profileFromSnapshot } from '../src/engine/inputs.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';
import { assertWalkForwardParams } from './guard.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--n', 2000));
const FROM = Number(opt('--from', 2016)), TO = Number(opt('--to', 2026));
const LIMIT = Number(opt('--limit', 0));
const PARAM_MODE = opt('--params', 'fold'); // fold | prior
/* Phase 3B: optional fight-level persistence (src/engine/fight.mjs). --rho 0 (default) is the frozen v1.0-rc1 engine. */
const RHO = Number(opt('--rho', 0));
const OUT = path.join(CACHE, `eval_${PARAM_MODE}${RHO ? `_rho${RHO}` : ''}_n${N}.jsonl`);

const { cohort } = buildCohort();
const done = new Set();
if (fs.existsSync(OUT)) for (const line of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) { if (line.trim()) done.add(JSON.parse(line).bout_id); }
const paramsFor = new Map();
function params(year, eventDate) {
  if (PARAM_MODE === 'prior') return DEFAULT_PARAMS;
  if (!paramsFor.has(year)) paramsFor.set(year, JSON.parse(fs.readFileSync(path.join(CACHE, `params_fold_${year}.json`), 'utf8')));
  const P = paramsFor.get(year);
  assertWalkForwardParams(P, year, eventDate); // refuses params_fold_all and any fold/window mismatch
  return RHO ? { ...P, persistence: { rho: RHO } } : P;
}

const todo = cohort.filter((c) => c.year >= FROM && c.year <= TO && !done.has(c.bout_id));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`evaluating ${list.length} bouts (done ${done.size}) n_sims ${N} params ${PARAM_MODE} -> ${OUT}`);
const t0 = Date.now();
const fh = fs.openSync(OUT, 'a');
let i = 0;
for (const c of list) {
  const P = params(c.year, c.event_date);
  const input = boutInput(c);
  const truth = boutTruth(c);
  const t = Date.now();
  const { artifact: a } = simulate({ ...input, n_sims: N }, { params: P, simulator_version: `pbe-fight-simulator-v1.0-phase3-${PARAM_MODE}${RHO ? `-rho${RHO}` : ''}` });
  // Naive baselines from the as-of profiles (fighter's own DNA rate x minutes; opponent-adjusted = geometric mean with the opponent's absorbed rate).
  const in1 = input.fighter_a.fighter.id === truth.fighter_1_id ? input.fighter_a : input.fighter_b;
  const in2 = in1 === input.fighter_a ? input.fighter_b : input.fighter_a;
  const p1 = profileFromSnapshot(in1, P), p2 = profileFromSnapshot(in2, P);
  const naive = (p, o) => ({
    att_rate: p.att_rate.slice(0, c.scheduled_rounds), acc: p.accuracy, sig_landed_per_min: p.evidence.used.sig_landed_per_min?.used ?? null, absorbed_per_min: p.evidence.used.sig_absorbed_per_min?.used ?? null,
    opp_absorbed_per_min: o.evidence.used.sig_absorbed_per_min?.used ?? null, td15: p.td15, tdacc: p.tdacc, opp_tddef: o.tddef, ctrl_share: p.ctrl_share, kd15: p.kd15, sub15: p.sub15,
    coverage: p.coverage_status, stat_bouts: p.sample.stat_bouts, sample_bouts: p.sample.bouts, fallbacks: p.evidence.fallbacks.length,
  });
  const row = {
    bout_id: c.bout_id, year: c.year, event_date: c.event_date, series: c.event_series, weight_class: c.weight_class, is_womens: c.is_womens, is_title: c.is_title, scheduled_rounds: c.scheduled_rounds,
    status: a.status, gate: a.coverage?.gate ?? null, gate_reasons: (a.coverage?.reasons || []).map((r) => r.code), coverage: [a.coverage?.fighter_1?.coverage_status, a.coverage?.fighter_2?.coverage_status],
    anchor: a.anchor ? { pre: a.anchor.pre_anchor_probability, champ: a.anchor.champion_probability, post: a.anchor.post_anchor_probability, tilt: a.anchor.tilt_applied, status: a.anchor.status, max_tilt_hit: Math.abs(a.anchor.tilt_applied) >= a.anchor.max_tilt - 1e-9 } : null,
    probabilities: a.probabilities, methods: a.methods, finish_distribution: a.finish_distribution, finish_time: a.finish_time,
    per_round: a.distribution?.per_round?.map((r) => ({ round: r.round, n: r.fights_reaching, f1: Object.fromEntries(Object.entries(r.f1).map(([k, v]) => [k, v.median])), f2: Object.fromEntries(Object.entries(r.f2).map(([k, v]) => [k, v.median])), round_win: r.round_win })) ?? null,
    fight_totals: a.distribution?.fight_totals ? { f1: Object.fromEntries(Object.entries(a.distribution.fight_totals.fighter_1).map(([k, v]) => [k, v.median])), f2: Object.fromEntries(Object.entries(a.distribution.fight_totals.fighter_2).map(([k, v]) => [k, v.median])) } : null,
    projection: a.canonical_projection ? { winner: a.canonical_projection.winner, method: a.canonical_projection.method, round: a.canonical_projection.round, cell_share: a.canonical_projection.selection.cell_share, method_conditional: a.canonical_projection.selection.method_conditional, precision: a.canonical_projection.precision } : null,
    truth: { winner: truth.winner, method: truth.method, end_round: truth.end_round, end_time: truth.end_time, sweep_winner: truth.sweep_winner, rounds: truth.rounds },
    naive: { f1: naive(p1, p2), f2: naive(p2, p1) },
    simulation_id: a.simulation_id, ms: Date.now() - t,
  };
  fs.writeSync(fh, JSON.stringify(row) + '\n');
  i++;
  if (i % 100 === 0) console.log(`${i}/${list.length} ${Math.round((Date.now() - t0) / 1000)}s avg ${Math.round((Date.now() - t0) / i)} ms/bout`);
}
fs.closeSync(fh);
console.log('done', i, 'bouts in', Math.round((Date.now() - t0) / 1000), 's');
