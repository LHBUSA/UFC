// Phase 3 report: metrics, baselines, slices, tilt distribution, coverage
// analysis. Reads eval_<mode>_n<N>.jsonl and the cohort; writes JSON evidence
// and a Markdown report.
//
//   node --max-old-space-size=8192 phase3/report.mjs --n 2000 [--params fold] [--prior-n 2000]
import fs from 'node:fs';
import path from 'node:path';
import { buildCohort, CACHE } from './dataset.mjs';
import { brier, logloss, mean, mae, rmse, r4, r2, quantiles, calibration, multiLogLoss, crpsDiscrete, summarizeBinary, groupBy } from './metrics.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--n', 2000)); const MODE = opt('--params', 'fold'); const PRIOR_N = Number(opt('--prior-n', 0)); const UNCAL_N = Number(opt('--uncal-n', 0));
const readRows = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const rows = readRows(path.join(CACHE, `eval_${MODE}_n${N}.jsonl`));
const priorRows = PRIOR_N ? readRows(path.join(CACHE, `eval_prior_n${PRIOR_N}.jsonl`)) : [];
const uncalRows = UNCAL_N ? readRows(path.join(CACHE, `eval_fold_uncalibrated_n${UNCAL_N}.jsonl`)) : [];
const { cohort, excluded } = buildCohort();
const cohortById = new Map(cohort.map((c) => [c.bout_id, c]));
console.log('eval rows', rows.length, 'prior rows', priorRows.length);

const sim = rows.filter((r) => r.probabilities); // simulated (FULL/LIMITED)
const insufficient = rows.filter((r) => !r.probabilities);

// ---------- Baselines from TRAINING years only (year < fold year) ----------
function trainBouts(year) { return cohort.filter((c) => c.year < year); }
const baselineCache = new Map();
function baselines(year) {
  if (baselineCache.has(year)) return baselineCache.get(year);
  const tb = trainBouts(year);
  const freq = (arr, key) => { const m = {}; for (const c of arr) m[key(c)] = (m[key(c)] || 0) + 1; const n = arr.length || 1; for (const k of Object.keys(m)) m[k] /= n; return m; };
  const global = freq(tb, (c) => c.method);
  const byWc = new Map(); for (const [wc, arr] of groupBy(tb, (c) => `${c.weight_class}|${c.scheduled_rounds}`)) byWc.set(wc, { n: arr.length, f: freq(arr, (c) => c.method) });
  const finishRound = {}; // by (rounds, method) -> pmf over rounds
  for (const [k, arr] of groupBy(tb.filter((c) => c.method !== 'DEC'), (c) => `${c.scheduled_rounds}|${c.method}`)) { const R = Number(k.split('|')[0]); const pmf = new Array(R).fill(0); for (const c of arr) pmf[c.end_round - 1]++; finishRound[k] = pmf.map((v) => v / arr.length); }
  const finishRoundAny = {}; for (const [k, arr] of groupBy(tb.filter((c) => c.method !== 'DEC'), (c) => String(c.scheduled_rounds))) { const R = Number(k); const pmf = new Array(R).fill(0); for (const c of arr) pmf[c.end_round - 1]++; finishRoundAny[k] = pmf.map((v) => v / arr.length); }
  const b = { n: tb.length, global, byWc, finishRound, finishRoundAny, distance: tb.length ? tb.filter((c) => c.method === 'DEC').length / tb.length : 0.5 };
  baselineCache.set(year, b);
  return b;
}
const methodProbs = (r) => { const m = r.methods; const w = r.truth.winner; const p = { KO_TKO: m.fighter_1_ko + m.fighter_2_ko, SUB: m.fighter_1_sub + m.fighter_2_sub, DEC: m.fighter_1_dec + m.fighter_2_dec + (r.probabilities.draw || 0) }; const s = p.KO_TKO + p.SUB + p.DEC; for (const k of Object.keys(p)) p[k] /= s || 1; return p; };
const wcBaseline = (r) => { const b = baselines(r.year); const k = `${r.weight_class}|${r.scheduled_rounds}`; const e = b.byWc.get(k); return e && e.n >= 30 ? e.f : b.global; };
const norm3 = (f) => ({ KO_TKO: f.KO_TKO || 0, SUB: f.SUB || 0, DEC: f.DEC || 0 });

