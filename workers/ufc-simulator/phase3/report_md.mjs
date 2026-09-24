// Markdown tables from the Phase 3 evidence JSON (report.mjs output). The
// narrative report in docs/ embeds these tables; this script never writes
// conclusions, only numbers.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE } from './dataset.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--n', 2000));
const E = JSON.parse(fs.readFileSync(path.join(CACHE, `report_fold_n${N}.json`), 'utf8'));
const L = fs.existsSync(path.join(CACHE, 'leakage_audit.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'leakage_audit.json'), 'utf8')) : null;
const out = [];
const t = (header, rows) => { out.push('| ' + header.join(' | ') + ' |'); out.push('|' + header.map(() => '---').join('|') + '|'); for (const r of rows) out.push('| ' + r.map((v) => (v == null ? '—' : String(v))).join(' | ') + ' |'); out.push(''); };
const h = (s) => out.push(`\n### ${s}\n`);

h('Reconciliation');
const R = E.reconciliation;
t(['Disposition', 'Bouts'], [['Candidates: complete, model_scope, 2015+', R.candidate_bouts_2015_plus_complete_model_scope], ...Object.entries(R.excluded_before_cohort).map(([k, v]) => [`Excluded: ${k}`, v]), ['Cohort', R.cohort], ['Cohort 2015 (no prior training fold, not scored)', R.cohort_2015_no_prior_training_fold], ['Walk-forward target 2016–2026', R.walk_forward_target_2016_2026], ['Evaluated rows', R.evaluated_rows], ...Object.entries(R.by_disposition).map(([k, v]) => [`Row status: ${k}`, v]), ['REJECTED_SNAPSHOT rows', R.rejected_snapshot], ['Rows missing an anchor', R.missing_anchor_rows], ['Target bouts without a row', R.target_bouts_without_row], ['Reconciles', R.reconciles]]);

if (L) { h('Leakage audit'); t(['Check', 'Value'], [['Bouts checked', L.checked], ['Hard failures', JSON.stringify(L.failures)], ['Fallback corners (contaminated snapshot replaced by prior)', L.fallback_corners], ['Truncation sample / diffs', `${L.truncation_sample} / ${L.truncation_diffs}`], ['Closest included bout before event (days)', L.closest_included_bout_days_before_event], ['All passed', L.all_passed]]); }

h('Winner');
const W = E.winner;
t(['Probability source', 'n', 'Brier', 'Log loss', 'ECE', 'Accuracy'], [['Champion fold prediction (anchor)', W.champion_fold_prediction.n, W.champion_fold_prediction.brier, W.champion_fold_prediction.logloss, W.champion_fold_prediction.ece, W.champion_fold_prediction.accuracy], ['Engine pre-anchor (tilt 0)', W.engine_pre_anchor_no_tilt.n, W.engine_pre_anchor_no_tilt.brier, W.engine_pre_anchor_no_tilt.logloss, W.engine_pre_anchor_no_tilt.ece, W.engine_pre_anchor_no_tilt.accuracy], ['Simulator post-anchor', W.simulator_post_anchor.n, W.simulator_post_anchor.brier, W.simulator_post_anchor.logloss, W.simulator_post_anchor.ece, W.simulator_post_anchor.accuracy], ['Coin', '', 0.25, W.coin.logloss, '', '']]);
h('Winner reliability (post-anchor)');
t(['Bin', 'n', 'mean p', 'observed'], W.simulator_post_anchor.reliability.map((b) => [b.bin, b.n, b.mean_p, b.observed]));

h('Anchor tilt |tilt|');
const T = E.tilt;
const trow = (k, v) => [k, v.n, v.median, v.p75, v.p90, v.p95, v.p100, v.pct_max_tilt_hit, v.mean_abs_pre_minus_champ];
t(['Slice', 'n', 'median', 'p75', 'p90', 'p95', 'max', '% at/over max', 'mean |pre−champ|'], [trow('all', T.all), ...Object.entries(T.by_gate).map(([k, v]) => trow(`gate ${k}`, v)), ...Object.entries(T.by_min_coverage).map(([k, v]) => trow(`min coverage ${k}`, v)), ...Object.entries(T.by_min_stat_bouts).map(([k, v]) => trow(`min stat bouts ${k}`, v))]);
t(['Year', 'n', 'median', 'p90', '% at/over max'], Object.entries(T.by_year).map(([k, v]) => [k, v.n, v.median, v.p90, v.pct_max_tilt_hit]));
t(['Weight class', 'n', 'median', 'p90', '% at/over max'], Object.entries(T.by_weight_class).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, v.n, v.median, v.p90, v.pct_max_tilt_hit]));

