#!/usr/bin/env node
// PBE Fight Model V2 research sprint - one reproducible run.
//
//   PBE_MODEL_CACHE=<clean extract> node scripts/model/v2/research.mjs [--live live.json] [--no-gbm]
//
// Reads the read-only extract (extract_dataset.mjs + build_features.mjs), never
// the database, and writes v2_research.json beside it. Nothing here touches V1:
// its coefficients, its locked calls and its artifact are read, never written.
//
// Protocol (fixed before any result was looked at; see docs/model/V2_RESEARCH.md):
//   - chronological walk-forward, expanding window, refit per calendar year, the
//     V1 recipe (walkforward_core.fitFold) for every ridge candidate;
//   - Elo K and opponent-metric centring chosen on bouts before 2013 only;
//   - the shrinkage layer for year Y is fitted on walk-forward predictions of
//     years < Y only;
//   - the selection policy is tuned on folds <= 2021 and scored once on 2022+;
//   - the 27 live calls are replayed for reporting only and choose nothing.

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../common.mjs';
import { FEATURE_KEYS, FEATURES } from '../feature_spec.mjs';
import { fitFold, trainingOrder } from '../walkforward_core.mjs';
import { predictOne, sigmoid } from '../logistic.mjs';
import { brier, logLoss, accuracy, auc, calibration, byConfidenceBand, wilson } from '../metrics.mjs';
import { loadV2, PRE_ERA } from './dataset_v2.mjs';
import { fitGbm, gbmPredict, GBM_DEFAULTS } from './gbm.mjs';
import { fitShrinkage, applyShrinkage } from './shrinkage.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const NO_GBM = argv.includes('--no-gbm');
const CACHE = cacheDir();
const FROM_YEAR = 2013, TO_YEAR = 2026, POLICY_TUNE_LAST = 2021;
const CONTENDER = /contender series|\bdwcs\b/i;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const { dataset, extrasOf, eloChoice, popMeans, withX, KEYS } = await loadV2(CACHE);
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

const graded = dataset.filter((r) => r.graded).sort(trainingOrder);
const meta = (r) => ({
  bout_id: r.bout_id, event_id: r.event_id, event_date: r.event_date, event_name: r.event_name, weight_class: r.weight_class,
  is_title: r.is_title, scheduled_rounds: r.scheduled_rounds, min_prior_bouts: r.min_prior_bouts, min_stat_bouts: r.min_stat_bouts,
  available_count: r.available_count, features_total: FEATURE_KEYS.length, side_1: r.side_1, side_2: r.side_2, y: r.label,
  dwcs: CONTENDER.test(r.event_name || ''),
});

function walkRidge(set) {
  const rows = graded.map((r) => withX(r, set));
  const scored = [], folds = [];
  for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
    const train = rows.filter((r) => r.event_date < `${year}-01-01`);
    const test = rows.filter((r) => r.event_date >= `${year}-01-01` && r.event_date < `${year + 1}-01-01`);
    if (test.length < 25 || train.length < 500) continue;
    const m = fitFold(train);
    folds.push({ year, lambda: m.lambda, train_n: train.length, test_n: test.length, boundary_ok: train.at(-1).event_date < test[0].event_date });
    for (const r of test) scored.push({ ...meta(r), fold_year: year, z: Math.log(predictOne(r.x, m.beta, m.scale) / (1 - predictOne(r.x, m.beta, m.scale))), p: predictOne(r.x, m.beta, m.scale) });
  }
  return { scored, folds };
}

function walkGbm(set) {
  const rows = graded.map((r) => withX(r, set));
  const scored = [], folds = [];
  for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
    const train = rows.filter((r) => r.event_date < `${year}-01-01`);
    const test = rows.filter((r) => r.event_date >= `${year}-01-01` && r.event_date < `${year + 1}-01-01`);
    if (test.length < 25 || train.length < 500) continue;
    const cut = Math.floor(train.length * 0.8);
    const inner = fitGbm(train.slice(0, cut).map((r) => r.x), train.slice(0, cut).map((r) => r.label), {}, { X: train.slice(cut).map((r) => r.x), y: train.slice(cut).map((r) => r.label) });
    let nTrees = 1, best = Infinity;
    inner.valTrace.forEach((ll, i) => { if (ll < best) { best = ll; nTrees = i + 1; } });
    const full = fitGbm(train.map((r) => r.x), train.map((r) => r.label), { maxTrees: nTrees });
    folds.push({ year, n_trees: nTrees, inner_val_log_loss: best, train_n: train.length, test_n: test.length });
    for (const r of test) { const p = gbmPredict(full, r.x); scored.push({ ...meta(r), fold_year: year, p, z: Math.log(p / (1 - p)) }); }
    log('gbm fold', year, 'trees', nTrees);
  }
  return { scored, folds };
}

