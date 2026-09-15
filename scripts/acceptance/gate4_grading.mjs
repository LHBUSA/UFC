// Gate 4: first grading lifecycle (UFC 331, 2026-09-19). READ-ONLY.
//
//   node scripts/acceptance/gate4_grading.mjs
//
// Result ingestion, one deterministic grade per locked call, no duplicate grade,
// append-only correction handling, learning eligibility per the frozen contract.
// Never retrain or promote because new data exists.

import { get, count, inChunks, sha256, print, V1, UFC331 } from './lib.mjs';

const failures = [];
const need = (ok, msg) => { if (!ok) failures.push(msg); };

const event = (await get(`ufc_events?select=id,name,event_date,card_status,event_series&id=eq.${UFC331.event_id}`))[0];
const bouts = await get(`ufc_bouts?select=id,status,model_scope,fighter_a_id,fighter_b_id,ufc_bout_results(winner_id,method,round,time_sec,result_source,captured_at,source_url)&event_id=eq.${UFC331.event_id}`);
const locked = await get(`ufc_model_predictions?select=id,bout_id,pick_fighter_id,fighter_a_id,fighter_b_id,locked_at,model_version&event_id=eq.${UFC331.event_id}&locked_at=not.is.null`);
const grades = locked.length ? await inChunks('ufc_model_prediction_grades', 'prediction_id', locked.map((p) => p.id), 'prediction_id,revision,result,winner_id,method,source,graded_by,graded_at,revision_reason') : [];

const expectedGrade = (p, r, b) => {
  if (r) {
    if (r.method === 'NC') return 'NC';
    if (r.method === 'DRAW') return 'DRAW';
    if (!r.winner_id) return null;
    return r.winner_id === p.pick_fighter_id ? 'WIN' : 'LOSS';
  }
  return ['cancelled', 'replaced'].includes(b?.status) || event.card_status === 'complete' ? 'VOID' : null;
};

const perCall = locked.map((p) => {
  const b = bouts.find((x) => x.id === p.bout_id);
  const r = Array.isArray(b?.ufc_bout_results) ? b.ufc_bout_results[0] : b?.ufc_bout_results;
  const gs = grades.filter((g) => g.prediction_id === p.id).sort((x, y) => x.revision - y.revision);
  const want = expectedGrade(p, r, b);
  const current = gs[gs.length - 1] || null;
  if (want) {
    need(gs.length >= 1, `locked ${p.id}: result ${want} available but no grade`);
    need(current?.result === want, `locked ${p.id}: current grade ${current?.result} != expected ${want}`);
    need(gs.filter((g) => g.revision === 1).length === 1, `locked ${p.id}: revision 1 count ${gs.filter((g) => g.revision === 1).length}`);
    need(gs.every((g, k) => k === 0 || (g.revision_reason && g.result !== gs[k - 1].result)), `locked ${p.id}: a later revision without a stated change`);
  }
  return { prediction_id: p.id, bout_id: p.bout_id, result_stored: r ? { method: r.method, winner_id: r.winner_id, round: r.round, time_sec: r.time_sec, source: r.result_source, captured_at: r.captured_at } : null, expected: want, grades: gs };
});

/* Frozen champion and no promotion */
const versions = await get('ufc_model_versions?select=*');
need(versions.length === 1 && versions[0].model_version === V1.model_version && versions[0].status === 'live' && sha256(JSON.stringify(versions[0])) === V1.full_row_sha256, 'champion registry row changed');
const reviews = await get('ufc_model_promotion_reviews?select=id,created_at,week_start,verdict,owner_decision,promoted_model_version');
need(reviews.every((r) => !r.owner_decision && !r.promoted_model_version), 'owner decision or promotion recorded');

/* Learning eligibility (frozen contract: docs/PBE_ALGO_LEARNING_DESIGN.md section 3.1) */
const training = await get('ufc_model_training_runs?select=id,created_at,run_date,trigger,status,parent_run_id,training_bouts,newly_graded_bouts,dataset_sha256,spec_sha256,superseded_at,gate,leakage_audit->all_passed&order=created_at.asc');
const after = training.filter((t) => t.run_date > UFC331.event_date);
for (const t of after) {
  if (t.status === 'CHALLENGER') need(t.all_passed === true, `training run ${t.id} CHALLENGER without a passing leakage audit`);
  need(!['CHALLENGER', 'DATA_REPAIR_DRIFT', 'FAILED_AUDIT'].includes(t.status) || (t.gate?.decision?.bout_ids || []).every((id) => bouts.find((b) => b.id === id)?.model_scope !== false), `training run ${t.id} includes an out-of-scope bout`);
}

const shadow = await get(`ufc_model_shadow_predictions?select=id,bout_id,locked_at,training_run_id&event_id=eq.${UFC331.event_id}&locked_at=not.is.null`);
const shadowGrades = shadow.length ? await inChunks('ufc_model_shadow_grades', 'shadow_prediction_id', shadow.map((s) => s.id), 'shadow_prediction_id,revision,result') : [];

print({
  GATE_4_GRADING: failures.length ? 'FAIL' : (perCall.every((c) => c.expected && c.grades.length) && perCall.length ? 'PASS' : 'PENDING (results or grades not all in yet)'),
  event,
  results: bouts.map((b) => ({ bout_id: b.id, status: b.status, model_scope: b.model_scope, result: Array.isArray(b.ufc_bout_results) ? b.ufc_bout_results[0] : b.ufc_bout_results })),
  locked_calls: perCall,
  guards: {
    grades_append_only: 'ufc_model_grades_append_only_trg (migration 011): grades are INSERT-only, bound to the stored result; a revision must state why',
    locked_rows_immutable: 'ufc_model_predictions_write_gate_trg + ufc_model_predictions_no_delete_trg (migration 011)',
  },
  official_record: await get(`ufc_model_live_record?select=*&model_version=eq.${V1.model_version}`),
  learning: { runs_after_event: after, all_runs: training.length, contract: 'LearnDaily may create at most one CHALLENGER from graded model_scope bouts dated before its run date; never a model version; promotion only via owner-approved review' },
  promotion_reviews: reviews,
  shadow: { locked: shadow.length, graded: shadowGrades.length },
  locked_predictions_total: await count('ufc_model_predictions', '&locked_at=not.is.null'),
  failures,
});