// ---------- Winner ----------
const winnerRows = sim.map((r) => [r.probabilities.fighter_1_win / (1 - (r.probabilities.draw || 0)), r.truth.winner === 1 ? 1 : 0]);
const champRows = sim.map((r) => [r.anchor.champ, r.truth.winner === 1 ? 1 : 0]);
const preRows = sim.map((r) => [r.anchor.pre, r.truth.winner === 1 ? 1 : 0]);
const winner = { simulator_post_anchor: summarizeBinary(winnerRows), champion_fold_prediction: summarizeBinary(champRows), engine_pre_anchor_no_tilt: summarizeBinary(preRows), coin: { brier: 0.25, logloss: r4(Math.log(2)) } };

// ---------- Tilt ----------
function tiltStats(rs) { const a = rs.map((r) => Math.abs(r.anchor.tilt)); return { n: rs.length, median: quantiles(a).p50, ...quantiles(a, [0.75, 0.9, 0.95, 1]), pct_max_tilt_hit: rs.length ? r4(rs.filter((r) => r.anchor.max_tilt_hit || r.anchor.status !== 'ok').length / rs.length) : null, pct_status_not_ok: rs.length ? r4(rs.filter((r) => r.anchor.status !== 'ok').length / rs.length) : null, mean_abs_pre_minus_champ: r4(mean(rs.map((r) => Math.abs(r.anchor.pre - r.anchor.champ)))), mean_abs_post_minus_champ: r4(mean(rs.map((r) => Math.abs(r.anchor.post - r.anchor.champ)))) }; }
const tilt = { all: tiltStats(sim), by_gate: Object.fromEntries([...groupBy(sim, (r) => r.gate)].map(([k, v]) => [k, tiltStats(v)])), by_min_coverage: Object.fromEntries([...groupBy(sim, (r) => ['insufficient', 'low', 'medium', 'high'].find((t) => r.coverage.includes(t)))].map(([k, v]) => [k, tiltStats(v)])), by_year: Object.fromEntries([...groupBy(sim, (r) => r.year)].map(([k, v]) => [k, tiltStats(v)])), by_weight_class: Object.fromEntries([...groupBy(sim, (r) => r.weight_class)].map(([k, v]) => [k, tiltStats(v)])), by_min_stat_bouts: Object.fromEntries([...groupBy(sim, (r) => { const m = Math.min(r.naive.f1.stat_bouts, r.naive.f2.stat_bouts); return m >= 10 ? '10+' : m >= 5 ? '5-9' : m >= 3 ? '3-4' : m >= 1 ? '1-2' : '0'; })].map(([k, v]) => [k, tiltStats(v)])) };

