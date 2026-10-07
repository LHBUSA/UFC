#!/usr/bin/env node
// Freeze the selected V2 candidate as an immutable research artifact.
//
//   PBE_MODEL_CACHE=<clean extract> node scripts/model/v2/freeze_candidate.mjs --cutoff 2026-10-07
//
// Trains the selected recipe (V1's 33 features + one point-in-time Elo difference,
// the unchanged V1 fitFold recipe) on every graded bout dated before
// --cutoff, and writes scripts/model/v2/artifacts/<version>.json with the dataset,
// spec and code hashes and the frozen selection policy. It does not register,
// deploy or publish anything. A SHADOW deployment needs owner approval naming
// the ufc-algo Worker (UFC Workers are frozen).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDir } from '../common.mjs';
import { FEATURE_VERSION } from '../feature_spec.mjs';
import { fitFold, trainingOrder } from '../walkforward_core.mjs';
import { loadV2 } from './dataset_v2.mjs';

export const V2_SET = 'c2elo';
export const V2_MODEL_VERSION = 'pbe-fight-model-v2-candidate-elo';
export const V2_FEATURE_VERSION = 'pbe-fight-features-v2-elo';
/* Selection policy frozen from the 2015-2021 tuning folds (V2_RESEARCH.md section 6); never re-tuned on live calls.
 * PRIMARY is one uniform cutoff: the tuned sample-aware tiers came out non-monotone (62.5 / 65 / 60) and under the
 * coverage floor on the holdout, the signature of noise-fitting. They are recorded as a second pre-registered
 * variant so the shadow can test both prospectively. */
export const V2_SELECTION_POLICY = Object.freeze({
  version: 'pbe-algo-selection-v2-candidate',
  debut_corner: 'no_call',
  min_features_available: 20,
  primary: Object.freeze({ rule: 'uniform', min_pick_probability: 0.60 }),
  variant_tiers: Object.freeze({ rule: 'by_min_prior_bouts', tiers: Object.freeze([
    Object.freeze({ min_prior_bouts: 1, max_prior_bouts: 2, min_pick_probability: 0.625 }),
    Object.freeze({ min_prior_bouts: 3, max_prior_bouts: 5, min_pick_probability: 0.65 }),
    Object.freeze({ min_prior_bouts: 6, max_prior_bouts: null, min_pick_probability: 0.60 }),
  ]) }),
  tuned_on: 'walk-forward folds 2015-2021; objective = Wilson lower bound of published hit rate with >= 35% coverage',
})

const argv = process.argv.slice(2);
const cutoff = argv[argv.indexOf('--cutoff') + 1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff || '')) throw new Error('--cutoff YYYY-MM-DD required');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const { dataset, withX, KEYS, eloChoice, popMeans } = await loadV2(cacheDir());
const train = dataset.filter((r) => r.graded && r.event_date < cutoff).sort(trainingOrder).map((r) => withX(r, V2_SET));
const datasetSha = sha(train.map((r) => JSON.stringify([r.bout_id, r.event_date, r.label, r.x])).join('\n'));
const fit = fitFold(train);
const keys = KEYS[V2_SET];
const spec = { model_version: V2_MODEL_VERSION, feature_version: V2_FEATURE_VERSION, base_feature_version: FEATURE_VERSION, features: keys, coefficients: fit.beta, scale: fit.scale, lambda: fit.lambda, elo_k: eloChoice.k, elo_rule: 'start 1500; K*(1+2/(n+1)) per corner; date-block reads before updates; draws 0.5; NC skipped; elo_diff = (r1-r2)/100' };
const specSha = sha(JSON.stringify(spec));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let codeSha = 'unknown';
try { codeSha = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a checkout */ }

const artifact = {
  status: 'FROZEN_RESEARCH_CANDIDATE - not registered, not deployed, not published',
  ...spec,
  coefficients: Object.fromEntries(keys.map((k, i) => [k, fit.beta[i]])),
  feature_scale: Object.fromEntries(keys.map((k, i) => [k, fit.scale[i]])),
  lambda_scan: fit.lambdaScan, converged: fit.converged,
  training: { cutoff_exclusive: cutoff, bouts: train.length, window_start: train[0].event_date, window_end: train.at(-1).event_date, dataset_sha256: datasetSha },
  selection_policy: V2_SELECTION_POLICY,
  spec_sha256: specSha,
  code_sha: codeSha,
  generated_at: new Date().toISOString(),
};
const dir = path.join(ROOT, 'scripts', 'model', 'v2', 'artifacts');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${V2_MODEL_VERSION}.json`);
fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ file, bouts: train.length, lambda: fit.lambda, elo_k: eloChoice.k, spec_sha256: specSha, dataset_sha256: datasetSha, artifact_sha256: sha(fs.readFileSync(file)) }, null, 1));
