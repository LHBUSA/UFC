// LearnDaily steps. Each function is one durable Workflow step: deterministic
// given the database, the parent dataset in R2 and the code, so a retried step
// produces the same artifact. None of them writes ufc_model_versions or any
// prediction: the only database writes are one ufc_model_training_runs row and
// the supersede stamp on the previous challenger.

import { FEATURE_KEYS, FEATURE_VERSION } from '../../../../scripts/model/feature_spec.mjs';
import { ELIGIBILITY_VERSION } from '../../../../scripts/model/eligibility.mjs';
import { resolveChampion } from '../champion.js';
import { readAll, assembleEvents } from './assemble.js';
import {
  CHALLENGER_LABEL, LEARNING_CODE_VERSION, specRound, canonicalDataset, coefficientDrift, datasetSha256, decideGate, fromJsonl,
  leakageAudit, mergeIncrement, predictionDrift, sha256Hex, specCanonical, toJsonl, trainChallenger,
} from './core.js';

export const BUCKET_NAME = 'ufc-algo-artifacts';
export const BENCHMARK_FROM = '2024-01-01';
const R2_PREFIX = `r2://${BUCKET_NAME}/`;
const dayMs = 86400e3;

export const r2Key = (uri) => {
  if (!String(uri || '').startsWith(R2_PREFIX)) throw new Error(`not an ${BUCKET_NAME} uri: ${uri}`);
  return uri.slice(R2_PREFIX.length);
};

export const codeSha = (env) => env.CODE_SHA || `${LEARNING_CODE_VERSION}+unknown-commit`;

/** Load a dataset from R2 and prove it is the dataset its hash names. */
export async function loadDataset(bucket, uri, sha) {
  const obj = await bucket.get(r2Key(uri));
  if (!obj) throw new Error(`dataset missing from R2: ${uri}`);
  const rows = fromJsonl(await obj.text());
  const got = await datasetSha256(rows);
  if (got !== sha) throw new Error(`dataset re-hash mismatch for ${uri}: ${got.slice(0, 12)} != ${String(sha).slice(0, 12)}`);
  return rows;
}

/** Store a dataset under its hash; an existing object with that hash is the same dataset and is kept. */
export async function putDataset(bucket, rows) {
  const sha = await datasetSha256(rows);
  const key = `learning/datasets/${sha}.jsonl`;
  if (!(await bucket.head(key))) await bucket.put(key, toJsonl(rows), { httpMetadata: { contentType: 'application/x-ndjson' }, customMetadata: { dataset_sha256: sha, rows: String(canonicalDataset(rows).length) } });
  return { sha, uri: `${R2_PREFIX}${key}` };
}

/** The dataset the champion was trained on: promotion provenance, or the configured genesis for the first registered version. */
export function championDataset(env, champion) {
  const prov = champion.row?.hyperparameters?.provenance;
  if (prov?.dataset_sha256 && prov?.dataset_uri) return { sha: prov.dataset_sha256, uri: prov.dataset_uri, source: 'promotion provenance' };
  if (champion.model_version === env.GENESIS_MODEL_VERSION && env.GENESIS_DATASET_SHA256 && env.GENESIS_DATASET_URI) {
    return { sha: env.GENESIS_DATASET_SHA256, uri: env.GENESIS_DATASET_URI, source: 'genesis (release-window rebuild; V1 original dataset not reproducible)' };
  }
  return null;
}

/** Parent dataset: the newest run of this champion that produced a trainable dataset, else the champion's own. */
export async function parentLineage(q, env, champion) {
  const [run] = await q.get(`ufc_model_training_runs?select=id,status,dataset_sha256,dataset_uri,created_at&parent_model_version=eq.${champion.model_version}&status=in.(CHALLENGER,DATA_REPAIR_DRIFT)&order=created_at.desc&limit=1`);
  if (run) return { run_id: run.id, sha: run.dataset_sha256, uri: run.dataset_uri, source: `training run ${run.status}` };
  const base = championDataset(env, champion);
  if (!base) throw new Error(`no dataset lineage for champion ${champion.model_version}`);
  return { run_id: null, ...base };
}

/* ------------------------------------------------------------------ gate */