/** Shrinkage for year Y fitted on this candidate's own walk-forward predictions of years < Y. */
function withShrinkage(scored) {
  const out = [], fits = [];
  for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
    const shr = fitShrinkage(scored.filter((r) => r.fold_year < year));
    if (shr) fits.push({ year, c: shr.c, n: shr.n });
    for (const r of scored.filter((x) => x.fold_year === year)) out.push({ ...r, p_base: r.p, p: applyShrinkage(shr, r.p, r), shrunk: Boolean(shr) });
  }
  return { scored: out, fits };
}

/* --------------------------------------------------------------- metrics */

const recalSlope = (rows) => {
  /* Logistic recalibration slope: fit y ~ sigmoid(a * logit p). a < 1 = overconfident. */
  let a = 1;
  for (let it = 0; it < 50; it++) {
    let g = 0, h = 0;
    for (const r of rows) { const z = Math.log(Math.min(1 - 1e-12, Math.max(1e-12, r.p)) / (1 - Math.min(1 - 1e-12, Math.max(1e-12, r.p)))); const p = sigmoid(a * z); g += (r.y - p) * z; h += p * (1 - p) * z * z; }
    const step = g / (h || 1); a += step; if (Math.abs(step) < 1e-10) break;
  }
  return a;
};
const summary = (rows) => {
  if (!rows.length) return { n: 0 };
  const cal = calibration(rows);
  return { n: rows.length, brier: brier(rows), log_loss: logLoss(rows), accuracy: accuracy(rows), auc: auc(rows), ece: cal.ece, bin_slope: cal.slope, recal_slope: recalSlope(rows), mean_conf: mean(rows.map((r) => Math.max(r.p, 1 - r.p))) };
};
const slice = (rows, keyFn, order = null) => {
  const g = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const keys = order ? order.filter((k) => g.has(k)) : [...g.keys()].sort();
  return keys.map((k) => ({ key: k, ...summary(g.get(k)), hit_rate: accuracy(g.get(k)) }));
};

const bucketPrior = (n) => (n === 0 ? '0 debut' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : n <= 9 ? '6-9' : '10+');
const PRIOR_ORDER = ['0 debut', '1-2', '3-5', '6-9', '10+'];
const bucketStat = (n) => (n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : '6+');
const bucketAvail = (n) => (n < 20 ? '<20' : n < 28 ? '20-27' : n < 31 ? '28-30' : '31-33');
const ageGap = (r) => (r.side_1.age_years == null || r.side_2.age_years == null ? null : (() => { const g = Math.abs(r.side_1.age_years - r.side_2.age_years); return g < 2 ? '<2y' : g < 5 ? '2-5y' : g < 8 ? '5-8y' : '8y+'; })());
const reachGap = (r) => (r.side_1.reach_in == null || r.side_2.reach_in == null ? null : (() => { const g = Math.abs(r.side_1.reach_in - r.side_2.reach_in); return g < 2 ? '<2in' : g < 4 ? '2-4in' : '4in+'; })());
const layoff = (r) => { const l = Math.max(r.side_1.layoff_log ?? -1, r.side_2.layoff_log ?? -1); if (l < 0) return 'n/a'; const d = Math.expm1(l); return d < 180 ? '<6mo' : d < 365 ? '6-12mo' : d < 730 ? '1-2y' : '2y+'; };
const arche = (s) => (s.td_landed_per15 == null ? 'unknown' : s.td_landed_per15 >= 2 || (s.control_share ?? 0) >= 0.3 ? 'grappler' : s.td_landed_per15 < 0.8 && (s.control_share ?? 0) < 0.12 ? 'striker' : 'mixed');
const matchup = (r) => [arche(r.side_1), arche(r.side_2)].sort().join(' v ');
const context = (r) => (r.is_title ? 'title' : r.scheduled_rounds === 5 ? 'five-round non-title' : 'three-round');

