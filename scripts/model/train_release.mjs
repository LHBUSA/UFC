#!/usr/bin/env node
// PBE Fight Model v1 - release artifact.
//
//   node scripts/model/train_release.mjs
//
// Fits the shipping coefficients on the full graded history and writes
// web/lib/generated/model-v1.json: the coefficient vector, the feature scale,
// a spec hash, the walk-forward evidence, and a small set of worked examples
// drawn from the backtest.
//
// This writes a FILE. It writes nothing to the database. Registering the
// version in ufc_model_versions and publishing locked picks are separate,
// deliberate steps that happen after migration 010 is applied and after the
// decision to go live has actually been taken.
//
// The coefficients here are fitted on everything, including the bouts the
// walk-forward folds scored. That is correct for the model that will face the
// future and wrong for anything presented as evidence, so the artifact keeps
// the two apart: `model` is the fit, `evidence` is the walk-forward result, and
// nothing in the artifact reports an in-sample number as performance.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, readJsonl, ROOT } from './common.mjs';
import { FEATURES, FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION, MODEL_FAMILY } from './feature_spec.mjs';
import { fitFold } from './backtest.mjs';

const BAND = (p) => {
  const c = Math.max(p, 1 - p);
  return c < 0.55 ? '50-55' : c < 0.6 ? '55-60' : c < 0.65 ? '60-65' : c < 0.7 ? '65-70' : c < 0.8 ? '70-80' : '80-100';
};