export async function gateStep({ q, env, bucket, now = Date.now() }) {
  const champion = await resolveChampion(q);
  const runDate = new Date(now).toISOString().slice(0, 10);
  const base = { run_date: runDate, training_cutoff_at: `${runDate}T00:00:00Z` };
  if (!champion.live) return { ...base, champion: null, decision: { status: 'FAILED', reason: `no live champion: ${champion.blocked}` } };
  const lineage = await parentLineage(q, env, champion);
  const parentIds = new Set((await loadDataset(bucket, lineage.uri, lineage.sha)).map((r) => r.bout_id));

  const windowEnd = champion.row.training_window_end;
  const events = await readAll(q, `ufc_events?select=id,name,event_date&event_date=gt.${windowEnd}&event_date=lt.${runDate}`, 'event_date.asc,id.asc');
  const bouts = events.length ? await q.inChunks('ufc_bouts', 'event_id', events.map((e) => e.id), 'id,event_id,fighter_a_id,fighter_b_id') : [];
  const winners = new Set((bouts.length ? await q.inChunks('ufc_bout_results', 'bout_id', bouts.map((b) => b.id), 'bout_id,winner_id', '&winner_id=not.is.null') : []).map((r) => r.bout_id));
  const dateOf = new Map(events.map((e) => [e.id, e.event_date]));
  const fresh = bouts.filter((b) => winners.has(b.id) && !parentIds.has(b.id));
  const newBouts = fresh.map((b) => ({ bout_id: b.id, event_date: dateOf.get(b.event_id) }));

  const freshness = { statsIngestAt: null, missingSnapshots: [], missingFeatureRows: [], lockedUngraded: 0 };
  if (fresh.length) {
    const [ingest] = await q.get('ufc_ingest_runs?select=finished_at&worker=eq.ufc-stats-ingest&status=eq.success&order=started_at.desc&limit=1');
    freshness.statsIngestAt = ingest?.finished_at ?? null;
    for (const b of fresh) for (const f of [b.fighter_a_id, b.fighter_b_id]) {
      const [snap] = await q.get(`ufc_fighter_dna_snapshots?select=as_of_date&fighter_id=eq.${f}&definition_version=eq.1&as_of_date=gte.${dateOf.get(b.event_id)}&limit=1`);
      if (!snap) freshness.missingSnapshots.push(f);
    }
    const featureRows = await q.inChunks('ufc_fighter_bout_features', 'bout_id', fresh.map((b) => b.id), 'bout_id,fighter_id', '&feature_version=eq.1');
    freshness.missingFeatureRows = fresh.filter((b) => new Set(featureRows.filter((r) => r.bout_id === b.id).map((r) => r.fighter_id)).size < 2).map((b) => b.id);
    const locked = await q.inChunks('ufc_model_predictions', 'bout_id', fresh.map((b) => b.id), 'id', '&locked_at=not.is.null');
    const gradedIds = new Set((locked.length ? await q.inChunks('ufc_model_prediction_current_grade', 'prediction_id', locked.map((p) => p.id), 'prediction_id') : []).map((g) => g.prediction_id));
    freshness.lockedUngraded = locked.filter((p) => !gradedIds.has(p.id)).length;
  }

  const decision = decideGate({ cutoffDate: runDate, newBouts, freshness });
  const newEventIds = new Set(fresh.map((b) => b.event_id));
  return {
    ...base,
    champion: { model_version: champion.model_version, spec_sha256: champion.spec_sha256, training_window_end: windowEnd },
    parent: lineage,
    decision,
    freshness: { ...freshness, missingSnapshots: freshness.missingSnapshots.length, missingFeatureRows: freshness.missingFeatureRows.length },
    events: events.filter((e) => newEventIds.has(e.id)),
  };
}

/* --------------------------------------------------------------- dataset */

export async function datasetStep({ q, bucket, gate }) {
  const assembled = await assembleEvents(q, gate.events);
  const wanted = new Set(gate.decision.bout_ids);
  const newRows = assembled.rows.filter((r) => wanted.has(r.bout_id));
  const assembledIds = new Set(newRows.map((r) => r.bout_id));
  const parentRows = await loadDataset(bucket, gate.parent.uri, gate.parent.sha);
  const merged = mergeIncrement(parentRows, newRows);
  const stored = await putDataset(bucket, merged.rows);
  const integrity = assembled.integrity.filter((s) => wanted.has(s.bout_id) && s.snapshot);
  return {
    dataset_sha256: stored.sha, dataset_uri: stored.uri,
    training_bouts: merged.rows.length, added: merged.added,
    not_assembled: gate.decision.bout_ids.filter((id) => !assembledIds.has(id)),
    skipped: assembled.skipped.filter((s) => wanted.has(s.bout_id)),
    integrity,
  };
}