// ---------- Method / distance ----------
function methodBlock(rs) {
  const simLL = mean(rs.map((r) => multiLogLoss(methodProbs(r), r.truth.method)));
  const globalLL = mean(rs.map((r) => multiLogLoss(norm3(baselines(r.year).global), r.truth.method)));
  const wcLL = mean(rs.map((r) => multiLogLoss(norm3(wcBaseline(r)), r.truth.method)));
  const acc = mean(rs.map((r) => { const p = methodProbs(r); const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]; return best === r.truth.method ? 1 : 0; }));
  const wcAcc = mean(rs.map((r) => { const p = norm3(wcBaseline(r)); const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]; return best === r.truth.method ? 1 : 0; }));
  const perClass = {};
  for (const k of ['KO_TKO', 'SUB', 'DEC']) { const pr = rs.map((r) => [methodProbs(r)[k], r.truth.method === k ? 1 : 0]); perClass[k] = { n_true: pr.filter((x) => x[1]).length, sim: summarizeBinary(pr), sim_mean_p: r4(mean(pr.map((x) => x[0]))), wc_baseline_brier: r4(mean(rs.map((r) => brier(norm3(wcBaseline(r))[k], r.truth.method === k ? 1 : 0)))) }; }
  const pr = {};
  for (const k of ['KO_TKO', 'SUB', 'DEC']) { let tp = 0, fp = 0, fn = 0; for (const r of rs) { const best = Object.entries(methodProbs(r)).sort((a, b) => b[1] - a[1])[0][0]; if (best === k && r.truth.method === k) tp++; else if (best === k) fp++; else if (r.truth.method === k) fn++; } pr[k] = { precision: r4(tp / ((tp + fp) || 1)), recall: r4(tp / ((tp + fn) || 1)), predicted: tp + fp, actual: tp + fn }; }
  const dist = rs.map((r) => [r.probabilities.goes_distance, r.truth.method === 'DEC' ? 1 : 0]);
  const distWc = rs.map((r) => [norm3(wcBaseline(r)).DEC, r.truth.method === 'DEC' ? 1 : 0]);
  return { n: rs.length, method_logloss: { simulator: r4(simLL), global_frequency: r4(globalLL), weight_class_frequency: r4(wcLL) }, method_top1_accuracy: { simulator: r4(acc), weight_class_frequency: r4(wcAcc) }, precision_recall_top1: pr, per_class: perClass, goes_distance: { simulator: summarizeBinary(dist), weight_class_frequency: summarizeBinary(distWc) } };
}
const method = { all: methodBlock(sim), by_gate: Object.fromEntries([...groupBy(sim, (r) => r.gate)].map(([k, v]) => [k, methodBlock(v)])) };

// ---------- Finish round / time ----------
function finishBlock(rs) {
  const fin = rs.filter((r) => r.truth.method !== 'DEC');
  const simCrps = [], baseCrps = [], baseAnyCrps = [], simMae = [], baseMae = [], simCondMae = [];
  const winBucket = [];
  for (const r of fin) {
    const R = r.scheduled_rounds;
    const pmfAny = r.finish_distribution.map((f) => f.any); const sAny = pmfAny.reduce((a, b) => a + b, 0) || 1; const pmf = pmfAny.map((v) => v / sAny); // conditional on a finish
    const tIdx = r.truth.end_round - 1;
    simCrps.push(crpsDiscrete(pmf, tIdx));
    const b = baselines(r.year); const bp = b.finishRound[`${R}|${r.truth.method}`] || b.finishRoundAny[String(R)] || new Array(R).fill(1 / R);
    baseCrps.push(crpsDiscrete(bp, tIdx));
    baseAnyCrps.push(crpsDiscrete(b.finishRoundAny[String(R)] || new Array(R).fill(1 / R), tIdx));
    const expRound = pmf.reduce((a, v, i) => a + v * (i + 1), 0); simMae.push([expRound, r.truth.end_round]);
    const bexp = bp.reduce((a, v, i) => a + v * (i + 1), 0); baseMae.push([bexp, r.truth.end_round]);
    if (r.projection && r.projection.round) simCondMae.push([r.projection.round, r.truth.end_round]);
    if (r.finish_time) winBucket.push([r.finish_time.median_elapsed_sec, (r.truth.end_round - 1) * 300 + r.truth.end_time]);
  }
  const bucketOf = (s) => Math.min(2, Math.floor((s % 300) / 100));
  const bucketHit = fin.filter((r) => r.projection?.round === r.truth.end_round && r.projection.method === r.truth.method).length;
  return { n_finishes: fin.length, round_crps_conditional_on_finish: { simulator: r4(mean(simCrps)), historical_conditional_on_method: r4(mean(baseCrps)), historical_any_method: r4(mean(baseAnyCrps)) }, expected_round_mae: { simulator: r4(mae(simMae)), historical_conditional_on_method: r4(mae(baseMae)) }, projection_round_mae_when_projected_finish: { n: simCondMae.length, mae: r4(mae(simCondMae)) }, projection_exact_method_and_round_hit_rate: r4(bucketHit / (fin.length || 1)), elapsed_time_median_mae_sec: { n: winBucket.length, mae: r2(mae(winBucket)) } };
}
const finishByMethod = { KO_TKO: finishBlock(sim.filter((r) => r.truth.method !== 'SUB')), SUB: finishBlock(sim.filter((r) => r.truth.method !== 'KO_TKO')) };
const finish = { all: finishBlock(sim), by_truth_method: finishByMethod, by_gate: Object.fromEntries([...groupBy(sim, (r) => r.gate)].map(([k, v]) => [k, finishBlock(v)])) };

