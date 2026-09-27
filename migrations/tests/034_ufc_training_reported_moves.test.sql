-- Behavioural tests for migration 034 (032 + 033 present). Always rolled back
-- (scripts/db/prove_034.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  f uuid; r jsonb; n int := 0; c int; nog uuid; att uuid; j jsonb; t0 timestamptz := '2030-06-01T00:00:00Z';
begin
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t034a', 'T034 Fighter', 'http://example.invalid/f') returning id into f;
  -- current observed affiliation (the ESPN feed)
  r := public.ufc_training_record_association(f, 't034a', 'x3401', 'T034 Nogueira', 'https://example.invalid/espn', t0);
  nog := (r->>'camp_id')::uuid;
  insert into public.ufc_training_camps (canonical_name, slug) values ('T034 ATT', 't034-att') returning id into att;

  -- T1 a reported move published BEFORE the observation: stored, never a stint, current unchanged
  r := public.ufc_training_add_reported_move(jsonb_build_object('fighter_id', f, 'camp_id', att, 'source_url', 'https://example.invalid/report', 'source_published_at', '2030-03-08'));
  if r->>'action' <> 'inserted' then raise exception 'FAIL T1 %', r; end if;
  select current_camp into j from public.ufc_fighter_training_current where fighter_id = f;
  if (j->>'camp_id')::uuid <> nog then raise exception 'FAIL T1 current overridden %', j; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f;
  if c <> 1 then raise exception 'FAIL T1 stints %', c; end if;
  select count(*) into c from public.ufc_training_change_events where fighter_id = f and kind = 'CAMP_MOVE_REPORTED'
    and new_camp_id = att and new_value = 'T034 ATT' and not exact_date_known and effective_on is null and source_published_at = '2030-03-08';
  if c <> 1 then raise exception 'FAIL T1 event'; end if;
  n := n + 1;

  -- T2 a reported move published AFTER the observation (newer article + newer capture) still cannot become current
  r := public.ufc_training_add_reported_move(jsonb_build_object('fighter_id', f, 'to_raw', 'T034 Brand New Gym', 'from_camp_id', nog, 'source_url', 'https://example.invalid/report2', 'source_published_at', '2031-01-01'));
  select current_camp into j from public.ufc_fighter_training_current where fighter_id = f;
  if (j->>'camp_id')::uuid <> nog then raise exception 'FAIL T2 current overridden %', j; end if;
  -- raw destination: no camp entity was created
  select count(*) into c from public.ufc_training_camps where canonical_name = 'T034 Brand New Gym';
  if c <> 0 then raise exception 'FAIL T2 camp created'; end if;
  select count(*) into c from public.ufc_training_change_events where fighter_id = f and kind = 'CAMP_MOVE_REPORTED' and new_camp_id is null
    and new_value = 'T034 Brand New Gym' and previous_value = 'T034 Nogueira';
  if c <> 1 then raise exception 'FAIL T2 raw event'; end if;
  n := n + 1;

  -- T3 no effective date may be supplied, and a publication date is required
  begin
    perform public.ufc_training_add_reported_move(jsonb_build_object('fighter_id', f, 'camp_id', att, 'source_url', 'https://example.invalid/x', 'source_published_at', '2030-01-01', 'effective_from', '2029-12-01'));
    raise exception 'FAIL T3 effective date accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.ufc_training_add_reported_move(jsonb_build_object('fighter_id', f, 'camp_id', att, 'source_url', 'https://example.invalid/x'));
    raise exception 'FAIL T3 no publication date accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  n := n + 1;

  -- T4 the table itself refuses a reported row with a date, or without a publication date
  begin
    insert into public.ufc_training_observations (fighter_id, fact, camp_id, relationship_type, reported_only, value_raw, certainty, effective_from, source_id, source_url, source_published_at, obs_hash)
      select f, 'AFFILIATION', att, 'PRIMARY_CAMP', true, 'x', 'STATED', '2030-01-01', id, 'https://example.invalid/x', '2030-02-01', 't034-t4a' from public.combat_sources where source_key = 'ufc_training_manual';
    raise exception 'FAIL T4 dated reported row allowed';
  exception when check_violation then null; end;
  begin
    insert into public.ufc_training_observations (fighter_id, fact, camp_id, relationship_type, reported_only, value_raw, certainty, source_id, source_url, obs_hash)
      select f, 'AFFILIATION', att, 'PRIMARY_CAMP', true, 'x', 'STATED', id, 'https://example.invalid/x', 't034-t4b' from public.combat_sources where source_key = 'ufc_training_manual';
    raise exception 'FAIL T4 undated-publication reported row allowed';
  exception when check_violation then null; end;
  -- and a non-reported affiliation still needs a camp
  begin
    insert into public.ufc_training_observations (fighter_id, fact, relationship_type, value_raw, certainty, source_id, source_url, obs_hash)
      select f, 'AFFILIATION', 'PRIMARY_CAMP', 'x', 'STATED', id, 'https://example.invalid/x', 't034-t4c' from public.combat_sources where source_key = 'ufc_training_manual';
    raise exception 'FAIL T4 camp-less affiliation allowed';
  exception when check_violation then null; end;
  n := n + 1;

  -- T5 idempotent, and the change detector still works beside it
  r := public.ufc_training_add_reported_move(jsonb_build_object('fighter_id', f, 'camp_id', att, 'source_url', 'https://example.invalid/report', 'source_published_at', '2030-03-08'));
  if r->>'action' <> 'duplicate' then raise exception 'FAIL T5 dup %', r; end if;
  r := public.ufc_training_record_association(f, 't034a', 'x3401', 'T034 Nogueira', 'https://example.invalid/espn', t0 + interval '1 day');
  if r->>'action' <> 'confirmed' then raise exception 'FAIL T5 confirm %', r; end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end $$;