function diagnostics(rows) {
  return {
    overall: summary(rows),
    by_prior_bouts: slice(rows, (r) => bucketPrior(r.min_prior_bouts), PRIOR_ORDER),
    by_stat_bouts: slice(rows, (r) => bucketStat(r.min_stat_bouts), ['0', '1-2', '3-5', '6+']),
    by_feature_availability: slice(rows, (r) => bucketAvail(r.available_count), ['<20', '20-27', '28-30', '31-33']),
    by_confidence_band: byConfidenceBand(rows),
    by_weight_class: slice(rows, (r) => r.weight_class),
    by_context: slice(rows, context),
    by_layoff: slice(rows, layoff, ['<6mo', '6-12mo', '1-2y', '2y+', 'n/a']),
    by_age_gap: slice(rows, ageGap, ['<2y', '2-5y', '5-8y', '8y+']),
    by_reach_gap: slice(rows, reachGap, ['<2in', '2-4in', '4in+']),
    by_archetype: slice(rows, matchup),
    extreme_by_prior: PRIOR_ORDER.map((b) => {
      const ex = rows.filter((r) => bucketPrior(r.min_prior_bouts) === b && Math.max(r.p, 1 - r.p) >= 0.75);
      return { key: b, n_extreme: ex.length, share: ex.length / (rows.filter((r) => bucketPrior(r.min_prior_bouts) === b).length || 1), mean_conf: ex.length ? mean(ex.map((r) => Math.max(r.p, 1 - r.p))) : null, hit_rate: ex.length ? accuracy(ex) : null };
    }),
  };
}

/** Event-cluster paired bootstrap of (candidate - reference) Brier and log loss. Negative = candidate better. */
function pairedBootstrap(cand, ref, B = 2000, seed = 7) {
  const refBy = new Map(ref.map((r) => [r.bout_id, r]));
  const pairs = cand.filter((r) => refBy.has(r.bout_id)).map((r) => ({ ev: r.event_id, db: (r.p - r.y) ** 2 - (refBy.get(r.bout_id).p - r.y) ** 2, dl: ll1(r) - ll1(refBy.get(r.bout_id)) }));
  const byEv = new Map();
  for (const p of pairs) { if (!byEv.has(p.ev)) byEv.set(p.ev, []); byEv.get(p.ev).push(p); }
  const evs = [...byEv.values()];
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const db = [], dl = [];
  for (let b = 0; b < B; b++) {
    let sb = 0, sl = 0, n = 0;
    for (let i = 0; i < evs.length; i++) { const e = evs[Math.floor(rnd() * evs.length)]; for (const p of e) { sb += p.db; sl += p.dl; n += 1; } }
    db.push(sb / n); dl.push(sl / n);
  }
  db.sort((a, b) => a - b); dl.sort((a, b) => a - b);
  const q = (a, x) => a[Math.floor(x * (a.length - 1))];
  return { n: pairs.length, events: evs.length, brier_diff: mean(pairs.map((p) => p.db)), brier_ci95: [q(db, 0.025), q(db, 0.975)], log_loss_diff: mean(pairs.map((p) => p.dl)), log_loss_ci95: [q(dl, 0.025), q(dl, 0.975)], p_better_brier: db.filter((v) => v < 0).length / B };
}
const ll1 = (r) => { const p = Math.min(1 - 1e-12, Math.max(1e-12, r.p)); return r.y ? -Math.log(p) : -Math.log(1 - p); };

/* ------------------------------------------------------------- run all */

const runs = {};
for (const set of ['v1', 'c2elo', 'c2dna', 'c2', 'c3only', 'c3']) { log('ridge', set); runs[`ridge_${set}`] = walkRidge(set); }
if (!NO_GBM) { log('gbm c3'); runs.gbm_c3 = walkGbm('c3'); }
for (const k of Object.keys(runs)) { const s = withShrinkage(runs[k].scored); runs[`${k}+shrink`] = { scored: s.scored, folds: runs[k].folds, shrink_fits: s.fits }; }

