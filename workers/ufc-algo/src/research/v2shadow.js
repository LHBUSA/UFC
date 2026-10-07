// PBE Fight Model V2 research SHADOW (owner-approved 2026-10-07). Private, never official.
//
// Scores pbe-fight-model-v2-candidate-elo on exactly the bouts, rows and corners
// the champion (V1) evaluates in the same cycle, and writes ONLY to
// ufc_model_shadow_predictions (registered under a RESEARCH_SHADOW training-run
// row, which no learning, review or promotion code selects). It never reads or
// writes ufc_model_predictions / grades, the official record, /algo pages,
// public APIs, PBEcast or news; v2shadow.test.mjs enforces that.
//
// Two questions are recorded separately on every row (`policy`):
//   1. probability quality - V2 probability and V1 probability, frozen together
//   2. publication policy - would V1's >=55% rule, the frozen V2 >=60% primary
//      rule, and the pre-registered tier variant each publish this bout?
//
// Paired universe: every bout whose V1 evaluation passes every gate except the
// probability threshold (decision ELIGIBLE, or the single reason LOW_CONFIDENCE).
// Those rows lock in the same lock pass as V1, so a V2 probability below 55% is
// still frozen and graded; debut corners and every other V1 gate stay no-call.
//
// Market data is never a feature here; `market` is stored as benchmark context only.

import artifact from '../../../../scripts/model/v2/artifacts/pbe-fight-model-v2-candidate-elo.json';
import { predictOne } from '../../../../scripts/model/logistic.mjs';
import { round } from '../../../../scripts/model/features_core.mjs';
import { FEATURE_KEYS } from '../../../../scripts/model/feature_spec.mjs';
import { ladderInput, eloArtifactBody, eloDiff, sha256Hex, ELO_K, ELO_VERSION } from '../../../../scripts/model/v2/elo_core.mjs';
import { readAll } from '../learning/assemble.js';

export const V2_TABLE = 'ufc_model_shadow_predictions';
export const V2_STATUS = 'RESEARCH_SHADOW';
export const V2_TRACK = 'v2-research-shadow';
export const ELO_PREFIX = 'learning/elo/';

/* ------------------------------------------------------------ the model */

/** Rebuild the frozen spec exactly as freeze_candidate.mjs hashed it, and refuse a tampered artifact. */
export async function v2Spec(a = artifact) {
  const features = a.features;
  const spec = {
    model_version: a.model_version, feature_version: a.feature_version, base_feature_version: a.base_feature_version,
    features, coefficients: features.map((k) => a.coefficients[k]), scale: features.map((k) => a.feature_scale[k]),
    lambda: a.lambda, elo_k: a.elo_k, elo_rule: a.elo_rule,
  };
  const sha = await sha256Hex(JSON.stringify(spec));
  if (sha !== a.spec_sha256) throw new Error(`V2 artifact does not re-hash: ${sha.slice(0, 12)} != ${String(a.spec_sha256).slice(0, 12)}`);
  if (features.length !== FEATURE_KEYS.length + 1 || FEATURE_KEYS.some((k, i) => features[i] !== k) || features.at(-1) !== 'elo_diff') {
    throw new Error('V2 feature layout is not V1 + elo_diff');
  }
  if (a.elo_k !== ELO_K) throw new Error(`V2 artifact K ${a.elo_k} != production Elo K ${ELO_K}`);
  return { model_version: a.model_version, feature_version: a.feature_version, spec_sha256: sha, beta: spec.coefficients, scale: spec.scale, policy: a.selection_policy };
}

/* ---------------------------------------------------------- Elo source */

/** Production Elo inputs, read with stable paging (PostgREST caps a page at 1000 rows). */
async function readLadderInput(q) {
  const bouts = await readAll(q, 'ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id&model_scope=eq.true', 'id.asc');
  const events = await readAll(q, 'ufc_events?select=id,event_date', 'id.asc');
  const results = await readAll(q, 'ufc_bout_results?select=bout_id,winner_id,method', 'bout_id.asc');
  return ladderInput(bouts, new Map(events.map((e) => [e.id, e.event_date])), new Map(results.map((r) => [r.bout_id, r])));
}