/* ---------------------------------------------------------------- rebuild */

/** Weekly full rebuild plan: every event before the cutoff, in shards small enough for one step's subrequest budget. */
export async function rebuildPlan({ q, runDate, shardSize = 12 }) {
  const events = await readAll(q, `ufc_events?select=id,name,event_date&event_date=lt.${runDate}`, 'event_date.asc,id.asc');
  const shards = [];
  for (let i = 0; i < events.length; i += shardSize) shards.push(events.slice(i, i + shardSize));
  return shards;
}

export async function rebuildShard({ q, bucket, runDate, index, events }) {
  const { rows, integrity, skipped } = await assembleEvents(q, events);
  const key = `learning/rebuilds/${runDate}/shard-${String(index).padStart(3, '0')}.jsonl`;
  await bucket.put(key, rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '', { httpMetadata: { contentType: 'application/x-ndjson' } });
  const bad = integrity.filter((s) => s.target_in_snapshot || s.snapshot_after_event);
  return { key, rows: rows.length, skipped: skipped.length, integrity_violations: bad.slice(0, 20), integrity_violation_count: bad.length };
}

/** Merge the shards, hash, and compare with the incremental dataset row by row. */
export async function rebuildCompare({ bucket, shardKeys, incremental }) {
  const rows = [];
  for (const key of shardKeys) rows.push(...fromJsonl(await (await bucket.get(key)).text()));
  const rebuilt = await putDataset(bucket, rows);
  const inc = await loadDataset(bucket, incremental.uri, incremental.sha);
  const a = new Map(inc.map((r) => [r.bout_id, JSON.stringify([r.event_date, r.label, r.x, r.available])]));
  const b = new Map(canonicalDataset(rows).map((r) => [r.bout_id, JSON.stringify([r.event_date, r.label, r.x, r.available])]));
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const changed = [...a.keys()].filter((id) => b.has(id) && a.get(id) !== b.get(id)).sort();
  return {
    rebuilt_sha256: rebuilt.sha, rebuilt_uri: rebuilt.uri, rebuilt_rows: b.size,
    incremental_sha256: incremental.sha, incremental_rows: a.size,
    drift: rebuilt.sha !== incremental.sha,
    added: added.length, removed: removed.length, changed: changed.length,
    bout_ids: { added: added.slice(0, 200), removed: removed.slice(0, 200), changed: changed.slice(0, 200) },
  };
}

/* ------------------------------------------------------------ train/audit */

export async function upcomingRows(q, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const until = new Date(now + 14 * dayMs).toISOString().slice(0, 10);
  const events = await q.get(`ufc_events?select=id,name,event_date&event_date=gte.${today}&event_date=lte.${until}&order=event_date.asc`);
  const rows = [];
  for (const e of events) rows.push(...(await assembleEvents(q, [e], { upcoming: true })).rows);
  return rows;
}

const pickSummary = (t) => ({ pooled: t.walk_forward.pooled, high_confidence_tail: t.walk_forward.high_confidence_tail });