// ---------- Round stats ----------
const STATS = ['sig_l', 'sig_a', 'td_a', 'td_l', 'ctrl', 'kd', 'sub'];
function statBlock(rs) {
  const out = {};
  for (const s of STATS) {
    const simP = [], naiveP = [], oppAdjP = [];
    for (const r of rs) {
      for (const rd of r.truth.rounds) {
        if (rd.ending) continue; // full rounds only, both for truth and prediction
        const pr = r.per_round?.[rd.round - 1]; if (!pr) continue;
        for (const [side, key] of [[1, 'f1'], [2, 'f2']]) {
          const truth = side === 1 ? rd.fighter_1[s] : rd.fighter_2[s];
          const nv = r.naive[key], ov = r.naive[key === 'f1' ? 'f2' : 'f1'];
          let naive, oppAdj;
          const minutes = 5;
          if (s === 'sig_a') { naive = (nv.att_rate[rd.round - 1] ?? nv.att_rate[nv.att_rate.length - 1]) * minutes; oppAdj = naive; }
          else if (s === 'sig_l') { const own = nv.sig_landed_per_min ?? nv.acc * (nv.att_rate[0]); const oppAbs = ov.absorbed_per_min ?? own; naive = own * minutes; oppAdj = Math.sqrt(Math.max(0.01, own) * Math.max(0.01, oppAbs)) * minutes; }
          else if (s === 'td_l') { naive = nv.td15 * nv.tdacc * (minutes / 15); oppAdj = nv.td15 * (nv.tdacc * (1 - ov.opp_tddef) / 0.375) * (minutes / 15); }
          else if (s === 'ctrl') { naive = nv.ctrl_share * 300; oppAdj = naive; }
          else if (s === 'kd') { naive = nv.kd15 * (minutes / 15); oppAdj = naive; }
          else if (s === 'td_a') { naive = nv.td15 * (minutes / 15); oppAdj = naive; }
          else if (s === 'sub') { naive = nv.sub15 * (minutes / 15); oppAdj = naive; }
          if (pr[key][s] == null) continue;
          simP.push([pr[key][s], truth]); naiveP.push([naive, truth]); oppAdjP.push([oppAdj, truth]);
        }
      }
    }
    out[s] = { n_fighter_rounds: simP.length, simulator_median: { mae: r2(mae(simP)), rmse: r2(rmse(simP)), bias: r2(mean(simP.map(([p, y]) => p - y))) }, naive_dna_average: { mae: r2(mae(naiveP)), rmse: r2(rmse(naiveP)), bias: r2(mean(naiveP.map(([p, y]) => p - y))) }, opponent_adjusted_average: { mae: r2(mae(oppAdjP)), rmse: r2(rmse(oppAdjP)) }, truth_mean: r2(mean(simP.map(([, y]) => y))) };
  }
  // Pace retention: ratio of round-3 to round-1 significant attempts, simulated vs observed (fights reaching a full round 3).
  const pr = [];
  for (const r of rs) { if (r.truth.rounds.length < 3 || r.truth.rounds[2].ending) continue; const p = r.per_round; if (!p || !p[2]) continue; for (const [key, side] of [['f1', 'fighter_1'], ['f2', 'fighter_2']]) { const t1 = r.truth.rounds[0][side].sig_a, t3 = r.truth.rounds[2][side].sig_a; const s1 = p[0][key].sig_a, s3 = p[2][key].sig_a; if (t1 >= 5 && s1 >= 1) pr.push([s3 / s1, t3 / t1]); } }
  out.pace_retention_r3_vs_r1 = { n: pr.length, simulator_mae: r4(mae(pr)), simulator_mean: r4(mean(pr.map(([p]) => p))), observed_mean: r4(mean(pr.map(([, y]) => y))) };
  // Target / position share at fight level: simulator (medoid path not stored) vs DNA share baseline is identical by construction; report observed vs DNA-share MAE.
  return out;
}
const roundStats = { all: statBlock(sim), by_gate: Object.fromEntries([...groupBy(sim, (r) => r.gate)].map(([k, v]) => [k, statBlock(v)])) };