function main() {
  const cache = cacheDir();
  const dataset = readJsonl(path.join(cache, 'dataset.jsonl'));
  const backtest = JSON.parse(fs.readFileSync(path.join(cache, 'backtest_v1.json'), 'utf8'));
  const preds = readJsonl(path.join(cache, 'backtest_predictions.jsonl'));
  const audit = JSON.parse(fs.readFileSync(path.join(cache, 'leakage_audit.json'), 'utf8'));

  const graded = dataset
    .filter((r) => r.graded)
    .sort((a, b) => (a.event_date === b.event_date ? a.bout_id.localeCompare(b.bout_id) : a.event_date.localeCompare(b.event_date)));

  const fit = fitFold(graded);
  const coefficients = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, fit.beta[i]]));
  const feature_scale = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, fit.scale[i]]));

  const canonical = JSON.stringify({
    model_version: MODEL_VERSION,
    feature_version: FEATURE_VERSION,
    features: FEATURE_KEYS,
    coefficients: FEATURE_KEYS.map((k) => coefficients[k]),
    scale: FEATURE_KEYS.map((k) => feature_scale[k]),
    lambda: fit.lambda,
  });
  const spec_sha256 = createHash('sha256').update(canonical).digest('hex');

  // Worked examples: real bouts, real out-of-sample probabilities, real
  // results, chosen deterministically so the page shows the model being wrong
  // as prominently as it shows it being right.
  const recent = preds.filter((p) => p.event_date >= '2024-01-01' && p.fighter_1_name && p.fighter_2_name);
  const withConf = recent.map((p) => ({ ...p, conf: Math.max(p.p, 1 - p.p), hit: (p.p >= 0.5) === (p.y === 1) }));
  const pickExample = (rows, note) => {
    const r = rows[0];
    if (!r) return null;
    const oneIsPick = r.p >= 0.5;
    return {
      note,
      bout_id: r.bout_id,
      event_date: r.event_date,
      event_name: r.event_name,
      weight_class: r.weight_class,
      is_womens: r.is_womens,
      fighter_a: { id: r.fighter_1_id, name: r.fighter_1_name, prob: r.p },
      fighter_b: { id: r.fighter_2_id, name: r.fighter_2_name, prob: 1 - r.p },
      pick_name: oneIsPick ? r.fighter_1_name : r.fighter_2_name,
      pick_probability: r.conf,
      confidence_band: BAND(r.p),
      market: r.p_market == null ? null : { implied_pick: oneIsPick ? r.p_market : 1 - r.p_market, books: r.market_books },
      outcome: r.hit ? 'WIN' : 'LOSS',
      winner_name: r.y === 1 ? r.fighter_1_name : r.fighter_2_name,
      result_method: r.result_method,
      sample_context: {
        min_prior_bouts: r.min_prior_bouts,
        min_stat_bouts: r.min_stat_bouts,
        features_available: r.available_count,
        features_total: FEATURE_KEYS.length,
      },
      fold_year: r.fold_year,
    };
  };

  // Deliberately drawn from the 60-70% band, where a quarter of the model's
  // calls actually live, rather than from the tail. Only six predictions in
  // seven thousand ever exceeded 90%, and building a showcase out of those
  // would advertise a confidence the model almost never has.
  const core = withConf.filter((r) => r.conf >= 0.6 && r.conf < 0.7);
  const byConfDesc = (a, b) => b.conf - a.conf || a.bout_id.localeCompare(b.bout_id);
  const examples = [
    pickExample(core.filter((r) => r.hit).sort(byConfDesc), 'A typical confident call that landed.'),
    pickExample(core.filter((r) => !r.hit).sort(byConfDesc), 'The same confidence, wrong. Roughly a third of calls in this band are.'),
    pickExample([...withConf].filter((r) => !r.hit).sort(byConfDesc), 'The most confident miss in the whole out-of-sample period.'),
    pickExample([...withConf].sort((a, b) => a.conf - b.conf || a.bout_id.localeCompare(b.bout_id)), 'A fight the model has no read on. It says so.'),
  ].filter(Boolean);

  const h = backtest.headline;
  const artifact = {
    generated_at: new Date().toISOString(),
    model: {
      model_version: MODEL_VERSION,
      model_family: MODEL_FAMILY,
      feature_version: FEATURE_VERSION,
      algorithm: 'ridge logistic regression, no intercept, antisymmetric differential features',
      validation: 'chronological walk-forward, expanding window, refit per calendar year',
      status: 'candidate',
      spec_sha256,
      lambda: fit.lambda,
      training_bouts: graded.length,
      training_window_start: graded[0]?.event_date ?? null,
      training_window_end: graded[graded.length - 1]?.event_date ?? null,
      feature_count: FEATURE_KEYS.length,
      coefficients,
      feature_scale,
    },
    features: FEATURES.map((f) => ({
      key: f.key,
      family: f.family,
      source: f.source,
      doc: f.doc,
      expected_sign: f.higherIsBetter ? '+' : '-',
      coefficient: coefficients[f.key],
    })),
    evidence: {
      protocol: backtest.protocol,
      out_of_sample: backtest.out_of_sample,
      model: strip(h.model),
      coin: strip(h.coin),
      winrate: strip(h.winrate),
      market: h.market.n ? strip(h.market) : { label: h.market.label, n: 0, note: h.market.note },
      brier_skill_vs_coin: h.model_vs_coin_brier_skill,
      brier_skill_vs_winrate: h.model_vs_winrate_brier_skill,
      calibration: backtest.calibration,
      by_confidence_band: backtest.by_confidence_band,
      by_division: backtest.by_division,
      by_year: backtest.by_year,
      by_sample_quality: backtest.by_sample_quality,
      folds: backtest.folds.map((f) => ({
        year: f.year, train_n: f.train_n, test_n: f.test_n, lambda: f.lambda, ...f.metrics,
      })),
      coefficient_signs: backtest.coefficient_signs,
    },
    leakage_audit: {
      all_passed: audit.all_passed,
      checks: audit.checks.map((c) => ({ name: c.name, pass: c.pass })),
      truncation_sample: audit.checks.find((c) => c.name === 'truncation')?.bouts_rebuilt_with_all_later_data_deleted ?? null,
      permuted_label_skill: audit.checks.find((c) => c.name === 'permutation')?.permuted_label_brier_skill_vs_coin ?? null,
      snapshot_record_check: audit.checks.find((c) => c.name === 'snapshot provenance')?.snapshot_record_vs_independent_ladder ?? null,
    },
    examples,
  };

  const out = path.join(ROOT, 'web', 'lib', 'generated', 'model-v1.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');

  console.log(`model_version   ${MODEL_VERSION}`);
  console.log(`feature_version ${FEATURE_VERSION}`);
  console.log(`spec_sha256     ${spec_sha256}`);
  console.log(`lambda          ${fit.lambda}   training bouts ${graded.length}`);
  for (const e of examples) console.log(`example         ${e.pick_name} ${(e.pick_probability * 100).toFixed(1)}% -> ${e.outcome}`);
  console.log(`-> ${out}`);
}

/** Drop the nested calibration bins from a headline block; the artifact carries
 *  pooled calibration once rather than three near-copies. */
function strip(m) {
  const { calibration, ...rest } = m;
  return { ...rest, calibration_ece: calibration?.ece ?? null, calibration_slope: calibration?.slope ?? null };
}

main();
