// Walk-forward fitting of the component models. Fold Y trains on cohort
// bouts with year < Y and is evaluated on year Y (evaluate.mjs). The 'all'
// fold trains on every cohort bout and is the proposed frozen v1 set.
// Objective: penalised maximum likelihood per component (Newton/IRLS, ridge
// 1e-2 on non-intercept terms), NB dispersion by moments, gamma shape by
// Pearson moments, finish-time shape by closed-form MLE. Deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { buildCohort, roundObservations, boutTruth, CACHE } from './dataset.mjs';
import { fitGlm, nbDispersion } from './glm.mjs';
import { COMPONENTS } from '../src/engine/models.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';
import { prepareContext } from '../src/engine/fight.mjs';
import { runBatch } from '../src/engine/anchor.mjs';
import { masterSeed } from '../src/engine/rng.mjs';

/**
 * In-fold hazard intercept recalibration. The hazard GLMs are fitted on observed rounds, where the ending round's
 * within-round covariates (knockdowns, head strikes, control) are partial-round counts, while the simulator evaluates
 * the same hazards on full-round generated counts. That mismatch inflates simulated finish rates. This step simulates
 * the fold's OWN training bouts (never the evaluation year) at tilt 0 and shifts the KO and SUB intercepts by
 * log(observed / simulated) until the training-set method shares match. Deterministic (fixed seeds, fixed iterations).
 */
function calibrateHazards(params, trainBouts, profiles, { nSims = 200, iterations = 4 } = {}) {
  const P = JSON.parse(JSON.stringify(params));
  const obs = { ko: 0, sub: 0 };
  for (const c of trainBouts) { if (c.method === 'KO_TKO') obs.ko++; else if (c.method === 'SUB') obs.sub++; }
  const n = trainBouts.length || 1;
  const trace = [];
  for (let it = 0; it < iterations; it++) {
    let ko = 0, sub = 0;
    for (const c of trainBouts) {
      const [p1, p2] = profiles.get(c.bout_id);
      const ctx = prepareContext(p1, p2, c.scheduled_rounds, P);
      const b = runBatch(ctx, masterSeed(`hazard-calibration|${c.bout_id}`), nSims, 0);
      for (let i = 0; i < b.filled; i++) { if (b.method[i] === 0) ko++; else if (b.method[i] === 1) sub++; }
    }
    const simKo = ko / (n * nSims), simSub = sub / (n * nSims);
    const dKo = Math.log(Math.max(1e-4, obs.ko / n) / Math.max(1e-4, simKo)), dSub = Math.log(Math.max(1e-4, obs.sub / n) / Math.max(1e-4, simSub));
    trace.push({ iteration: it, simulated: { ko: Math.round(simKo * 1e4) / 1e4, sub: Math.round(simSub * 1e4) / 1e4 }, observed: { ko: Math.round((obs.ko / n) * 1e4) / 1e4, sub: Math.round((obs.sub / n) * 1e4) / 1e4 }, delta: { ko: Math.round(dKo * 1e4) / 1e4, sub: Math.round(dSub * 1e4) / 1e4 } });
    P.models.ko_haz.beta[0] = Math.round((P.models.ko_haz.beta[0] + dKo) * 1e6) / 1e6;
    P.models.sub_haz.beta[0] = Math.round((P.models.sub_haz.beta[0] + dSub) * 1e6) / 1e6;
  }
  P.provenance.hazard_calibration = { method: 'intercept shift by log(observed/simulated) on training bouts, tilt 0', bouts: trainBouts.length, n_sims: nSims, iterations, trace, final_intercepts: { ko_haz: P.models.ko_haz.beta[0], sub_haz: P.models.sub_haz.beta[0] } };
  return P;
}

const RIDGE = 1e-2;
const FOLDS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 'all'];
let codeSha = 'unknown';
try { codeSha = execSync('git rev-parse --short HEAD', { cwd: path.resolve(CACHE, '..', '..'), encoding: 'utf8' }).trim(); } catch {}

const { cohort } = buildCohort();
console.log('cohort', cohort.length);
const t0 = Date.now();
const OBS = new Map();
const TRUTH = new Map();
const PROF = new Map();
for (const c of cohort) { const { obs, truth, profiles } = roundObservations(c); OBS.set(c.bout_id, obs); TRUTH.set(c.bout_id, truth); PROF.set(c.bout_id, profiles); }
console.log('observations built', [...OBS.values()].reduce((a, o) => a + o.length, 0), 'in', Math.round((Date.now() - t0) / 1000), 's');

