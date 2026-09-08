#!/usr/bin/env node
// PBE Fight Model v1 - chronological walk-forward backtest.
//
//   node scripts/model/backtest.mjs
//   node scripts/model/backtest.mjs --from 2013 --to 2026 --train-floor 1994
//
// WHY WALK-FORWARD AND NOT A RANDOM SPLIT
// ---------------------------------------
// A random train/test split of fight data is not a hard problem made easy, it
// is a different problem entirely. Fighters recur: a random split puts a
// fighter's 2019 bout in training and their 2018 bout in test, so the model is
// told how the career turned out before being asked to predict its middle. The
// number that comes back is not obtainable in production, where the future is
// genuinely absent. Every fold here trains only on bouts that had already
// happened and is scored only on bouts that had not.
//
// Each fold refits from scratch: feature scaling, the ridge penalty, and every
// coefficient are re-derived from that fold's training window alone. The
// penalty is chosen on an inner chronological validation split of the training
// window, never on the fold being scored.

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, readJsonl, writeJsonl } from './common.mjs';
import { FEATURES, FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } from './feature_spec.mjs';
import { fitLogistic, fitScale, applyScale, predictOne } from './logistic.mjs';
import { summarise, bySlice, byConfidenceBand, calibration, brier, logLoss, accuracy, auc, skill, wilson } from './metrics.mjs';
import { marketProbForRow } from './market_baseline.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const FROM_YEAR = Number(opt('--from', 2013));
const TO_YEAR = Number(opt('--to', 2026));
const TRAIN_FLOOR = opt('--train-floor', '1994-01-01');
const LAMBDA_GRID = [1, 2, 5, 10, 20, 40, 80, 160, 320];
const INNER_VALIDATION_SHARE = 0.2;

/** Simple historical win-rate baseline: no fitting, no coefficients. Each
 *  corner's Laplace-smoothed pre-fight win rate, normalised into a probability.
 *  This is the number a reasonable person would produce with a pen, and it is
 *  the bar the model has to clear to have earned its complexity. */
function winRateBaseline(row) {
  const a = row.side_1.winrate;
  const b = row.side_2.winrate;
  if (a == null || b == null || a + b <= 0) return 0.5;
  return a / (a + b);
}

function fitFold(trainRows, { lambdaGrid = LAMBDA_GRID } = {}) {
  const cut = Math.max(1, Math.floor(trainRows.length * (1 - INNER_VALIDATION_SHARE)));
  const inner = trainRows.slice(0, cut);
  const holdout = trainRows.slice(cut);

  let chosen = lambdaGrid[Math.floor(lambdaGrid.length / 2)];
  let lambdaScan = [];
  if (holdout.length >= 50 && inner.length >= 200) {
    const scaleInner = fitScale(inner.map((r) => r.x));
    const Xi = inner.map((r) => applyScale(r.x, scaleInner));
    const yi = inner.map((r) => r.label);
    let best = Infinity;
    for (const lambda of lambdaGrid) {
      const { beta } = fitLogistic(Xi, yi, lambda);
      const scored = holdout.map((r) => ({ p: predictOne(r.x, beta, scaleInner), y: r.label }));
      const ll = logLoss(scored);
      lambdaScan.push({ lambda, validation_log_loss: ll });
      if (ll < best) { best = ll; chosen = lambda; }
    }
  }

  const scale = fitScale(trainRows.map((r) => r.x));
  const X = trainRows.map((r) => applyScale(r.x, scale));
  const y = trainRows.map((r) => r.label);
  const fit = fitLogistic(X, y, chosen);
  return { beta: fit.beta, scale, lambda: chosen, lambdaScan, iterations: fit.iterations, converged: fit.converged, n: trainRows.length };
}