// ---------- Round winners (clean sweeps only) ----------
const sweeps = sim.filter((r) => r.truth.sweep_winner);
let rwHit = 0, rwN = 0;
for (const r of sweeps) for (const pr of r.per_round || []) { if (!pr.round_win) continue; const pred = pr.round_win.f1 > pr.round_win.f2 ? 1 : 2; rwN++; if (pred === r.truth.sweep_winner) rwHit++; }
let favHit = 0, favN = 0;
for (const r of sweeps) { const fav = r.anchor.champ >= 0.5 ? 1 : 2; for (const pr of r.per_round || []) { if (!pr.round_win) continue; favN++; if (fav === r.truth.sweep_winner) favHit++; } }
const roundWinners = { sweep_bouts: sweeps.length, rounds_scored: rwN, accuracy: r4(rwHit / (rwN || 1)), baseline_champion_favourite_every_round: r4(favHit / (favN || 1)), note: 'clean-sweep decisions only (every card 30-27 / 50-45); auxiliary evaluation, not a training target' };

// ---------- Slices ----------
function slice(rs) { if (!rs.length) return { n: 0 }; const w = summarizeBinary(rs.map((r) => [r.probabilities.fighter_1_win / (1 - (r.probabilities.draw || 0)), r.truth.winner === 1 ? 1 : 0])); const m = methodBlock(rs); const f = finishBlock(rs); const st = statBlock(rs); return { n: rs.length, winner_brier: w.brier, champion_brier: summarizeBinary(rs.map((r) => [r.anchor.champ, r.truth.winner === 1 ? 1 : 0])).brier, method_logloss: m.method_logloss.simulator, method_logloss_wc_baseline: m.method_logloss.weight_class_frequency, distance_brier: m.goes_distance.simulator.brier, distance_brier_wc_baseline: m.goes_distance.weight_class_frequency.brier, finish_round_crps: f.round_crps_conditional_on_finish.simulator, finish_round_crps_baseline: f.round_crps_conditional_on_finish.historical_conditional_on_method, sig_l_mae: st.sig_l.simulator_median.mae, sig_l_mae_naive: st.sig_l.naive_dna_average.mae, td_l_mae: st.td_l.simulator_median.mae, td_l_mae_naive: st.td_l.naive_dna_average.mae, tilt_median: tiltStats(rs).median, tilt_p90: tiltStats(rs).p90 }; }
const byGate = Object.fromEntries([...groupBy(sim, (r) => r.gate)].map(([k, v]) => [k, slice(v)]));
const byMinCov = Object.fromEntries([...groupBy(sim, (r) => ['insufficient', 'low', 'medium', 'high'].find((t) => r.coverage.includes(t)))].map(([k, v]) => [k, slice(v)]));
const byYear = Object.fromEntries([...groupBy(sim, (r) => r.year)].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, slice(v)]));
const byWc = Object.fromEntries([...groupBy(sim, (r) => r.weight_class)].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, slice(v)]));
const byRounds = Object.fromEntries([...groupBy(sim, (r) => r.scheduled_rounds)].map(([k, v]) => [k, slice(v)]));

