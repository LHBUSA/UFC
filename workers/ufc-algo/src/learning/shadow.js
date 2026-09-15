// Challenger shadow track. Scores the single active challenger on exactly the
// bouts, rows, corners and market the champion was evaluated on, and writes ONLY
// to ufc_model_shadow_predictions / ufc_model_shadow_grades. It never reads or
// writes ufc_model_predictions, so it cannot alter an official call; the
// import-graph test in learning.test.mjs keeps it that way.

import { evaluateBout } from '../../../../scripts/model/eligibility.mjs';
import { predictOne } from '../../../../scripts/model/logistic.mjs';
import { FEATURE_KEYS } from '../../../../scripts/model/feature_spec.mjs';
import { round } from '../../../../scripts/model/features_core.mjs';
import { marketComparison } from '../market.js';

export const SHADOW_TABLE = 'ufc_model_shadow_predictions';

/** The challenger's call for one bout, from the champion's inputs. Pure. */
export function shadowCall({ challenger, row, bout, event, corners, nowIso, marketSnapshots, marketObservations, boutState }) {
  let p1 = null, pickFighter = null, pickProbability = null, probA = null;
  if (row) {
    p1 = predictOne(row.x, challenger.beta, challenger.scale);
    pickFighter = p1 >= 0.5 ? row.fighter_1_id : row.fighter_2_id;
    pickProbability = Math.max(p1, 1 - p1);
    probA = bout.fighter_a_id === row.fighter_1_id ? p1 : 1 - p1;
  }
  const market = marketComparison({ snapshots: marketSnapshots, observations: marketObservations, pickFighterId: pickFighter, pickProbability, nowIso });
  const decision = evaluateBout({
    event, nowIso, row, corners, pickProbability, modelLive: true, bout: boutState,
    marketStatus: market?.status ?? 'UNAVAILABLE', marketDisagreementPts: market?.status === 'FRESH' ? Math.abs(market.pbe_delta_pts) : null, regenerationDriftPts: null,
  });
  const eligible = decision.decision === 'ELIGIBLE';
  return {
    decision: decision.decision, reasons: decision.reasons, confidence: eligible ? decision.confidence : null,
    prob_a: eligible ? round(probA, 8) : null, pick_fighter_id: eligible ? pickFighter : null, pick_probability: eligible ? round(pickProbability, 8) : null,
    raw_pick_fighter_id: pickFighter, raw_pick_probability: pickProbability == null ? null : round(pickProbability, 4),
    feature_vector: row ? Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]])) : null,
    market,
  };
}

/** Armed only: upsert the unlocked shadow row and lock it in the same window as the champion. */
export async function writeShadow(q, { challenger, championVersion, eligibilityVersion, event, bout, call, existing, lockOpen, minLeadHours, generatedAt }) {
  const out = { inserted: 0, updated: 0, locked: 0, skipped_locked: 0 };
  if (existing?.locked_at) { out.skipped_locked = 1; return out; }
  const body = {
    decision: call.decision, reasons: call.reasons, confidence: call.confidence,
    prob_a: call.prob_a, pick_fighter_id: call.pick_fighter_id, pick_probability: call.pick_probability,
    feature_vector: call.feature_vector, market: call.market, generated_at: generatedAt, eligibility_version: eligibilityVersion,
  };
  let id = existing?.id || null;
  if (existing) {
    await q.patch(`${SHADOW_TABLE}?id=eq.${existing.id}&locked_at=is.null`, body, 'return=minimal');
    out.updated = 1;
  } else {
    const [ins] = await q.post(`${SHADOW_TABLE}?on_conflict=training_run_id,bout_id`, {
      ...body, training_run_id: challenger.id, challenger_spec_sha256: challenger.spec_sha256, champion_model_version: championVersion,
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

/** Grade locked shadow calls with the official grading semantics (gradeFor is injected from cycle.js). */
export async function gradeShadow(q, gradeFor) {
  const locked = await q.get(`${SHADOW_TABLE}?select=id,bout_id,pick_fighter_id,fighter_a_id,fighter_b_id&locked_at=not.is.null&limit=1000`);
  if (!locked.length) return 0;
  const current = new Map((await q.inChunks('ufc_model_shadow_current_grade', 'shadow_prediction_id', locked.map((p) => p.id), 'shadow_prediction_id,result,winner_id')).map((g) => [g.shadow_prediction_id, g]));
  const results = new Map((await q.inChunks('ufc_bout_results', 'bout_id', locked.map((p) => p.bout_id), 'bout_id,winner_id,method')).map((r) => [r.bout_id, r]));
  const bouts = new Map((await q.inChunks('ufc_bouts', 'id', locked.map((p) => p.bout_id), 'id,status,ufc_events(card_status)')).map((b) => [b.id, { status: b.status, event_complete: b.ufc_events?.card_status === 'complete' }]));
  let n = 0;
  for (const p of locked) {
    const g = gradeFor(p, results.get(p.bout_id) || null, bouts.get(p.bout_id));
    if (!g) continue;
    const cur = current.get(p.id);
    if (cur && cur.result === g.result && (cur.winner_id || null) === (g.winner_id || null)) continue;
    await q.post('ufc_model_shadow_grades', { shadow_prediction_id: p.id, result: g.result, winner_id: g.winner_id, revision_reason: cur ? `stored result changed from ${cur.result} to ${g.result}` : null }, 'return=minimal');
    n += 1;
  }
  return n;
}
