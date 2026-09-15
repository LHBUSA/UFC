-- Behavioural tests for migration 027. Run INSIDE a transaction that is always
-- rolled back (scripts/db/prove_027.ps1). Each expectation asserts the refusal
-- reason. The last statement raises 'ALLPASS n' on success.

do $$
declare
  fa uuid; fb uuid; ev uuid; bt uuid; bt_past uuid;
  run_ok uuid; run2 uuid; run_badaudit uuid;
  sp uuid; sp_rec public.ufc_model_shadow_predictions;
  pred uuid; locked_before timestamptz;
  rv_hold uuid; rv_prop uuid; rv_bad uuid;
  v public.ufc_model_versions;
  n int := 0; msg text;
  d date := (now() at time zone 'UTC')::date;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t027fa0000000001', 'T027 A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t027fb0000000002', 'T027 B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values ('t027ev0000000001', 'UFC T027', d + 10, 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url)
    values ('t027bt0000000001', ev, fa, fb, 1, 'announced', 'http://example.invalid/1') returning id into bt;

  insert into public.ufc_model_versions (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256, status)
    values ('t027-champ', 't027-family', 't027-features', 'ridge logistic', 'walk-forward', now(), '{"x":1}'::jsonb, '{"x":1}'::jsonb, 'c0ffee', 'live');

  -- T1 one live champion per family
  begin
    insert into public.ufc_model_versions (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256, status)
      values ('t027-second-live', 't027-family', 't027-features', 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 'x', 'live');
    raise exception 'FAIL T1 second live champion accepted';
  exception when unique_violation then n := n + 1; end;

  -- T2 a CHALLENGER without provenance is refused
  begin
    insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, feature_version, eligibility_version, code_sha)
      values (d, 'admin', 'CHALLENGER', 't027-champ', now(), 't027-features', 'e', 'code1');
    raise exception 'FAIL T2 bare challenger accepted';
  exception when check_violation then n := n + 1; end;

  insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, training_window_start, training_window_end, training_bouts,
      newly_graded_bouts, dataset_sha256, dataset_uri, feature_version, eligibility_version, code_sha, coefficients, feature_scale, hyperparameters, spec_sha256, leakage_audit, walk_forward)
    values (d, 'admin', 'CHALLENGER', 't027-champ', now(), d - 1000, d - 1, 9000, 12, 'ds1', 'r2://x/ds1', 't027-features', 'e', 'code1',
      '{"x":2}'::jsonb, '{"x":1}'::jsonb, '{"lambda":2}'::jsonb, 'spec-ch', '{"all_passed":true}'::jsonb, '{"n":1}'::jsonb) returning id into run_ok;

  -- T3 identical parent + dataset + code cannot create a divergent second run
  begin
    insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, training_bouts, dataset_sha256, dataset_uri, feature_version, eligibility_version, code_sha,
        coefficients, feature_scale, hyperparameters, spec_sha256, leakage_audit, walk_forward)
      values (d, 'cron', 'CHALLENGER', 't027-champ', now(), 9000, 'ds1', 'r2://x/ds1', 't027-features', 'e', 'code1', '{"x":3}'::jsonb, '{"x":1}'::jsonb, '{}'::jsonb, 'other', '{"all_passed":true}'::jsonb, '{}'::jsonb);
    raise exception 'FAIL T3 duplicate identity accepted';
  exception when unique_violation then n := n + 1; end;

  -- T4 one NO_NEW_TRAINING_DATA per parent per day, and it carries no dataset
  insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, feature_version, eligibility_version, code_sha)
    values (d + 1, 'cron', 'NO_NEW_TRAINING_DATA', 't027-champ', now(), 't027-features', 'e', 'code1');
  begin
    insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, feature_version, eligibility_version, code_sha)
      values (d + 1, 'cron', 'NO_NEW_TRAINING_DATA', 't027-champ', now(), 't027-features', 'e', 'code1');
    raise exception 'FAIL T4 duplicate no-data day accepted';
  exception when unique_violation then n := n + 1; end;
  begin
    insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, feature_version, eligibility_version, code_sha, dataset_sha256)
      values (d + 2, 'cron', 'NO_NEW_TRAINING_DATA', 't027-champ', now(), 't027-features', 'e', 'code1', 'fake');
    raise exception 'FAIL T4b no-data run with dataset accepted';
  exception when check_violation then n := n + 1; end;

  -- T5 training runs are immutable; only superseded_at may be set once
  begin
    update public.ufc_model_training_runs set coefficients = '{"x":99}'::jsonb where id = run_ok;
    raise exception 'FAIL T5 coefficients edited';
  exception when restrict_violation then n := n + 1; end;
  begin
    delete from public.ufc_model_training_runs where id = run_ok;
    raise exception 'FAIL T5b run deleted';
  exception when restrict_violation then n := n + 1; end;
  insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, training_bouts, dataset_sha256, dataset_uri, feature_version, eligibility_version, code_sha,
      coefficients, feature_scale, hyperparameters, spec_sha256, leakage_audit, walk_forward)
    values (d, 'cron', 'CHALLENGER', 't027-champ', now(), 9001, 'ds2', 'r2://x/ds2', 't027-features', 'e', 'code1', '{"x":2}'::jsonb, '{"x":1}'::jsonb, '{}'::jsonb, 'spec2', '{"all_passed":true}'::jsonb, '{}'::jsonb) returning id into run2;
  update public.ufc_model_training_runs set superseded_at = now() where id = run2;
  n := n + 1;
  begin
    update public.ufc_model_training_runs set superseded_at = now() + interval '1 day' where id = run2;
    raise exception 'FAIL T5c superseded twice';
  exception when restrict_violation then n := n + 1; end;

  -- T6 shadow predictions: cannot be inserted locked, cannot be locked directly, lock only via function
  begin
    insert into public.ufc_model_shadow_predictions (training_run_id, challenger_spec_sha256, champion_model_version, bout_id, event_id, fighter_a_id, fighter_b_id, eligibility_version, decision, prob_a, pick_fighter_id, pick_probability, generated_at, locked_at)
      values (run_ok, 'spec-ch', 't027-champ', bt, ev, fa, fb, 'e', 'ELIGIBLE', 0.61, fa, 0.61, now() - interval '1 minute', now());
    raise exception 'FAIL T6 inserted locked';
  exception when restrict_violation then n := n + 1; end;
  insert into public.ufc_model_shadow_predictions (training_run_id, challenger_spec_sha256, champion_model_version, bout_id, event_id, fighter_a_id, fighter_b_id, eligibility_version, decision, prob_a, pick_fighter_id, pick_probability, confidence, generated_at)
    values (run_ok, 'spec-ch', 't027-champ', bt, ev, fa, fb, 'e', 'ELIGIBLE', 0.61, fa, 0.61, 'MEDIUM', now() - interval '1 minute') returning id into sp;
  begin
    update public.ufc_model_shadow_predictions set locked_at = now() where id = sp;
    raise exception 'FAIL T6b direct lock';
  exception when restrict_violation then n := n + 1; end;
  sp_rec := public.ufc_model_lock_shadow(sp, interval '6 hours');
  if sp_rec.locked_at is null then raise exception 'FAIL T6c lock function did not lock'; end if;
  n := n + 1;
  begin
    update public.ufc_model_shadow_predictions set pick_probability = 0.9 where id = sp;
    raise exception 'FAIL T6d locked shadow edited';
  exception when restrict_violation then n := n + 1; end;
  begin
    delete from public.ufc_model_shadow_predictions where id = sp;
    raise exception 'FAIL T6e locked shadow deleted';
  exception when restrict_violation then n := n + 1; end;

  -- T7 shadow grades bound to a stored result and append-only
  begin
    insert into public.ufc_model_shadow_grades (shadow_prediction_id, result, winner_id) values (sp, 'WIN', fa);
    raise exception 'FAIL T7 graded without a result';
  exception when restrict_violation then n := n + 1; end;
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, source_url) values (bt, fb, 'DEC_U', 'Decision - Unanimous', 'http://example.invalid/r');
  begin
    insert into public.ufc_model_shadow_grades (shadow_prediction_id, result, winner_id) values (sp, 'WIN', fb);
    raise exception 'FAIL T7b WIN contradicting the pick accepted';
  exception when check_violation then n := n + 1; end;
  insert into public.ufc_model_shadow_grades (shadow_prediction_id, result, winner_id) values (sp, 'LOSS', fb);
  n := n + 1;
  begin
    update public.ufc_model_shadow_grades set result = 'WIN' where shadow_prediction_id = sp;
    raise exception 'FAIL T7c shadow grade edited';
  exception when restrict_violation then n := n + 1; end;

  -- T8 reviews: evidence immutable, owner decision only on PROPOSE and only once
  insert into public.ufc_model_promotion_reviews (week_start, champion_model_version, challenger_run_id, review_version, criteria, verdict, reasons)
    values (d, 't027-champ', run_ok, 'r1', '{"a":1}'::jsonb, 'HOLD', array['insufficient shadow evidence']) returning id into rv_hold;
  begin
    update public.ufc_model_promotion_reviews set verdict = 'PROPOSE' where id = rv_hold;
    raise exception 'FAIL T8 verdict rewritten';
  exception when restrict_violation then n := n + 1; end;
  begin
    update public.ufc_model_promotion_reviews set owner_decision = 'APPROVED' where id = rv_hold;
    raise exception 'FAIL T8b approval of a HOLD accepted';
  exception when check_violation then n := n + 1; end;
  begin
    perform public.ufc_model_promote(rv_hold, 't027-v1.1', 'spec-new');
    raise exception 'FAIL T8c HOLD promoted';
  exception when restrict_violation then n := n + 1; end;

  insert into public.ufc_model_promotion_reviews (week_start, champion_model_version, challenger_run_id, review_version, criteria, verdict, reasons)
    values (d + 7, 't027-champ', run_ok, 'r1', '{"a":2}'::jsonb, 'PROPOSE', array['all criteria passed']) returning id into rv_prop;

  -- T9 no automatic promotion: PROPOSE without owner approval is refused
  begin
    perform public.ufc_model_promote(rv_prop, 't027-v1.1', 'spec-new');
    raise exception 'FAIL T9 promoted without owner approval';
  exception when restrict_violation then n := n + 1; end;

  -- T10 a failed leakage audit can never be promoted
  insert into public.ufc_model_training_runs (run_date, trigger, status, parent_model_version, training_cutoff_at, training_bouts, dataset_sha256, dataset_uri, feature_version, eligibility_version, code_sha,
      coefficients, feature_scale, hyperparameters, spec_sha256, leakage_audit, walk_forward)
    values (d, 'cron', 'CHALLENGER', 't027-champ', now(), 9002, 'ds3', 'r2://x/ds3', 't027-features', 'e', 'code1', '{"x":2}'::jsonb, '{"x":1}'::jsonb, '{}'::jsonb, 'spec3', '{"all_passed":false}'::jsonb, '{}'::jsonb) returning id into run_badaudit;
  insert into public.ufc_model_promotion_reviews (week_start, champion_model_version, challenger_run_id, review_version, criteria, verdict, reasons, owner_decision)
    values (d + 14, 't027-champ', run_badaudit, 'r1', '{}'::jsonb, 'PROPOSE', array['x'], 'APPROVED') returning id into rv_bad;
  begin
    perform public.ufc_model_promote(rv_bad, 't027-bad', 'spec-bad');
    raise exception 'FAIL T10 failed-audit challenger promoted';
  exception when restrict_violation then n := n + 1; end;

  -- T11 a locked champion prediction exists before promotion
  insert into public.ufc_model_predictions (bout_id, event_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, generated_at)
    values (bt, ev, fa, fb, 't027-champ', 't027-features', 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb, now() - interval '1 minute') returning id into pred;
  perform public.ufc_model_publish_prediction(pred, interval '6 hours');
  select locked_at into locked_before from public.ufc_model_predictions where id = pred;

  -- T12 owner-approved promotion: old retired, new live, record unchanged
  update public.ufc_model_promotion_reviews set owner_decision = 'APPROVED', owner_note = 'test' where id = rv_prop;
  begin
    update public.ufc_model_promotion_reviews set promoted_model_version = 't027-champ' where id = rv_prop;
    raise exception 'FAIL T12a promoted_model_version set directly';
  exception when restrict_violation then n := n + 1; end;
  v := public.ufc_model_promote(rv_prop, 't027-v1.1', 'spec-new');
  if v.status <> 'live' or v.model_version <> 't027-v1.1' then raise exception 'FAIL T12 new version not live'; end if;
  if (select status from public.ufc_model_versions where model_version = 't027-champ') <> 'retired' then raise exception 'FAIL T12b old champion not retired'; end if;
  if (select count(*) from public.ufc_model_versions where model_family = 't027-family' and status = 'live') <> 1 then raise exception 'FAIL T12c not exactly one live'; end if;
  if (select model_version from public.ufc_model_predictions where id = pred) <> 't027-champ'
     or (select locked_at from public.ufc_model_predictions where id = pred) <> locked_before then
    raise exception 'FAIL T12d locked call moved or changed';
  end if;
  if (select v2.status from public.ufc_model_predictions p join public.ufc_model_versions v2 on v2.model_version = p.model_version where p.id = pred) <> 'retired' then
    raise exception 'FAIL T12e historical call does not resolve through its retired version';
  end if;
  n := n + 5;
  begin
    update public.ufc_model_predictions set model_version = 't027-v1.1' where id = pred;
    raise exception 'FAIL T12f locked call re-pointed to the new version';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'FAIL%' then raise; end if;
    n := n + 1;
  end;
  begin
    perform public.ufc_model_promote(rv_prop, 't027-v1.2', 'spec-again');
    raise exception 'FAIL T13 review promoted twice';
  exception when restrict_violation then n := n + 1; end;

  -- T14 nothing is readable by anon/authenticated
  if has_table_privilege('anon', 'public.ufc_model_training_runs', 'select')
     or has_table_privilege('authenticated', 'public.ufc_model_shadow_predictions', 'select')
     or has_table_privilege('anon', 'public.ufc_model_promotion_reviews', 'select')
     or has_function_privilege('anon', 'public.ufc_model_promote(uuid, text, text)', 'execute') then
    raise exception 'FAIL T14 public privilege present';
  end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end;
$$;