/* Baselines on the same rows. */
const v1 = runs.ridge_v1.scored;
runs.coin = { scored: v1.map((r) => ({ ...r, p: 0.5 })) };
runs.winrate = { scored: v1.map((r) => { const a = r.side_1.winrate, b = r.side_2.winrate; return { ...r, p: a != null && b != null && a + b > 0 ? a / (a + b) : 0.5 }; }) };

/* Common scoring window: years where every candidate (including shrinkage, which needs prior OOF years) is defined. */
const SCORE_FROM = 2015;
const inWindow = (r) => r.fold_year >= SCORE_FROM;
const table = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { all_years: summary(v.scored), from_2015: summary(v.scored.filter(inWindow)), recent_2022: summary(v.scored.filter((r) => r.fold_year >= 2022)) }]));
const boot = Object.fromEntries(Object.keys(runs).filter((k) => k !== 'ridge_v1').map((k) => [k, { from_2015: pairedBootstrap(runs[k].scored.filter(inWindow), v1.filter(inWindow)), recent_2022: pairedBootstrap(runs[k].scored.filter((r) => r.fold_year >= 2022), v1.filter((r) => r.fold_year >= 2022)) }]));
/* Does C3 (interactions) add anything over C2? Same paired bootstrap, C2 as the reference. */
boot.ridge_c2_vs_c2elo = { from_2015: pairedBootstrap(runs.ridge_c2.scored.filter(inWindow), runs.ridge_c2elo.scored.filter(inWindow)), recent_2022: pairedBootstrap(runs.ridge_c2.scored.filter((r) => r.fold_year >= 2022), runs.ridge_c2elo.scored.filter((r) => r.fold_year >= 2022)) };
boot.ridge_c3_vs_c2 = { from_2015: pairedBootstrap(runs.ridge_c3.scored.filter(inWindow), runs.ridge_c2.scored.filter(inWindow)), recent_2022: pairedBootstrap(runs.ridge_c3.scored.filter((r) => r.fold_year >= 2022), runs.ridge_c2.scored.filter((r) => r.fold_year >= 2022)) };
if (!NO_GBM) boot.gbm_c3_vs_ridge_c3 = { from_2015: pairedBootstrap(runs.gbm_c3.scored.filter(inWindow), runs.ridge_c3.scored.filter(inWindow)), recent_2022: pairedBootstrap(runs.gbm_c3.scored.filter((r) => r.fold_year >= 2022), runs.ridge_c3.scored.filter((r) => r.fold_year >= 2022)) };
const diag = Object.fromEntries(['ridge_v1', 'ridge_v1+shrink', 'ridge_c2elo', 'ridge_c2elo+shrink', 'ridge_c2', 'ridge_c2+shrink', 'ridge_c3', 'ridge_c3+shrink', ...(NO_GBM ? [] : ['gbm_c3', 'gbm_c3+shrink'])].map((k) => [k, diagnostics(runs[k].scored.filter(inWindow))]));

/* ---------------------------------------------------- selection policy */

