// Register the PBE Algo release in ufc_model_versions.
//
//   node scripts/model/register_model.mjs                      dry run: build the row, re-hash, check the registry, write nothing
//   node scripts/model/register_model.mjs --apply --owner-approved
//                                                              insert the row with status 'live'
//
// Registration is the switch that makes the Algo callable: ufc-algo refuses to
// write anything in armed mode unless this row exists, is 'live', and its
// spec_sha256 re-hashes from its own coefficients. The row is immutable once
// inserted (011 trigger), so a wrong row can only be retired, never edited.
// Owner approval is required; the flag exists so it cannot happen by accident.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { rest, ROOT } from './common.mjs';
import { FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } from './feature_spec.mjs';

const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--owner-approved')) {
  console.error('refusing: --apply requires --owner-approved (registration makes PBE Algo callable)');
  process.exit(2);
}

const artifact = JSON.parse(fs.readFileSync(`${ROOT}/web/lib/generated/model-v1.json`, 'utf8'));
const m = artifact.model;
const fail = (msg) => { console.error(`BLOCKED: ${msg}`); process.exit(1); };

if (m.model_version !== MODEL_VERSION) fail(`artifact ${m.model_version} != feature_spec ${MODEL_VERSION}`);
if (m.feature_version !== FEATURE_VERSION) fail(`artifact ${m.feature_version} != feature_spec ${FEATURE_VERSION}`);
const keys = artifact.features.map((f) => f.key);
if (JSON.stringify(keys) !== JSON.stringify(FEATURE_KEYS)) fail('artifact feature order differs from feature_spec');
for (const k of FEATURE_KEYS) {
  if (!Number.isFinite(m.coefficients[k]) || !(m.feature_scale[k] > 0)) fail(`bad coefficient/scale for ${k}`);
}

// Byte-identical to the scheduler's verification in workers/ufc-algo/src/cycle.js.
const canonical = JSON.stringify({
  model_version: m.model_version, feature_version: m.feature_version, features: FEATURE_KEYS,
  coefficients: FEATURE_KEYS.map((k) => m.coefficients[k]), scale: FEATURE_KEYS.map((k) => m.feature_scale[k]),
  lambda: m.lambda,
});
const spec = crypto.createHash('sha256').update(canonical).digest('hex');
if (spec !== m.spec_sha256) fail(`spec_sha256 does not re-hash: ${spec} vs artifact ${m.spec_sha256}`);

const ev = artifact.evidence;

/* Provenance manifest (immutable copy in R2: ufc-algo-artifacts/model-releases/<version>/manifest.json,
 * bucket lock model-releases-immutable). Required for --apply so a registration can never be made
 * without its evidence; the manifest must describe exactly this artifact. */
const manifestPath = (() => { const i = process.argv.indexOf('--manifest'); return i >= 0 ? process.argv[i + 1] : null; })();
let manifest = null;
if (manifestPath) {
  const raw = fs.readFileSync(manifestPath);
  manifest = JSON.parse(raw);
  manifest.__sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const artSha = crypto.createHash('sha256').update(fs.readFileSync(`${ROOT}/web/lib/generated/model-v1.json`)).digest('hex');
  if (manifest.spec_sha256 !== spec) fail(`manifest spec ${manifest.spec_sha256} != artifact spec ${spec}`);
  if (manifest.artifact?.sha256 !== artSha) fail(`manifest artifact sha ${manifest.artifact?.sha256} != file sha ${artSha}`);
} else if (apply) {
  fail('--apply requires --manifest <provenance manifest.json>');
}
const row = {
  model_version: m.model_version,
  model_family: m.model_family,
  feature_version: m.feature_version,
  algorithm: m.algorithm,
  validation: m.validation,
  trained_at: artifact.generated_at,
  training_window_start: m.training_window_start,
  training_window_end: m.training_window_end,
  training_bouts: m.training_bouts,
  hyperparameters: {
    lambda: m.lambda, intercept: false, orientation: 'canonical corner = lexicographically smaller fighter UUID',
    provenance: manifest ? {
      manifest_r2: 'r2://ufc-algo-artifacts/model-releases/pbe-fight-model-v1/manifest.json',
      manifest_sha256: manifest.__sha256,
      artifact_r2: `r2://ufc-algo-artifacts/${manifest.artifact.r2_key}`,
      artifact_sha256: manifest.artifact.sha256,
      artifact_git_commit: manifest.artifact.git_commit_last_changed,
      parent_model_version: null,
      training_run_id: null,
    } : null,
  },
  coefficients: m.coefficients,
  feature_scale: m.feature_scale,
  spec_sha256: spec,
  release_metrics: {
    out_of_sample: ev.out_of_sample, model: ev.model, coin: ev.coin, winrate: ev.winrate,
    brier_skill_vs_coin: ev.brier_skill_vs_coin, brier_skill_vs_winrate: ev.brier_skill_vs_winrate,
    by_confidence_band: ev.by_confidence_band, market: ev.market,
    leakage_audit: artifact.leakage_audit,
    ...(manifest ? {
      training_cutoff: manifest.training.training_cutoff,
      reported_training_rows: manifest.training.reported_training_rows,
      original_dataset_sha256: manifest.training.original_dataset_sha256,
      reproducibility: manifest.training.reproducibility,
      forensic_audit: manifest.forensic_audit,
      node_worker_parity: manifest.node_worker_parity,
      current_rebuild_comparison: manifest.current_rebuild_comparison,
    } : {}),
  },
  methodology_ref: '/model',
  status: 'live',
  notes: 'PBE Algo v1, registered 2026-09-15 from the forensically audited artifact without retraining (owner decision). Eligibility pbe-algo-eligibility-v1. Registration does not arm the scheduler or activate official calls. The original 9,175-row training dataset cannot be regenerated byte-for-byte from the mutable database; see release_metrics.reproducibility and the R2 manifest.',
};

const db = rest();
const existing = await db.selectAll('ufc_model_versions', `select=model_version,status,spec_sha256&model_version=eq.${m.model_version}`);
console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry_run', model_version: row.model_version, feature_version: row.feature_version,
  spec_sha256: spec, rehash: 'ok', lambda: m.lambda, features: FEATURE_KEYS.length, training_bouts: row.training_bouts,
  trained_at: row.trained_at, registry_now: existing[0] || null,
}, null, 2));

if (existing[0]) {
  if (existing[0].spec_sha256 !== spec) fail('a DIFFERENT spec is already registered under this model_version; publish a new version instead');
  console.log(`already registered (status ${existing[0].status}); nothing to do`);
  process.exit(0);
}
if (!apply) { console.log('dry run: no row written. Re-run with --apply --owner-approved after approval.'); process.exit(0); }

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const res = await fetch(`${url}/rest/v1/ufc_model_versions`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(row),
});
if (!res.ok) fail(`insert failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
const [ins] = await res.json();
console.log(`registered ${ins.model_version} status=${ins.status} spec=${ins.spec_sha256}`);