h('Method');
const M = E.method.all;
t(['Metric', 'Simulator', 'Global frequency', 'Weight-class frequency'], [['Multiclass log loss', M.method_logloss.simulator, M.method_logloss.global_frequency, M.method_logloss.weight_class_frequency], ['Top-1 accuracy', M.method_top1_accuracy.simulator, '', M.method_top1_accuracy.weight_class_frequency]]);
t(['Class', 'n true', 'sim mean p', 'observed rate', 'sim Brier', 'WC-baseline Brier', 'sim ECE', 'precision (top-1)', 'recall (top-1)'], ['KO_TKO', 'SUB', 'DEC'].map((k) => [k, M.per_class[k].n_true, M.per_class[k].sim_mean_p, M.per_class[k].sim.base_rate, M.per_class[k].sim.brier, M.per_class[k].wc_baseline_brier, M.per_class[k].sim.ece, M.precision_recall_top1[k].precision, M.precision_recall_top1[k].recall]));
t(['Goes distance', 'n', 'Brier', 'Log loss', 'ECE', 'mean p', 'observed'], [['Simulator', M.goes_distance.simulator.n, M.goes_distance.simulator.brier, M.goes_distance.simulator.logloss, M.goes_distance.simulator.ece, M.goes_distance.simulator.mean_p, M.goes_distance.simulator.base_rate], ['Weight-class frequency', M.goes_distance.weight_class_frequency.n, M.goes_distance.weight_class_frequency.brier, M.goes_distance.weight_class_frequency.logloss, M.goes_distance.weight_class_frequency.ece, M.goes_distance.weight_class_frequency.mean_p, '']]);
for (const k of ['KO_TKO', 'DEC']) { out.push(`Per-class reliability, ${k}:`); t(['Bin', 'n', 'mean p', 'observed'], M.per_class[k].sim.reliability.filter((b) => b.n).map((b) => [b.bin, b.n, b.mean_p, b.observed])); }
t(['Gate', 'n', 'Method log loss sim', 'WC baseline', 'Distance Brier sim', 'WC baseline'], Object.entries(E.method.by_gate).map(([k, v]) => [k, v.n, v.method_logloss.simulator, v.method_logloss.weight_class_frequency, v.goes_distance.simulator.brier, v.goes_distance.weight_class_frequency.brier]));

h('Finish round and timing (finishes only)');
const F = E.finish;
const frow = (k, v) => [k, v.n_finishes, v.round_crps_conditional_on_finish.simulator, v.round_crps_conditional_on_finish.historical_conditional_on_method, v.round_crps_conditional_on_finish.historical_any_method, v.expected_round_mae.simulator, v.expected_round_mae.historical_conditional_on_method, v.projection_exact_method_and_round_hit_rate, v.elapsed_time_median_mae_sec.mae];
t(['Slice', 'finishes', 'CRPS sim', 'CRPS hist|method', 'CRPS hist any', 'E[round] MAE sim', 'E[round] MAE hist', 'projection method+round hit', 'elapsed-sec MAE (median)'], [frow('all', F.all), frow('truth KO/TKO or DEC-excluded (KO set)', F.by_truth_method.KO_TKO), frow('truth SUB set', F.by_truth_method.SUB), ...Object.entries(F.by_gate).map(([k, v]) => frow(`gate ${k}`, v))]);

