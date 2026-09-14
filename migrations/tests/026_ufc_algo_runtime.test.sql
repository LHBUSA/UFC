-- Behavioural tests for migration 026. Built to run INSIDE a transaction that
-- is always rolled back (scripts/db/prove_026.ps1 wraps: BEGIN; 026; this; the
-- final statement raises, so nothing can commit). Every expectation asserts
-- the refusal REASON, so a test cannot pass because something unrelated broke.
-- The last line raises 'ALLPASS n' on success; any other error is a failure.

do $$
declare
  fa uuid; fb uuid; ev uuid; bout_done uuid; bout_vanish uuid; bout_open uuid; bout_cxl uuid;
  p_done uuid; p_vanish uuid; p_open uuid; p_cxl uuid; run uuid;
  n int := 0; msg text;
  utc_today date := (now() at time zone 'UTC')::date;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t026fa0000000001', 'T026 A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t026fb0000000002', 'T026 B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values ('t026ev0000000001', 'UFC T026', utc_today + 10, 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values
    ('t026bt0000000001', ev, fa, fb, 1, 'announced', 'http://example.invalid/1') returning id into bout_done;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values
    ('t026bt0000000002', ev, fa, fb, 2, 'announced', 'http://example.invalid/2') returning id into bout_vanish;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values
    ('t026bt0000000003', ev, fa, fb, 3, 'announced', 'http://example.invalid/3') returning id into bout_open;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values
    ('t026bt0000000004', ev, fa, fb, 4, 'announced', 'http://example.invalid/4') returning id into bout_cxl;
  insert into public.ufc_model_versions (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256)
    values ('t026-model', 'test', 't026-features', 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 'deadbeef');

  -- four locked picks on fa at 0.62
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
    values (bout_done, fa, fb, 't026-model', 't026-features', 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb) returning id into p_done;
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
    values (bout_vanish, fa, fb, 't026-model', 't026-features', 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb) returning id into p_vanish;
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
    values (bout_open, fa, fb, 't026-model', 't026-features', 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb) returning id into p_open;
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
    values (bout_cxl, fa, fb, 't026-model', 't026-features', 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb) returning id into p_cxl;
  perform public.ufc_model_publish_prediction(p_done, interval '6 hours');
  perform public.ufc_model_publish_prediction(p_vanish, interval '6 hours');
  perform public.ufc_model_publish_prediction(p_open, interval '6 hours');
  perform public.ufc_model_publish_prediction(p_cxl, interval '6 hours');
  n := n + 1;

  -- the fight happens: fb wins bout_done, event completes, bout_vanish left the card, bout_cxl is cancelled
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, source_url) values (bout_done, fb, 'KO_TKO', 'KO/TKO', 'http://example.invalid/r');
  update public.ufc_bouts set status = 'cancelled' where id = bout_cxl;

  -- T1 a grade must match the stored winner
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source) values (p_done, 'WIN', fa, 'test');
    raise exception 'FAIL T1: WIN naming the stored loser was allowed';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if position('stored result names' in msg) = 0 then raise exception 'FAIL T1 wrong reason: %', msg; end if;
    n := n + 1;
  end;
  -- T2 DRAW/NC must match the stored method
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, source) values (p_done, 'NC', 'test');
    raise exception 'FAIL T2: NC on a KO result was allowed';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if position('stored result method' in msg) = 0 then raise exception 'FAIL T2 wrong reason: %', msg; end if;
    n := n + 1;
  end;
  -- T3 VOID impossible with a result
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, source) values (p_done, 'VOID', 'test');
    raise exception 'FAIL T3: VOID with a stored result was allowed';
  exception when check_violation then n := n + 1;
  end;
  -- T4 the correct grade is accepted
  insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source) values (p_done, 'LOSS', fb, 'test');
  n := n + 1;
  -- T5 a revision must give a reason
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source) values (p_done, 'LOSS', fb, 'test');
    raise exception 'FAIL T5: reasonless revision allowed';
  exception when check_violation then n := n + 1;
  end;
  -- T6 no result, announced, event not complete: nothing to grade
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, source) values (p_vanish, 'VOID', 'test');
    raise exception 'FAIL T6: VOID before the event completed was allowed';
  exception when restrict_violation then
    get stacked diagnostics msg = message_text;
    if position('nothing to grade yet' in msg) = 0 then raise exception 'FAIL T6 wrong reason: %', msg; end if;
    n := n + 1;
  end;
  -- T7 cancelled bout: only VOID
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source) values (p_cxl, 'WIN', fa, 'test');
    raise exception 'FAIL T7: WIN on a cancelled bout allowed';
  exception when check_violation then n := n + 1;
  end;
  insert into public.ufc_model_prediction_grades (prediction_id, result, source) values (p_cxl, 'VOID', 'test');
  n := n + 1;
  -- T8 event completes: the vanished bout can be VOIDed, and only VOIDed
  update public.ufc_events set card_status = 'complete' where id = ev;
  begin
    insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source) values (p_vanish, 'WIN', fa, 'test');
    raise exception 'FAIL T8: WIN on a vanished bout allowed';
  exception when check_violation then n := n + 1;
  end;
  insert into public.ufc_model_prediction_grades (prediction_id, result, source) values (p_vanish, 'VOID', 'test');
  n := n + 1;
  -- T9 grades stay append-only
  begin
    update public.ufc_model_prediction_grades set result = 'WIN' where prediction_id = p_done;
    raise exception 'FAIL T9: grade update allowed';
  exception when restrict_violation then n := n + 1;
  end;
  -- T10 locked prediction still immutable
  begin
    update public.ufc_model_predictions set pick_probability = 0.99 where id = p_open;
    raise exception 'FAIL T10: locked prediction edit allowed';
  exception when restrict_violation then n := n + 1;
  end;

  -- T11 evaluation log: append-only, and an ineligible row cannot carry a pick
  insert into public.ufc_model_runs (trigger, mode) values ('admin', 'dry_run') returning id into run;
  insert into public.ufc_model_bout_evaluations (run_id, event_id, bout_id, model_version, feature_version, eligibility_version, decision, reasons)
    values (run, ev, bout_open, 't026-model', 't026-features', 'v1', 'NO_MODEL_CALL', array['DEBUT_CORNER']);
  begin
    insert into public.ufc_model_bout_evaluations (run_id, event_id, bout_id, model_version, feature_version, eligibility_version, decision, reasons, pick_fighter_id, pick_probability)
      values (run, ev, bout_open, 't026-model', 't026-features', 'v1', 'NO_MODEL_CALL', array['LOW_CONFIDENCE'], fa, 0.52);
    raise exception 'FAIL T11a: no-call row carrying a pick allowed';
  exception when check_violation then n := n + 1;
  end;
  begin
    insert into public.ufc_model_bout_evaluations (run_id, event_id, bout_id, model_version, feature_version, eligibility_version, decision, reasons)
      values (run, ev, bout_open, 't026-model', 't026-features', 'v1', 'NO_MODEL_CALL', '{}');
    raise exception 'FAIL T11b: no-call without a reason allowed';
  exception when check_violation then n := n + 1;
  end;
  begin
    update public.ufc_model_bout_evaluations set decision = 'ELIGIBLE' where run_id = run;
    raise exception 'FAIL T11c: evaluation update allowed';
  exception when restrict_violation then n := n + 1;
  end;
  begin
    delete from public.ufc_model_bout_evaluations where run_id = run;
    raise exception 'FAIL T11d: evaluation delete allowed';
  exception when restrict_violation then n := n + 1;
  end;
  if (select count(*) from public.ufc_model_card_current where bout_id = bout_open) <> 1 then raise exception 'FAIL T12: card view'; end if;
  n := n + 1;

  -- T13 TRUNCATE is gone for service_role
  if has_table_privilege('service_role', 'public.ufc_model_predictions', 'TRUNCATE')
     or has_table_privilege('service_role', 'public.ufc_model_prediction_grades', 'TRUNCATE')
     or has_table_privilege('service_role', 'public.ufc_model_versions', 'TRUNCATE') then
    raise exception 'FAIL T13: service_role still holds TRUNCATE on the record';
  end if;
  if has_table_privilege('anon', 'public.ufc_model_bout_evaluations', 'SELECT') then raise exception 'FAIL T13b: anon can read evaluations'; end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end $$;