const TIERS = [['1-2', (n) => n >= 1 && n <= 2], ['3-5', (n) => n >= 3 && n <= 5], ['6+', (n) => n >= 6]];
const THRESH = [0.55, 0.575, 0.6, 0.625, 0.65, 0.7, 0.75, 1.01];
const eligible = (r) => !r.dwcs && r.min_prior_bouts >= 1 && r.available_count >= 20;
const pickHit = (r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0);
function policyEval(rows, th) {
  const pub = rows.filter((r) => eligible(r) && TIERS.some(([k, f], i) => f(r.min_prior_bouts) && Math.max(r.p, 1 - r.p) >= th[i]));
  const hits = pub.filter(pickHit).length;
  const base = rows.filter(eligible).length;
  return { published: pub.length, eligible: base, coverage: pub.length / (base || 1), hits, hit_rate: hits / (pub.length || 1), wilson: wilson(hits, pub.length), brier_published: pub.length ? brier(pub.map((r) => ({ p: Math.max(r.p, 1 - r.p), y: pickHit(r) ? 1 : 0 }))) : null };
}
function tunePolicy(rows) {
  /* Objective fixed in advance: maximise the Wilson lower bound of the published hit rate, subject to publishing
   * at least 35% of eligible bouts. Fewer, better calls - but never a policy that only calls a handful. */
  let best = null;
  for (const a of THRESH) for (const b of THRESH) for (const c of THRESH) {
    const e = policyEval(rows, [a, b, c]);
    if (e.coverage < 0.35 || !e.wilson) continue;
    if (!best || e.wilson.lo > best.e.wilson.lo) best = { th: [a, b, c], e };
  }
  return best;
}
/* The fair comparison for any sample-aware rule: one uniform threshold tuned under the same objective. */
function tuneUniform(rows) {
  let best = null;
  for (const a of THRESH) {
    const e = policyEval(rows, [a, a, a]);
    if (e.coverage < 0.35 || !e.wilson) continue;
    if (!best || e.wilson.lo > best.e.wilson.lo) best = { th: [a, a, a], e };
  }
  return best;
}
const policy = {};
for (const k of ['ridge_v1', 'ridge_v1+shrink', 'ridge_c2elo', 'ridge_c2', 'ridge_c3+shrink', ...(NO_GBM ? [] : ['gbm_c3', 'gbm_c3+shrink'])]) {
  const rows = runs[k].scored;
  const tune = rows.filter((r) => r.fold_year <= POLICY_TUNE_LAST && r.fold_year >= SCORE_FROM);
  const hold = rows.filter((r) => r.fold_year > POLICY_TUNE_LAST);
  const tuned = tunePolicy(tune);
  policy[k] = {
    v1_rule_holdout: policyEval(hold, [0.55, 0.55, 0.55]),
    v1_rule_tune: policyEval(tune, [0.55, 0.55, 0.55]),
    tuned_thresholds: { tiers: TIERS.map(([n]) => n), thresholds: tuned?.th ?? null },
    tuned_on_tune: tuned?.e ?? null,
    tuned_holdout: tuned ? policyEval(hold, tuned.th) : null,
    no_thin_holdout: policyEval(hold, [1.01, 0.55, 0.55]),
    uniform_threshold: tuneUniform(tune)?.th?.[0] ?? null,
    uniform_holdout: (() => { const u = tuneUniform(tune); return u ? policyEval(hold, u.th) : null; })(),
  };
}

/* ------------------------------------------------- live replay (report only) */

