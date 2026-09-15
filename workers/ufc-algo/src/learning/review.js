// Weekly promotion review and the owner decision. The review is deterministic
// (core.reviewChallenger) and only ever writes a ufc_model_promotion_reviews
// row. Promotion itself is a separate, owner-token-only action that calls the
// ufc_model_promote() database function; nothing here promotes on its own.

import { FEATURE_KEYS } from '../../../../scripts/model/feature_spec.mjs';
import { resolveChampion } from '../champion.js';
import { REVIEW_VERSION, reviewChallenger, sha256Hex, specCanonical } from './core.js';
import { activeChallenger, loadDataset } from './daily.js';

/** Monday (UTC) of the week containing `now`. */
export function weekStart(now) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Paired graded WIN/LOSS calls: challenger shadow lock vs champion official lock on the same bout. */
export async function shadowPairs(q, challengerRunId, championVersion) {
  const shadows = await q.get(`ufc_model_shadow_predictions?select=id,bout_id,pick_probability&training_run_id=eq.${challengerRunId}&locked_at=not.is.null&limit=1000`);
  if (!shadows.length) return [];
  const sg = new Map((await q.inChunks('ufc_model_shadow_current_grade', 'shadow_prediction_id', shadows.map((s) => s.id), 'shadow_prediction_id,result')).map((g) => [g.shadow_prediction_id, g.result]));
  const champs = await q.inChunks('ufc_model_predictions', 'bout_id', shadows.map((s) => s.bout_id), 'id,bout_id,pick_probability', `&model_version=eq.${championVersion}&locked_at=not.is.null`);
  const cg = new Map((champs.length ? await q.inChunks('ufc_model_prediction_current_grade', 'prediction_id', champs.map((c) => c.id), 'prediction_id,result') : []).map((g) => [g.prediction_id, g.result]));
  const champByBout = new Map(champs.map((c) => [c.bout_id, c]));
  return shadows.filter((s) => champByBout.has(s.bout_id)).map((s) => {
    const c = champByBout.get(s.bout_id);
    return { bout_id: s.bout_id, shadow: { p_pick: Number(s.pick_probability), result: sg.get(s.id) ?? null }, champion: { p_pick: Number(c.pick_probability), result: cg.get(c.id) ?? null } };
  });
}

export async function runReview({ q, bucket, now = Date.now() }) {
  const champion = await resolveChampion(q);
  if (!champion.live) throw new Error(`no live champion: ${champion.blocked}`);
  const week = weekStart(now);
  const challenger = await activeChallenger(q, champion.model_version);
  const cid = challenger?.id ?? null;
  const [existing] = await q.get(`ufc_model_promotion_reviews?select=id,verdict,reasons,created_at&week_start=eq.${week}&champion_model_version=eq.${champion.model_version}&challenger_run_id=${cid ? `eq.${cid}` : 'is.null'}&limit=1`);
  if (existing) return { review: existing, created: false };

  let result;
  if (!challenger) result = reviewChallenger({ run: null });
  else {
    let dataIntegrityOk = true;
    const integrity = [];
    try { await loadDataset(bucket, challenger.dataset_uri, challenger.dataset_sha256); integrity.push('dataset re-hashes'); } catch (e) { dataIntegrityOk = false; integrity.push(String(e.message).slice(0, 200)); }
    const drift = await q.get(`ufc_model_training_runs?select=id,created_at&parent_model_version=eq.${champion.model_version}&status=eq.DATA_REPAIR_DRIFT&created_at=gt.${encodeURIComponent(challenger.created_at)}&limit=1`);
    if (drift.length) { dataIntegrityOk = false; integrity.push(`unresolved DATA_REPAIR_DRIFT run ${drift[0].id} is newer than the challenger`); }
    const pairs = await shadowPairs(q, challenger.id, champion.model_version);
    result = reviewChallenger({
      run: { ...challenger, sample_quality: challenger.sample_quality?.challenger },
      parentEvidence: { walk_forward: challenger.walk_forward?.baseline, calibration: challenger.calibration?.baseline, sample_quality: challenger.sample_quality?.baseline },
      shadowPairs: pairs, dataIntegrityOk,
    });
    result.criteria.integrity_notes = integrity;
  }
  const [review] = await q.post('ufc_model_promotion_reviews', {
    week_start: week, champion_model_version: champion.model_version, challenger_run_id: cid,
    review_version: REVIEW_VERSION, criteria: result.criteria, verdict: result.verdict, reasons: result.reasons,
  });
  return { review, created: true };
}

export const PROMOTED_VERSION_PATTERN = /^pbe-fight-model-v\d+\.\d+$/;

/**
 * The owner decision. APPROVED promotes through ufc_model_promote(), which
 * itself refuses anything but an approved PROPOSE review of a passing
 * challenger trained against the current champion.
 */
export async function ownerDecision(q, { reviewId, decision, modelVersion, note }) {
  if (!['APPROVED', 'DECLINED'].includes(decision)) return { status: 400, body: { error: 'decision must be APPROVED or DECLINED' } };
  const [review] = await q.get(`ufc_model_promotion_reviews?select=id,verdict,owner_decision,promoted_model_version,challenger_run_id,champion_model_version&id=eq.${reviewId}`);
  if (!review) return { status: 404, body: { error: 'review not found' } };
  if (review.verdict !== 'PROPOSE') return { status: 409, body: { error: `review verdict is ${review.verdict}; only PROPOSE can be decided` } };
  if (decision === 'DECLINED') {
    await q.patch(`ufc_model_promotion_reviews?id=eq.${reviewId}`, { owner_decision: 'DECLINED', owner_note: note ?? null }, 'return=minimal');
    return { status: 200, body: { review_id: reviewId, owner_decision: 'DECLINED' } };
  }
  if (!PROMOTED_VERSION_PATTERN.test(modelVersion || '')) return { status: 400, body: { error: 'model_version must look like pbe-fight-model-v1.1' } };
  const [run] = await q.get(`ufc_model_training_runs?select=id,feature_version,coefficients,feature_scale,hyperparameters&id=eq.${review.challenger_run_id}`);
  if (!run) return { status: 409, body: { error: 'review has no challenger run' } };
  const spec = await sha256Hex(specCanonical({
    model_version: modelVersion, feature_version: run.feature_version,
    beta: FEATURE_KEYS.map((k) => run.coefficients[k]), scale: FEATURE_KEYS.map((k) => run.feature_scale[k]), lambda: run.hyperparameters?.lambda,
  }));
  if (!review.owner_decision) await q.patch(`ufc_model_promotion_reviews?id=eq.${reviewId}`, { owner_decision: 'APPROVED', owner_note: note ?? null }, 'return=minimal');
  const promoted = await q.rpc('ufc_model_promote', { p_review_id: reviewId, p_model_version: modelVersion, p_spec_sha256: spec });
  const after = await resolveChampion(q);
  return { status: 200, body: { review_id: reviewId, promoted: Array.isArray(promoted) ? promoted[0]?.model_version : promoted?.model_version, spec_sha256: spec, champion_now: after.live ? after.model_version : null, champion_verified: after.live } };
}
