-- Behavioural tests for migration 030. Run INSIDE a transaction that is always
-- rolled back (scripts/db/prove_030.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  fa uuid; fb uuid; ev uuid; b1 uuid; b2 uuid; b3 uuid;
  p uuid; p_locked uuid; p_other uuid;
  champion text; feat text;
  g timestamptz;
  before_row public.ufc_model_predictions;
  after_row public.ufc_model_predictions;
  res jsonb;
  n int := 0;
  evals_before bigint; evals_after bigint;
  mk jsonb := '{"status":"FRESH","source":"snapshot","observed_at":"2026-09-15T18:57:09.217Z","devigged_pick":0.5,"pbe_delta_pts":1.5,"books":6}'::jsonb;
  utc_today date := (now() at time zone 'UTC')::date;
begin
  select model_version, feature_version into champion, feat from public.ufc_model_versions where status = 'live';
  if champion is null then raise exception 'FAIL setup: no live champion'; end if;

  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t030fa0000000001', 'T030 A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t030fb0000000002', 'T030 B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values ('t030ev0000000001', 'UFC T030', utc_today + 10, 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values ('t030bt0000000001', ev, fa, fb, 1, 'announced', 'http://example.invalid/1') returning id into b1;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values ('t030bt0000000002', ev, fa, fb, 2, 'announced', 'http://example.invalid/2') returning id into b2;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values ('t030bt0000000003', ev, fa, fb, 3, 'announced', 'http://example.invalid/3') returning id into b3;
  insert into public.ufc_model_versions (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256)
    values ('t030-candidate', 'test', feat, 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 't030');

  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, feature_availability, sample_context,
      market_implied_prob_pick, market_books, model_edge_pts, market_snapshot_at, generated_at)
    values (b1, fa, fb, champion, feat, 0.64397765, 0.35602235, fa, 0.64397765, '60-65', '{"x":1}'::jsonb, '{"x":true}'::jsonb,
      '{"confidence":"MEDIUM","market":{"status":"FRESH","observed_at":"2026-09-15T13:06:08.935Z","devigged_pick":0.5427,"pbe_delta_pts":10.12}}'::jsonb,
      0.5427, 6, 10.12, '2026-09-15T13:06:08.935Z', now() - interval '1 minute')
    returning id, generated_at into p, g;
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, sample_context)
    values (b2, fa, fb, champion, feat, 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb, '{"market":{"status":"FRESH","observed_at":"2026-09-15T13:06:08.935Z"}}'::jsonb) returning id into p_locked;
  insert into public.ufc_model_predictions (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version, prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, sample_context)
    values (b3, fa, fb, 't030-candidate', feat, 0.62, 0.38, fa, 0.62, '60-65', '{}'::jsonb, '{}'::jsonb) returning id into p_other;
  perform public.ufc_model_publish_prediction(p_locked, interval '6 hours');

  select * into before_row from public.ufc_model_predictions where id = p;
  select count(*) into evals_before from public.ufc_model_bout_evaluations;

  -- T1 refresh replaces only sample_context.market
  res := public.ufc_model_refresh_prediction_market(p, g, mk);
  if (res->>'refreshed')::boolean is not true then raise exception 'FAIL T1 refresh refused: %', res; end if;
  select * into after_row from public.ufc_model_predictions where id = p;
  if after_row.sample_context->'market' <> mk then raise exception 'FAIL T1 market not replaced'; end if;
  if after_row.sample_context->>'confidence' <> 'MEDIUM' then raise exception 'FAIL T1 sibling context lost'; end if;
  n := n + 1;

  -- T2 nothing else on the row changed (official columns, pick, probabilities, features, versions, generated_at, lock)
  if (after_row.prob_a, after_row.prob_b, after_row.pick_fighter_id, after_row.pick_probability, after_row.feature_vector, after_row.feature_availability,
      after_row.model_version, after_row.feature_version, after_row.generated_at, after_row.locked_at,
      after_row.market_implied_prob_pick, after_row.market_books, after_row.model_edge_pts, after_row.market_snapshot_at, after_row.confidence_band)
     is distinct from
     (before_row.prob_a, before_row.prob_b, before_row.pick_fighter_id, before_row.pick_probability, before_row.feature_vector, before_row.feature_availability,
      before_row.model_version, before_row.feature_version, before_row.generated_at, before_row.locked_at,
      before_row.market_implied_prob_pick, before_row.market_books, before_row.model_edge_pts, before_row.market_snapshot_at, before_row.confidence_band) then
    raise exception 'FAIL T2 a non-market column changed';
  end if;
  n := n + 1;

  -- T3 no evaluation row is created
  select count(*) into evals_after from public.ufc_model_bout_evaluations;
  if evals_after <> evals_before then raise exception 'FAIL T3 evaluation rows changed'; end if;
  n := n + 1;

  -- T4 never backwards: same or older observed_at is a no-op
  res := public.ufc_model_refresh_prediction_market(p, g, jsonb_set(mk, '{observed_at}', '"2026-09-15T13:06:08.935Z"'));
  if res->>'reason' <> 'not_newer' then raise exception 'FAIL T4 older market accepted: %', res; end if;
  n := n + 1;

  -- T5 a newer regeneration wins: wrong expected generated_at is a no-op
  res := public.ufc_model_refresh_prediction_market(p, g - interval '1 hour', jsonb_set(mk, '{observed_at}', '"2026-09-15T19:30:00Z"'));
  if res->>'reason' <> 'regenerated' then raise exception 'FAIL T5 stale regeneration accepted: %', res; end if;
  n := n + 1;

  -- T6 a locked prediction is refused and unchanged
  res := public.ufc_model_refresh_prediction_market(p_locked, (select generated_at from public.ufc_model_predictions where id = p_locked), mk);
  if res->>'reason' <> 'locked' then raise exception 'FAIL T6 locked row not refused: %', res; end if;
  if (select sample_context->'market'->>'observed_at' from public.ufc_model_predictions where id = p_locked) <> '2026-09-15T13:06:08.935Z' then raise exception 'FAIL T6 locked row changed'; end if;
  n := n + 1;

  -- T7 the write gate still refuses a direct market write on a locked row
  begin
    update public.ufc_model_predictions set sample_context = jsonb_set(sample_context, '{market}', mk) where id = p_locked;
    raise exception 'FAIL T7 direct locked update allowed';
  exception when restrict_violation then n := n + 1; end;

  -- T8 non-champion rows are refused
  res := public.ufc_model_refresh_prediction_market(p_other, (select generated_at from public.ufc_model_predictions where id = p_other), mk);
  if res->>'reason' <> 'not_champion' then raise exception 'FAIL T8 non-champion accepted: %', res; end if;
  n := n + 1;

  -- T9 malformed markets are rejected
  begin
    perform public.ufc_model_refresh_prediction_market(p, g, '{"status":"UNAVAILABLE"}'::jsonb);
    raise exception 'FAIL T9 UNAVAILABLE accepted';
  exception when check_violation then n := n + 1; end;
  begin
    perform public.ufc_model_refresh_prediction_market(p, g, '{"status":"FRESH"}'::jsonb);
    raise exception 'FAIL T9 missing observed_at accepted';
  exception when check_violation then n := n + 1; end;

  -- T10 unknown id is a no-op
  res := public.ufc_model_refresh_prediction_market(gen_random_uuid(), g, mk);
  if res->>'reason' <> 'not_found' then raise exception 'FAIL T10 %', res; end if;
  n := n + 1;

  -- T11 privileges: service role only
  if has_function_privilege('anon', 'public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb)', 'execute') then
    raise exception 'FAIL T11 privileges';
  end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end;
$$;