/**
 * The Elo artifact for `asOf` (results dated strictly before it): read from R2 when it exists
 * (re-hashed against its recorded sha256), otherwise built once and stored. Never overwritten.
 */
export async function loadEloArtifact(q, bucket, asOf, { write = true } = {}) {
  const key = `${ELO_PREFIX}${asOf}.json`;
  const stored = bucket ? await bucket.get(key) : null;
  if (stored) {
    const text = await stored.text();
    const sha = await sha256Hex(text);
    if (stored.customMetadata?.sha256 && stored.customMetadata.sha256 !== sha) throw new Error(`Elo artifact ${key} does not re-hash`);
    return { key, sha256: sha, body: JSON.parse(text), source: 'r2' };
  }
  const body = eloArtifactBody(await readLadderInput(q), asOf, ELO_K);
  const text = JSON.stringify(body);
  const sha = await sha256Hex(text);
  if (write && bucket && !(await bucket.head(key))) {
    await bucket.put(key, text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: sha, version: ELO_VERSION, k: String(ELO_K) } });
  }
  return { key, sha256: sha, body, source: write && bucket ? 'built' : 'built_memory' };
}

/** The registered V2 track, or null when it is not registered (the cycle then reports and skips it). */
export async function loadV2Track(q, bucket, nowIso, { write = true } = {}) {
  const spec = await v2Spec();
  const [run] = await q.get(`ufc_model_training_runs?select=id,status,spec_sha256&status=eq.${V2_STATUS}&spec_sha256=eq.${spec.spec_sha256}&order=created_at.asc&limit=1`);
  if (!run) return { registered: false, spec };
  const elo = await loadEloArtifact(q, bucket, nowIso.slice(0, 10), { write });
  return { registered: true, run_id: run.id, spec, elo };
}

/* ---------------------------------------------------------- the call */

/** The frozen V2 policies on a pick probability (V2_RESEARCH.md section 6; never re-tuned). */
export function policyDecisions(policy, pickProbability, minPriorBouts, evaluable) {
  const tier = (policy.variant_tiers.tiers || []).find((t) => minPriorBouts >= t.min_prior_bouts && (t.max_prior_bouts == null || minPriorBouts <= t.max_prior_bouts));
  return {
    publish_v1_rule_55: Boolean(evaluable && pickProbability >= 0.55),
    publish_primary_60: Boolean(evaluable && pickProbability >= policy.primary.min_pick_probability),
    publish_variant_tiers: Boolean(evaluable && tier && pickProbability >= tier.min_pick_probability),
  };
}

/** Is the bout in the paired universe? Every V1 gate passes except, possibly, the 55% threshold. */
export const evaluable = (decision) => decision.decision === 'ELIGIBLE' || (decision.reasons.length === 1 && decision.reasons[0] === 'LOW_CONFIDENCE');

/**
 * V2's row for one bout. Pure. `v1` is V1's probability for canonical corner 1 from this cycle,
 * or the locked V1 call when one exists (so the pair always holds what V1 actually froze).
 */