// ---------- Prior (Phase 2) comparison on the same bouts ----------
let priorCompare = null;
if (priorRows.length) {
  const pm = new Map(priorRows.filter((r) => r.probabilities).map((r) => [r.bout_id, r]));
  const both = sim.filter((r) => pm.has(r.bout_id));
  const p = both.map((r) => pm.get(r.bout_id));
  priorCompare = { n: both.length, fitted: { method_logloss: methodBlock(both).method_logloss.simulator, distance_brier: methodBlock(both).goes_distance.simulator.brier, finish_crps: finishBlock(both).round_crps_conditional_on_finish.simulator, sig_l_mae: statBlock(both).sig_l.simulator_median.mae, tilt_median: tiltStats(both).median, tilt_p90: tiltStats(both).p90 }, phase2_priors: { method_logloss: methodBlock(p).method_logloss.simulator, distance_brier: methodBlock(p).goes_distance.simulator.brier, finish_crps: finishBlock(p).round_crps_conditional_on_finish.simulator, sig_l_mae: statBlock(p).sig_l.simulator_median.mae, tilt_median: tiltStats(p).median, tilt_p90: tiltStats(p).p90 } };
}

// ---------- Reconciliation: every candidate bout to a disposition ----------
const candidates = cohort.length + Object.values(excluded).reduce((a, b) => a + b, 0);
const cohort2015 = cohort.filter((c) => c.year < 2016).length;
const target = cohort.filter((c) => c.year >= 2016);
const rowIds = new Set(rows.map((r) => r.bout_id));
const reconciliation = { candidate_bouts_2015_plus_complete_model_scope: candidates, excluded_before_cohort: excluded, cohort: cohort.length, cohort_2015_no_prior_training_fold: cohort2015, walk_forward_target_2016_2026: target.length, evaluated_rows: rows.length, by_disposition: Object.fromEntries([...groupBy(rows, (r) => r.status)].map(([k, v]) => [k, v.length])), rejected_snapshot: rows.filter((r) => r.status === 'REJECTED_SNAPSHOT').length, missing_anchor_rows: rows.filter((r) => !r.anchor).length, target_bouts_without_row: target.filter((c) => !rowIds.has(c.bout_id)).length, reconciles: candidates === cohort.length + Object.values(excluded).reduce((a, b) => a + b, 0) && target.length === rows.length };

// ---------- Parameter stability across walk-forward folds ----------
const stability = {};
const foldParams = [];
for (let y = 2016; y <= 2026; y++) { const f = path.join(CACHE, `params_fold_${y}.json`); if (fs.existsSync(f)) foldParams.push({ year: y, p: JSON.parse(fs.readFileSync(f, 'utf8')) }); }
const allFit = fs.existsSync(path.join(CACHE, 'params_fold_all.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params_fold_all.json'), 'utf8')) : null;
if (foldParams.length) {
  const names = Object.keys(foldParams[0].p.models);
  for (const name of names) {
    const feats = foldParams[0].p.provenance.components[name].features;
    const coefs = feats.map((f, j) => { const vals = foldParams.map((fp) => fp.p.models[name].beta[j]); const m = mean(vals); const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2))); const range = Math.max(...vals) - Math.min(...vals); const late = vals.slice(-6); const lateRange = Math.max(...late) - Math.min(...late); return { feature: f, all_fit: allFit ? allFit.models[name].beta[j] : null, mean: r4(m), sd: r4(sd), min: r4(Math.min(...vals)), max: r4(Math.max(...vals)), range_2021_2026: r4(lateRange), unstable: lateRange > Math.max(0.25, 0.5 * Math.abs(m)) }; });
    const extra = {};
    for (const k of ['k', 'shape']) if (foldParams[0].p.models[name][k] != null) { const vals = foldParams.map((fp) => fp.p.models[name][k]); extra[k] = { all_fit: allFit?.models[name][k], min: r4(Math.min(...vals)), max: r4(Math.max(...vals)), mean: r4(mean(vals)) }; }
    stability[name] = { coefficients: coefs, dispersion: extra, events_by_fold: Object.fromEntries(foldParams.map((fp) => [fp.year, fp.p.provenance.components[name].events ?? fp.p.provenance.components[name].n_rows])) };
  }
  stability.finish_time_shape = { by_fold: Object.fromEntries(foldParams.map((fp) => [fp.year, [fp.p.finish_time_shape, fp.p.finish_time_shape_kd]])), all_fit: allFit ? [allFit.finish_time_shape, allFit.finish_time_shape_kd] : null };
  stability.training_bouts_by_fold = Object.fromEntries(foldParams.map((fp) => [fp.year, fp.p.provenance.training_bouts]));
}