export async function trainStep({ q, env, bucket, gate, dataset, drift = null, now = Date.now() }) {
  const champion = await resolveChampion(q);
  if (!champion.live || champion.model_version !== gate.champion.model_version || champion.spec_sha256 !== gate.champion.spec_sha256) {
    throw new Error('champion changed during the run; the next run trains against the new champion');
  }
  const rows = await loadDataset(bucket, dataset.dataset_uri, dataset.dataset_sha256);
  const trained = trainChallenger(rows);
  const audit = leakageAudit({ datasetRows: rows, trained, cutoffDate: gate.run_date, newRowIntegrity: dataset.integrity || [] });
  if (dataset.not_assembled?.length || dataset.skipped?.length) {
    audit.checks.push({ name: 'increment completeness', pass: false, detail: `${dataset.not_assembled.length} new bout(s) not assembled, ${dataset.skipped.length} skipped` });
    audit.all_passed = false;
  }
  const beta = trained.fit.beta.map(specRound);
  const scale = trained.fit.scale.map(specRound);
  const specSha = await sha256Hex(specCanonical({ model_version: CHALLENGER_LABEL, feature_version: FEATURE_VERSION, beta, scale, lambda: trained.fit.lambda }));

  /* Baseline: the same recipe on the champion's dataset, cached in R2 under that dataset's hash. */
  const champData = championDataset(env, champion) || gate.parent;
  const baselineKey = `learning/evidence/baseline-${champData.sha}-${LEARNING_CODE_VERSION}.json`;
  let baseline = null;
  const cached = await bucket.get(baselineKey);
  let champRows = null;
  if (cached) baseline = await cached.json();
  else {
    champRows = await loadDataset(bucket, champData.uri, champData.sha);
    const t = trainChallenger(champRows);
    baseline = { dataset_sha256: champData.sha, walk_forward: pickSummary(t), calibration: { ece: t.calibration.ece, slope: t.calibration.slope }, sample_quality: t.sample_quality };
    await bucket.put(baselineKey, JSON.stringify(baseline));
  }

  const championSpec = { beta: champion.beta, scale: champion.scale };
  const challengerSpec = { beta, scale };
  champRows ||= await loadDataset(bucket, champData.uri, champData.sha);
  const bench = champRows.filter((r) => r.event_date >= BENCHMARK_FROM);
  const benchmark = { ...predictionDrift(bench, championSpec, challengerSpec), benchmark_from: BENCHMARK_FROM, benchmark_dataset_sha256: await datasetSha256(bench) };
  champRows = null;
  const upcoming = await upcomingRows(q, now);
  const upcomingDrift = { ...predictionDrift(upcoming, championSpec, challengerSpec), as_of: new Date(now).toISOString() };

  const evidenceKey = `learning/evidence/run-${dataset.dataset_sha256}-${specSha}.json`;
  await bucket.put(evidenceKey, JSON.stringify({
    dataset_sha256: dataset.dataset_sha256, spec_sha256: specSha, code_sha: codeSha(env),
    lambda_scan: trained.fit.lambdaScan, folds: trained.walk_forward.folds, out_of_sample: trained._scored.map((r) => [r.bout_id, r.event_date, r.fold_year, r.p, r.y]),
  }));

  const status = !audit.all_passed ? 'FAILED_AUDIT' : drift?.drift ? 'DATA_REPAIR_DRIFT' : 'CHALLENGER';
  return {
    status,
    training_window_start: trained.training_window_start, training_window_end: trained.training_window_end, training_bouts: trained.training_bouts,
    coefficients: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, beta[i]])),
    feature_scale: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, scale[i]])),
    hyperparameters: { lambda: trained.fit.lambda, spec_decimals: 10, lambda_scan: trained.fit.lambdaScan, converged: trained.fit.converged, iterations: trained.fit.iterations, spec_label: CHALLENGER_LABEL, evidence_uri: `${R2_PREFIX}${evidenceKey}` },
    spec_sha256: specSha,
    leakage_audit: audit,
    walk_forward: { ...trained.walk_forward, baseline: baseline.walk_forward, baseline_dataset_sha256: baseline.dataset_sha256 },
    calibration: { ece: trained.calibration.ece, slope: trained.calibration.slope, bins: trained.calibration.bins, baseline: baseline.calibration },
    sample_quality: { challenger: trained.sample_quality, baseline: baseline.sample_quality },
    coefficient_drift: coefficientDrift(champion.beta, beta),
    benchmark_drift: benchmark,
    upcoming_drift: upcomingDrift,
  };
}

/* ------------------------------------------------------------------ store */

async function insertRun(q, row, findExisting) {
  const existing = await findExisting();
  if (existing) return { run: existing, created: false };
  try {
    const [run] = await q.post('ufc_model_training_runs', row);
    return { run, created: true };
  } catch (e) {
    if (!/23505|duplicate key/.test(String(e?.message))) throw e;
    const again = await findExisting();
    if (!again) throw e;
    return { run: again, created: false };
  }
}

const RUN_SUMMARY = 'id,created_at,run_date,status,parent_model_version,parent_run_id,dataset_sha256,spec_sha256,training_bouts,newly_graded_bouts,superseded_at';