let live = null;
const liveFile = opt('--live');
if (liveFile && fs.existsSync(liveFile)) {
  const calls = JSON.parse(fs.readFileSync(liveFile, 'utf8')).filter((p) => p.grade && ['WIN', 'LOSS'].includes(p.grade.result));
  const firstLive = calls.map((p) => p.ufc_events.event_date).sort()[0];
  const byBout = new Map(dataset.map((r) => [r.bout_id, r]));
  const v1art = JSON.parse(fs.readFileSync(new URL('../../../web/lib/generated/model-v1.json', import.meta.url), 'utf8')).model;
  const famOf = new Map(FEATURES.map((f) => [f.key, f.family]));
  const models = {};
  for (const set of ['v1', 'c2elo', 'c2', 'c3']) {
    const train = graded.filter((r) => r.event_date < firstLive).map((r) => withX(r, set));
    models[set] = fitFold(train);
  }
  /* Shrinkage for the live window: fitted on every walk-forward prediction dated before the first live event. */
  const shrV1 = fitShrinkage(runs.ridge_v1.scored.filter((r) => r.event_date < firstLive));
  const shrC3 = fitShrinkage(runs.ridge_c3.scored.filter((r) => r.event_date < firstLive));
  const rows = [];
  for (const p of calls) {
    const r = byBout.get(p.bout_id);
    if (!r) continue;
    const pickIs1 = p.pick_fighter_id === r.fighter_1_id;
    const toPick = (q) => (pickIs1 ? q : 1 - q);
    const y = p.grade.result === 'WIN' ? 1 : 0;
    const m = meta(r);
    const cand = {};
    for (const set of ['v1', 'c2elo', 'c2', 'c3']) cand[set] = toPick(predictOne(withX(r, set).x, models[set].beta, models[set].scale));
    cand['v1+shrink'] = toPick(applyShrinkage(shrV1, predictOne(r.x, models.v1.beta, models.v1.scale), m));
    cand['c3+shrink'] = toPick(applyShrinkage(shrC3, predictOne(withX(r, 'c3').x, models.c3.beta, models.c3.scale), m));
    const fam = {};
    /* V1 logit contribution of each feature family TOWARD THE PICK, from this bout's canonical vector and the registered artifact. */
    FEATURE_KEYS.forEach((k, j) => { const c = ((v1art.coefficients[k] * r.x[j]) / v1art.feature_scale[k]) * (pickIs1 ? 1 : -1); const f = famOf.get(k); fam[f] = (fam[f] || 0) + c; });
    rows.push({ event_date: p.ufc_events.event_date, names: (p.sample_context.identity || []).map((i) => i.name).join(' v '), y, stored: p.pick_probability, market: p.sample_context?.market?.status === 'FRESH' ? p.market_implied_prob_pick : null, min_prior: r.min_prior_bouts, min_stat: r.min_stat_bouts, cand, v1_family_logit: fam, pick_is_canonical_1: pickIs1 });
  }
  const sc = (key) => summary(rows.map((x) => ({ p: key === 'stored' ? x.stored : key === 'market' ? x.market : x.cand[key], y: x.y })).filter((x) => x.p != null));
  const paired = rows.filter((x) => x.market != null);
  live = {
    first_live_event: firstLive, n: rows.length, train_rows_before_live: graded.filter((r) => r.event_date < firstLive).length,
    shrink_live: { v1: shrV1?.c ?? null, c3: shrC3?.c ?? null },
    overall: Object.fromEntries(['stored', 'v1', 'v1+shrink', 'c2elo', 'c2', 'c3', 'c3+shrink'].map((k) => [k, sc(k)])),
    paired_market: { n: paired.length, ...Object.fromEntries(['stored', 'market', 'v1+shrink', 'c2elo', 'c2', 'c3', 'c3+shrink'].map((k) => [k, brier(paired.map((x) => ({ p: k === 'stored' ? x.stored : k === 'market' ? x.market : x.cand[k], y: x.y })))])) },
    by_prior: PRIOR_ORDER.concat(['<3', '3-5 live', '6+ live']).slice(5).map((b) => {
      const f = b === '<3' ? (x) => x.min_prior < 3 : b === '3-5 live' ? (x) => x.min_prior >= 3 && x.min_prior <= 5 : (x) => x.min_prior >= 6;
      const g = rows.filter(f);
      return { key: b, n: g.length, ...Object.fromEntries(['stored', 'v1+shrink', 'c2elo', 'c3+shrink'].map((k) => [k, brier(g.map((x) => ({ p: k === 'stored' ? x.stored : x.cand[k], y: x.y })))])) };
    }),
    rows,
  };
}

/* ---------------------------------------------------------------- write */

const report = {
  generated_at: new Date().toISOString(),
  protocol: { from_year: FROM_YEAR, to_year: TO_YEAR, score_from: SCORE_FROM, policy_tune_last: POLICY_TUNE_LAST, pre_era: PRE_ERA, gbm: NO_GBM ? null : GBM_DEFAULTS },
  data: { rows: dataset.length, graded: graded.length, feature_audit: JSON.parse(fs.readFileSync(path.join(CACHE, 'feature_audit.json'), 'utf8')) },
  elo: eloChoice, pop_means: popMeans,
  feature_keys: KEYS,
  folds: Object.fromEntries(Object.entries(runs).filter(([, v]) => v.folds).map(([k, v]) => [k, v.folds])),
  shrink_fits: Object.fromEntries(Object.entries(runs).filter(([, v]) => v.shrink_fits).map(([k, v]) => [k, v.shrink_fits])),
  metrics: table, bootstrap_vs_v1: boot, diagnostics: diag, selection_policy: policy, live,
};
const out = path.join(CACHE, 'v2_research.json');
fs.writeFileSync(out, JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(CACHE, 'v2_oof.json'), JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.scored.map((r) => [r.bout_id, r.fold_year, Number(r.p.toFixed(6)), r.y])]))));
log('wrote', out);
for (const [k, v] of Object.entries(table)) console.log(k.padEnd(22), JSON.stringify(Object.fromEntries(Object.entries(v.from_2015).map(([a, b]) => [a, typeof b === 'number' ? Number(b.toFixed(4)) : b]))));