export function v2Call({ track, row, bout, decision, v1, market }) {
  if (!row) return null;
  const elo = eloDiff(track.elo.body, row.fighter_1_id, row.fighter_2_id);
  /* Unrounded, exactly as the research dataset fed training (dataset_v2.withX); rounded only where stored. */
  const x = [...row.x, elo];
  const p1 = predictOne(x, track.spec.beta, track.spec.scale);
  const inUniverse = evaluable(decision);
  const pickV2 = p1 >= 0.5 ? row.fighter_1_id : row.fighter_2_id;
  const ppV2 = Math.max(p1, 1 - p1);
  const probAV2 = bout.fighter_a_id === row.fighter_1_id ? p1 : 1 - p1;
  const pickV1 = v1.p1 >= 0.5 ? row.fighter_1_id : row.fighter_2_id;
  const ppV1 = Math.max(v1.p1, 1 - v1.p1);
  const probAV1 = bout.fighter_a_id === row.fighter_1_id ? v1.p1 : 1 - v1.p1;
  const fiveRoundNonTitle = bout.scheduled_rounds === 5 && !bout.is_title;
  const policy = {
    track: V2_TRACK, selection_policy_version: track.spec.policy.version,
    evaluable: inUniverse,
    v1: { source: v1.source, prob_a: round(probAV1, 8), pick_fighter_id: pickV1, pick_probability: round(ppV1, 8), publish_v1_rule: decision.decision === 'ELIGIBLE' },
    v2: { prob_a: round(probAV2, 8), pick_fighter_id: pickV2, pick_probability: round(ppV2, 8), ...policyDecisions(track.spec.policy, ppV2, row.min_prior_bouts, inUniverse) },
    same_pick: pickV1 === pickV2,
    sample: { min_prior_bouts: row.min_prior_bouts, min_stat_bouts: row.min_stat_bouts, features_available: row.available_count },
    context: { scheduled_rounds: bout.scheduled_rounds ?? null, is_title: Boolean(bout.is_title), five_round_non_title: fiveRoundNonTitle },
    elo: { version: track.elo.body.version, as_of: track.elo.body.as_of, sha256: track.elo.sha256, elo_diff: round(elo, 6) },
    model: { model_version: track.spec.model_version, spec_sha256: track.spec.spec_sha256 },
  };
  return {
    decision: inUniverse ? 'ELIGIBLE' : 'NO_MODEL_CALL',
    reasons: decision.reasons,
    prob_a: inUniverse ? round(probAV2, 8) : null,
    pick_fighter_id: inUniverse ? pickV2 : null,
    pick_probability: inUniverse ? round(ppV2, 8) : null,
    feature_vector: { ...Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]])), elo_diff: round(elo, 6) },
    market: market ?? null,
    policy,
  };
}

/* ---------------------------------------------------------- the write */

/** Armed only: upsert the unlocked V2 row and lock it in V1's lock pass. Writes nothing but the shadow table and its lock RPC. */
export async function writeV2Shadow(q, { track, championVersion, eligibilityVersion, event, bout, call, existing, lockOpen, minLeadHours, generatedAt }) {
  const out = { inserted: 0, updated: 0, locked: 0, skipped_locked: 0 };
  if (existing?.locked_at) { out.skipped_locked = 1; return out; }
  const body = {
    decision: call.decision, reasons: call.reasons, confidence: null,
    prob_a: call.prob_a, pick_fighter_id: call.pick_fighter_id, pick_probability: call.pick_probability,
    feature_vector: call.feature_vector, market: call.market, policy: call.policy, generated_at: generatedAt, eligibility_version: eligibilityVersion,
  };
  let id = existing?.id || null;
  if (existing) {
    await q.patch(`${V2_TABLE}?id=eq.${existing.id}&locked_at=is.null`, body, 'return=minimal');
    out.updated = 1;
  } else {
    const [ins] = await q.post(`${V2_TABLE}?on_conflict=training_run_id,bout_id`, {
      ...body, training_run_id: track.run_id, challenger_spec_sha256: track.spec.spec_sha256, champion_model_version: championVersion,
      bout_id: bout.id, event_id: event.id, fighter_a_id: bout.fighter_a_id, fighter_b_id: bout.fighter_b_id,
    }, 'resolution=ignore-duplicates,return=representation');
    id = ins?.id || null;
    out.inserted = 1;
  }
  if (lockOpen && id && call.decision === 'ELIGIBLE') {
    await q.rpc('ufc_model_lock_shadow', { p_shadow_id: id, p_min_lead: `${minLeadHours} hours` });
    out.locked = 1;
  }
  return out;
}