function fitFold(trainBouts, label) {
  const obs = trainBouts.flatMap((c) => OBS.get(c.bout_id));
  const models = {};
  const prov = {};
  for (const [name, comp] of Object.entries(COMPONENTS)) {
    let rows = obs;
    if (name === 'ctrl_len') rows = obs.filter((o) => o.y.ctrl_len > 0);
    if (name === 'acc') rows = obs.filter((o) => o.y.acc[1] > 0);
    if (name === 'td_acc') rows = obs.filter((o) => o.y.td_acc[1] > 0);
    const X = rows.map((o) => o.x[name]);
    const offset = comp.offset ? rows.map((o) => comp.offset(o.L)) : null;
    let y, n = null, family = comp.family;
    if (family === 'negbin') { family = 'poisson'; y = rows.map((o) => o.y[name]); }
    else if (family === 'binomial') { y = rows.map((o) => (Array.isArray(o.y[name]) ? o.y[name][0] : o.y[name])); n = rows.map((o) => (Array.isArray(o.y[name]) ? o.y[name][1] : 1)); }
    else y = rows.map((o) => o.y[name]);
    const fit = fitGlm({ X, y, n, offset, family, ridge: RIDGE, iterations: 40 });
    const m = { beta: fit.beta, provenance: `${label}` };
    if (comp.family === 'negbin') m.k = nbDispersion(X, y, fit.beta, offset);
    if (comp.family === 'gamma') m.shape = fit.shape;
    models[name] = m;
    prov[name] = { n_rows: rows.length, events: family === 'cloglog' ? y.reduce((a, b) => a + b, 0) : undefined, deviance: Math.round(fit.deviance * 100) / 100, features: comp.names };
  }
  // Finish-time shape: t = L * u^s  =>  s = -mean(log(t/L)) over finishes (separately when the winner scored a knockdown in the ending round).
  const logs = { kd: [], other: [] };
  for (const c of trainBouts) {
    if (c.method === 'DEC') continue;
    const tr = TRUTH.get(c.bout_id); const rd = tr.rounds[tr.rounds.length - 1];
    const winnerKd = (tr.winner === 1 ? rd.fighter_1.kd : rd.fighter_2.kd) > 0;
    const v = Math.max(1, Math.min(299, c.end_time)) / 300;
    (c.method === 'KO_TKO' && winnerKd ? logs.kd : logs.other).push(Math.log(v));
  }
  const shape = (arr) => (arr.length ? Math.round(-arr.reduce((a, b) => a + b, 0) / arr.length * 1e4) / 1e4 : DEFAULT_PARAMS.finish_time_shape);
  const params = { ...DEFAULT_PARAMS, models, finish_time_shape: shape(logs.other), finish_time_shape_kd: shape(logs.kd) };
  params.provenance = {
    fold: label, code: 'workers/ufc-simulator/phase3/fit.mjs', code_sha: codeSha, objective: `penalised maximum likelihood per component (Newton/IRLS, ridge ${RIDGE} on non-intercept terms); NB k and gamma shape by moments; finish-time shape by MLE`,
    training_window: trainBouts.length ? { start: trainBouts[0].event_date, end: trainBouts[trainBouts.length - 1].event_date } : null,
    training_bouts: trainBouts.length, training_observations: obs.length, finish_time_samples: { kd: logs.kd.length, other: logs.other.length }, components: prov,
  };
  return params;
}

const out = {};
for (const f of FOLDS) {
  const train = f === 'all' ? cohort : cohort.filter((c) => c.year < f);
  const fitted = fitFold(train, f === 'all' ? 'all-2015-2026' : `fold-${f}-train-lt-${f}`);
  const p = calibrateHazards(fitted, train, PROF);
  out[f] = p;
  fs.writeFileSync(path.join(CACHE, `params_fold_${f}.json`), JSON.stringify(p, null, 1));
  const m = p.models;
  console.log(`fold ${f}: bouts ${train.length} obs ${p.provenance.training_observations} | att k ${m.att.k} b=${m.att.beta.slice(0, 3)} | ko_haz ${m.ko_haz.beta.map((v) => v.toFixed(2))} events ${p.provenance.components.ko_haz.events} | sub_haz ${m.sub_haz.beta.map((v) => v.toFixed(2))} events ${p.provenance.components.sub_haz.events} | ft shape ${p.finish_time_shape}/${p.finish_time_shape_kd} | hazard calib ${JSON.stringify(p.provenance.hazard_calibration.trace.map((t) => [t.simulated.ko, t.simulated.sub]))} obs ${JSON.stringify(p.provenance.hazard_calibration.trace[0].observed)}`);
}
console.log('done', Math.round((Date.now() - t0) / 1000), 's');