export async function storeNoData({ q, env, gate, trigger, error = null }) {
  const parent = gate.champion?.model_version;
  if (!parent) return { run: null, created: false, reason: gate.decision.reason };
  const row = {
    run_date: gate.run_date, trigger, status: gate.decision.status, parent_model_version: parent, parent_run_id: gate.parent?.run_id ?? null,
    training_cutoff_at: gate.training_cutoff_at, newly_graded_bouts: gate.decision.newly_graded ?? 0,
    feature_version: FEATURE_VERSION, eligibility_version: ELIGIBILITY_VERSION, code_sha: codeSha(env), worker_version: env.CF_VERSION_METADATA?.id || null,
    gate: { decision: gate.decision, freshness: gate.freshness ?? null, parent: gate.parent ?? null }, error,
  };
  return insertRun(q, row, async () => (await q.get(`ufc_model_training_runs?select=${RUN_SUMMARY}&parent_model_version=eq.${parent}&run_date=eq.${gate.run_date}&dataset_sha256=is.null&limit=1`))[0] || null);
}

export async function storeTrained({ q, env, gate, dataset, trained, drift = null, trigger }) {
  const parent = gate.champion.model_version;
  const code = codeSha(env);
  const row = {
    run_date: gate.run_date, trigger, status: trained.status, parent_model_version: parent, parent_run_id: gate.parent.run_id,
    training_cutoff_at: gate.training_cutoff_at, training_window_start: trained.training_window_start, training_window_end: trained.training_window_end,
    training_bouts: trained.training_bouts, newly_graded_bouts: gate.decision.newly_graded ?? 0,
    dataset_sha256: dataset.dataset_sha256, dataset_uri: dataset.dataset_uri,
    feature_version: FEATURE_VERSION, eligibility_version: ELIGIBILITY_VERSION, code_sha: code, worker_version: env.CF_VERSION_METADATA?.id || null,
    coefficients: trained.coefficients, feature_scale: trained.feature_scale, hyperparameters: trained.hyperparameters, spec_sha256: trained.spec_sha256,
    leakage_audit: trained.leakage_audit, walk_forward: trained.walk_forward, calibration: trained.calibration, sample_quality: trained.sample_quality,
    coefficient_drift: trained.coefficient_drift, benchmark_drift: trained.benchmark_drift, upcoming_drift: trained.upcoming_drift,
    gate: { decision: gate.decision, freshness: gate.freshness, parent: gate.parent, increment: { added: dataset.added, not_assembled: dataset.not_assembled, skipped: dataset.skipped }, rebuild: drift },
  };
  const out = await insertRun(q, row, async () => (await q.get(`ufc_model_training_runs?select=${RUN_SUMMARY}&parent_model_version=eq.${parent}&dataset_sha256=eq.${dataset.dataset_sha256}&code_sha=eq.${encodeURIComponent(code)}&limit=1`))[0] || null);
  /* At most one active challenger: a newer passing run supersedes the previous one (its shadow record is kept). */
  if (out.created && out.run.status === 'CHALLENGER') {
    const older = await q.get(`ufc_model_training_runs?select=id&parent_model_version=eq.${parent}&status=eq.CHALLENGER&superseded_at=is.null&id=neq.${out.run.id}`);
    for (const o of older) await q.patch(`ufc_model_training_runs?id=eq.${o.id}&superseded_at=is.null`, { superseded_at: new Date().toISOString() }, 'return=minimal');
    out.superseded = older.map((o) => o.id);
  }
  return out;
}

/** The single active challenger of the current champion, if any. */
export async function activeChallenger(q, championVersion) {
  const [run] = await q.get(`ufc_model_training_runs?select=id,created_at,status,parent_model_version,dataset_sha256,dataset_uri,spec_sha256,coefficients,feature_scale,hyperparameters,leakage_audit,walk_forward,calibration,sample_quality,coefficient_drift,benchmark_drift,training_bouts,training_window_end&parent_model_version=eq.${championVersion}&status=eq.CHALLENGER&superseded_at=is.null&order=created_at.desc&limit=1`);
  if (!run || run.leakage_audit?.all_passed !== true) return null;
  const beta = FEATURE_KEYS.map((k) => run.coefficients?.[k]);
  const scale = FEATURE_KEYS.map((k) => run.feature_scale?.[k]);
  const spec = await sha256Hex(specCanonical({ model_version: CHALLENGER_LABEL, feature_version: FEATURE_VERSION, beta, scale, lambda: run.hyperparameters?.lambda }));
  if (spec !== run.spec_sha256) return null;
  return { ...run, beta, scale };
}