h('Round statistics (full rounds only, per fighter-round)');
const S = E.round_stats.all;
t(['Stat', 'n', 'truth mean', 'Sim median MAE', 'Sim RMSE', 'Sim bias', 'Naive DNA MAE', 'Naive RMSE', 'Naive bias', 'Opp-adjusted MAE'], ['sig_l', 'sig_a', 'td_a', 'td_l', 'ctrl', 'kd', 'sub'].map((k) => [k, S[k].n_fighter_rounds, S[k].truth_mean, S[k].simulator_median.mae, S[k].simulator_median.rmse, S[k].simulator_median.bias, S[k].naive_dna_average.mae, S[k].naive_dna_average.rmse, S[k].naive_dna_average.bias, S[k].opponent_adjusted_average.mae]));
t(['Pace retention R3/R1', 'n', 'sim MAE', 'sim mean', 'observed mean'], [['', S.pace_retention_r3_vs_r1.n, S.pace_retention_r3_vs_r1.simulator_mae, S.pace_retention_r3_vs_r1.simulator_mean, S.pace_retention_r3_vs_r1.observed_mean]]);
t(['Gate', 'sig_l MAE sim', 'naive', 'td_l MAE sim', 'naive', 'ctrl MAE sim', 'naive'], Object.entries(E.round_stats.by_gate).map(([k, v]) => [k, v.sig_l.simulator_median.mae, v.sig_l.naive_dna_average.mae, v.td_l.simulator_median.mae, v.td_l.naive_dna_average.mae, v.ctrl.simulator_median.mae, v.ctrl.naive_dna_average.mae]));

h('Round winners (clean sweeps only)');
t(['Sweep bouts', 'Rounds scored', 'Sim round-winner accuracy', 'Baseline: champion favourite every round'], [[E.round_winners.sweep_bouts, E.round_winners.rounds_scored, E.round_winners.accuracy, E.round_winners.baseline_champion_favourite_every_round]]);

h('Slices');
const srow = (k, v) => [k, v.n, v.winner_brier, v.champion_brier, v.method_logloss, v.method_logloss_wc_baseline, v.distance_brier, v.distance_brier_wc_baseline, v.finish_round_crps, v.finish_round_crps_baseline, v.sig_l_mae, v.sig_l_mae_naive, v.td_l_mae, v.td_l_mae_naive, v.tilt_median, v.tilt_p90];
const hdr = ['Slice', 'n', 'Winner Brier', 'Champ Brier', 'Method LL', 'WC base', 'Dist Brier', 'WC base', 'Finish CRPS', 'Hist base', 'sig_l MAE', 'naive', 'td_l MAE', 'naive', 'tilt med', 'tilt p90'];
for (const [name, key] of [['By gate', 'by_gate'], ['By minimum coverage tier', 'by_min_coverage'], ['By year', 'by_year'], ['By weight class', 'by_weight_class'], ['By scheduled rounds', 'by_scheduled_rounds']]) { out.push(`${name}:`); t(hdr, Object.entries(E.slices[key]).map(([k, v]) => srow(k, v))); }

if (E.prior_comparison) { h('Fitted walk-forward vs Phase 2 priors (same bouts)'); const P = E.prior_comparison; t(['Metric', 'Fitted', 'Phase 2 priors'], Object.keys(P.fitted).map((k) => [k, P.fitted[k], P.phase2_priors[k]])); }

if (E.uncalibrated_comparison) { h('Hazard intercept recalibration: before vs after (same bouts)'); const U = E.uncalibrated_comparison; t(['Metric', 'Calibrated (final)', 'Uncalibrated fit'], Object.keys(U.calibrated).map((k) => [k, U.calibrated[k], U.uncalibrated[k]])); }

h('Parameter stability across folds 2016–2026');
const St = E.parameter_stability;
for (const [name, v] of Object.entries(St)) { if (!v.coefficients) continue; out.push(`Component \`${name}\` (dispersion: ${JSON.stringify(v.dispersion)}):`); t(['Feature', 'all-data fit', 'fold mean', 'sd', 'min', 'max', 'range 2021–26', 'unstable'], v.coefficients.map((c) => [c.feature, c.all_fit, c.mean, c.sd, c.min, c.max, c.range_2021_2026, c.unstable ? 'YES' : ''])); }
out.push(`Finish-time shapes by fold (other, KD): ${JSON.stringify(St.finish_time_shape?.by_fold)}; all-data: ${JSON.stringify(St.finish_time_shape?.all_fit)}`);
out.push(`Training bouts by fold: ${JSON.stringify(St.training_bouts_by_fold)}`);

const file = path.join(CACHE, `report_tables_n${N}.md`);
fs.writeFileSync(file, out.join('\n'));
console.log('wrote', file, out.length, 'lines');