// ---------- Uncalibrated-hazard fit (before in-fold intercept recalibration) on the same bouts ----------
let uncalCompare = null;
if (uncalRows.length) {
  const um = new Map(uncalRows.filter((r) => r.probabilities).map((r) => [r.bout_id, r]));
  const both = sim.filter((r) => um.has(r.bout_id));
  const u = both.map((r) => um.get(r.bout_id));
  const pack = (rs) => { const m = methodBlock(rs); return { method_logloss: m.method_logloss.simulator, ko_mean_p: m.per_class.KO_TKO.sim_mean_p, ko_observed: m.per_class.KO_TKO.sim.base_rate, sub_mean_p: m.per_class.SUB.sim_mean_p, sub_observed: m.per_class.SUB.sim.base_rate, dec_mean_p: m.per_class.DEC.sim_mean_p, distance_brier: m.goes_distance.simulator.brier, distance_ece: m.goes_distance.simulator.ece, finish_crps: finishBlock(rs).round_crps_conditional_on_finish.simulator, tilt_median: tiltStats(rs).median, winner_brier: summarizeBinary(rs.map((r) => [r.probabilities.fighter_1_win / (1 - (r.probabilities.draw || 0)), r.truth.winner === 1 ? 1 : 0])).brier }; };
  uncalCompare = { n: both.length, calibrated: pack(both), uncalibrated: pack(u) };
}

const evidence = { reconciliation, uncalibrated_comparison: uncalCompare, parameter_stability: stability, generated_for: { mode: MODE, n_sims: N, eval_rows: rows.length, simulated: sim.length, insufficient: insufficient.length }, cohort: { size: cohort.length, excluded }, gate_counts: Object.fromEntries([...groupBy(rows, (r) => r.gate || r.status)].map(([k, v]) => [k, v.length])), winner, tilt, method, finish, round_stats: roundStats, round_winners: roundWinners, slices: { by_gate: byGate, by_min_coverage: byMinCov, by_year: byYear, by_weight_class: byWc, by_scheduled_rounds: byRounds }, prior_comparison: priorCompare, timing_ms_per_bout: r2(mean(rows.map((r) => r.ms))) };
fs.writeFileSync(path.join(CACHE, `report_${MODE}_n${N}.json`), JSON.stringify(evidence, null, 1));
console.log(JSON.stringify({ winner: { sim: winner.simulator_post_anchor.brier, champ: winner.champion_fold_prediction.brier, pre: winner.engine_pre_anchor_no_tilt.brier }, tilt: tilt.all, method: method.all.method_logloss, distance: { sim: method.all.goes_distance.simulator.brier, wc: method.all.goes_distance.weight_class_frequency.brier }, finish: finish.all.round_crps_conditional_on_finish, sig_l: roundStats.all.sig_l, round_winners: roundWinners, prior: priorCompare }, null, 1));