function main() {
  const cache = cacheDir();
  const all = readJsonl(path.join(cache, 'dataset.jsonl'));
  const marketRows = readJsonl(path.join(cache, 'market.jsonl'));
  const observationsByBout = new Map();
  for (const o of marketRows) {
    if (!observationsByBout.has(o.bout_id)) observationsByBout.set(o.bout_id, []);
    observationsByBout.get(o.bout_id).push(o);
  }

  const graded = all
    .filter((r) => r.graded && r.event_date >= TRAIN_FLOOR)
    .sort((a, b) => (a.event_date === b.event_date ? a.bout_id.localeCompare(b.bout_id) : a.event_date.localeCompare(b.event_date)));

  const folds = [];
  const scored = [];

  for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
    const boundary = `${year}-01-01`;
    const nextBoundary = `${year + 1}-01-01`;
    const train = graded.filter((r) => r.event_date < boundary);
    const test = graded.filter((r) => r.event_date >= boundary && r.event_date < nextBoundary);
    if (test.length < 25 || train.length < 500) {
      folds.push({ year, skipped: true, train_n: train.length, test_n: test.length });
      continue;
    }

    const model = fitFold(train);
    const foldRows = test.map((r) => {
      const p = predictOne(r.x, model.beta, model.scale);
      const market = marketProbForRow(r, observationsByBout);
      return {
        bout_id: r.bout_id,
        event_date: r.event_date,
        event_name: r.event_name,
        fold_year: year,
        fighter_1_id: r.fighter_1_id,
        fighter_2_id: r.fighter_2_id,
        fighter_1_name: r.fighter_1_name,
        fighter_2_name: r.fighter_2_name,
        weight_class: r.weight_class,
        is_womens: r.is_womens,
        is_title: r.is_title,
        scheduled_rounds: r.scheduled_rounds,
        min_prior_bouts: r.min_prior_bouts,
        min_stat_bouts: r.min_stat_bouts,
        available_count: r.available_count,
        result_method: r.result_method,
        p,
        y: r.label,
        p_winrate: winRateBaseline(r),
        p_market: market?.p ?? null,
        market_books: market?.books ?? null,
      };
    });
    scored.push(...foldRows);

    folds.push({
      year,
      train_n: train.length,
      train_from: train[0]?.event_date ?? null,
      train_to: train[train.length - 1]?.event_date ?? null,
      test_n: test.length,
      lambda: model.lambda,
      iterations: model.iterations,
      converged: model.converged,
      lambda_scan: model.lambdaScan,
      coefficients: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, model.beta[i]])),
      metrics: {
        brier: brier(foldRows),
        log_loss: logLoss(foldRows),
        accuracy: accuracy(foldRows),
        auc: auc(foldRows),
      },
      baselines: {
        coin: { brier: 0.25, log_loss: Math.log(2) },
        winrate: {
          brier: brier(foldRows.map((r) => ({ p: r.p_winrate, y: r.y }))),
          log_loss: logLoss(foldRows.map((r) => ({ p: r.p_winrate, y: r.y }))),
          accuracy: accuracy(foldRows.map((r) => ({ p: r.p_winrate, y: r.y }))),
        },
      },
    });
    process.stdout.write(
      `${year}: train ${String(train.length).padStart(5)}  test ${String(test.length).padStart(4)}  ` +
      `lambda ${String(model.lambda).padStart(3)}  brier ${brier(foldRows).toFixed(5)}  ` +
      `logloss ${logLoss(foldRows).toFixed(5)}  acc ${(accuracy(foldRows) * 100).toFixed(2)}%  auc ${(auc(foldRows) ?? 0).toFixed(4)}\n`,
    );
  }

  // ---- pooled out-of-sample scoring ------------------------------------
  const model = summarise(scored, 'PBE Fight Model v1');
  const coin = summarise(scored.map((r) => ({ p: 0.5, y: r.y })), '50/50 baseline');
  const winrate = summarise(scored.map((r) => ({ p: r.p_winrate, y: r.y })), 'Historical win-rate baseline');

  const marketRowsScored = scored.filter((r) => r.p_market != null);
  const market = marketRowsScored.length
    ? {
        ...summarise(marketRowsScored.map((r) => ({ p: r.p_market, y: r.y })), 'Market implied (de-vigged)'),
        model_on_same_rows: summarise(marketRowsScored.map((r) => ({ p: r.p, y: r.y })), 'PBE model, market-matched subset'),
      }
    : { label: 'Market implied (de-vigged)', n: 0, note: 'No completed bout in this database has a timestamp-compatible market observation. The comparison is built and will populate as the market ingest accumulates history against fights that then get graded; it is not estimated in the meantime.' };

  const hits = scored.filter((r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0)).length;
  const summary = {
    model_version: MODEL_VERSION,
    feature_version: FEATURE_VERSION,
    generated_at: new Date().toISOString(),
    protocol: {
      validation: 'chronological walk-forward, expanding training window, refit per fold',
      folds: `${FROM_YEAR}..${TO_YEAR} by calendar year`,
      train_floor: TRAIN_FLOOR,
      lambda_grid: LAMBDA_GRID,
      lambda_selection: `inner chronological split, last ${INNER_VALIDATION_SHARE * 100}% of each training window`,
      orientation: 'canonical corner = lexicographically smaller fighter UUID; outcome-independent',
      intercept: 'none (antisymmetric features)',
      excluded: 'draws, no-contests and ungraded bouts carry no binary label and are excluded from training and scoring',
    },
    out_of_sample: {
      n: scored.length,
      first_event: scored.length ? scored[0].event_date : null,
      last_event: scored.length ? scored[scored.length - 1].event_date : null,
      base_rate: scored.length ? scored.reduce((a, r) => a + r.y, 0) / scored.length : null,
      hits,
      hit_rate_ci95: wilson(hits, scored.length),
    },
    headline: {
      model,
      coin,
      winrate,
      market,
      model_vs_coin_brier_skill: skill(model.brier, coin.brier),
      model_vs_winrate_brier_skill: skill(model.brier, winrate.brier),
      model_vs_winrate_logloss_delta: winrate.log_loss - model.log_loss,
    },
    by_confidence_band: byConfidenceBand(scored),
    by_division: bySlice(scored, (r) => `${r.is_womens ? "Women's " : ''}${r.weight_class ?? 'UNKNOWN'}`, { minN: 25 }),
    by_year: bySlice(scored, (r) => r.fold_year),
    by_sample_quality: bySlice(scored, (r) =>
      r.min_prior_bouts === 0 ? 'a. one corner debuting'
        : r.min_prior_bouts < 3 ? 'b. both corners 1-2 prior bouts'
        : r.min_prior_bouts < 6 ? 'c. both corners 3-5 prior bouts'
        : 'd. both corners 6+ prior bouts'),
    by_scheduled_rounds: bySlice(scored, (r) => `${r.scheduled_rounds ?? '?'} rounds`, { minN: 25 }),
    calibration: calibration(scored),
    folds,
    coefficient_signs: coefficientReport(folds),
  };

  fs.writeFileSync(path.join(cache, 'backtest_v1.json'), JSON.stringify(summary, null, 2));
  writeJsonl(path.join(cache, 'backtest_predictions.jsonl'), scored);

  console.log('\n== pooled out-of-sample ==');
  const line = (m) => `${m.label.padEnd(34)} n=${String(m.n).padStart(5)}  brier ${m.brier?.toFixed(5) ?? '-'}  logloss ${m.log_loss?.toFixed(5) ?? '-'}  acc ${m.accuracy != null ? (m.accuracy * 100).toFixed(2) + '%' : '-'}  auc ${m.auc?.toFixed(4) ?? '-'}`;
  console.log(line(model));
  console.log(line(coin));
  console.log(line(winrate));
  console.log(market.n ? line(market) : `${market.label.padEnd(34)} n=0  (no timestamp-compatible market data for any graded bout)`);
  console.log(`\nBrier skill vs coin      ${(summary.headline.model_vs_coin_brier_skill * 100).toFixed(2)}%`);
  console.log(`Brier skill vs win-rate  ${(summary.headline.model_vs_winrate_brier_skill * 100).toFixed(2)}%`);
  console.log(`Calibration ECE ${model.calibration.ece.toFixed(4)}  slope ${model.calibration.slope?.toFixed(3)}`);
  console.log(`\n-> ${path.join(cache, 'backtest_v1.json')}`);
  return summary;
}

/** Mean coefficient across folds, flagged where the learned sign contradicts
 *  the documented fight-sense prior. Flags are reported, never corrected. */
function coefficientReport(folds) {
  const used = folds.filter((f) => f.coefficients);
  return FEATURES.map((f) => {
    const vals = used.map((fold) => fold.coefficients[f.key]);
    const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    const positiveShare = vals.length ? vals.filter((v) => v > 0).length / vals.length : null;
    return {
      key: f.key,
      family: f.family,
      source: f.source,
      mean_coefficient: mean,
      sign_stability: positiveShare == null ? null : Math.max(positiveShare, 1 - positiveShare),
      expected_sign: f.higherIsBetter ? '+' : '-',
      contradicts_prior: mean == null ? null : (mean > 0) !== f.higherIsBetter,
    };
  }).sort((a, b) => Math.abs(b.mean_coefficient ?? 0) - Math.abs(a.mean_coefficient ?? 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) main();
export { main as runBacktest, fitFold, winRateBaseline };
