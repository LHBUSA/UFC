-- Behavioural tests for migration 032. Run INSIDE a transaction that is always
-- rolled back (scripts/db/prove_032.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  f uuid; f2 uuid; r jsonb; n int := 0; c int; ev_obs uuid; ev_conf uuid; camp_b uuid; camp_a uuid; manual_camp uuid;
  coach uuid; j jsonb; t0 timestamptz := '2030-01-01T00:00:00Z';
begin
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t032a', 'T032 Fighter', 'http://example.invalid/f') returning id into f;
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t032b', 'T032 Other', 'http://example.invalid/g') returning id into f2;

  -- T1 first capture creates the camp (ESPN id), alias and one OBSERVED row
  r := public.ufc_training_record_association(f, 't032a', 'x9001', 'T032 Camp A', 'https://example.invalid/a', t0);
  if r->>'action' <> 'first' then raise exception 'FAIL T1 action %', r; end if;
  camp_a := (r->>'camp_id')::uuid;
  select count(*) into c from public.ufc_training_camps where id = camp_a and espn_association_id = 'x9001' and slug = 't032-camp-a';
  if c <> 1 then raise exception 'FAIL T1 camp'; end if;
  select count(*) into c from public.ufc_training_camp_aliases where camp_id = camp_a;
  if c <> 1 then raise exception 'FAIL T1 alias'; end if;
  select count(*) into c from public.ufc_training_observations where fighter_id = f and certainty = 'OBSERVED' and effective_from is null;
  if c <> 1 then raise exception 'FAIL T1 obs'; end if;
  n := n + 1;

  -- T2 same association id = confirmation stamp only
  r := public.ufc_training_record_association(f, 't032a', 'x9001', 'T032 Camp A', 'https://example.invalid/a', t0 + interval '1 day');
  if r->>'action' <> 'confirmed' then raise exception 'FAIL T2 action %', r; end if;
  select count(*) into c from public.ufc_training_observations where fighter_id = f and confirm_count = 2 and last_confirmed_at = t0 + interval '1 day';
  if c <> 1 then raise exception 'FAIL T2 stamp'; end if;
  select count(*) into c from public.ufc_training_observations where fighter_id = f;
  if c <> 1 then raise exception 'FAIL T2 row count %', c; end if;
  n := n + 1;

  -- T3 a different association id = new row + AFFILIATION_CHANGED_OBSERVED, prior stint closes
  r := public.ufc_training_record_association(f, 't032a', 'x9002', 'T032 Camp B', 'https://example.invalid/b', t0 + interval '30 days');
  if r->>'action' <> 'changed' then raise exception 'FAIL T3 action %', r; end if;
  camp_b := (r->>'camp_id')::uuid;
  select id into ev_obs from public.ufc_training_change_events where fighter_id = f and kind = 'AFFILIATION_CHANGED_OBSERVED'
    and previous_camp_id = camp_a and new_camp_id = camp_b and previous_value = 'T032 Camp A' and new_value = 'T032 Camp B' and effective_on is null;
  if ev_obs is null then raise exception 'FAIL T3 event'; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f;
  if c <> 2 then raise exception 'FAIL T3 stints %', c; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f and camp_id = camp_a and not is_current
    and last_confirmed_at = t0 + interval '1 day' and next_first_observed_at = t0 + interval '30 days';
  if c <> 1 then raise exception 'FAIL T3 closed stint'; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f and camp_id = camp_b and is_current and certainty = 'OBSERVED';
  if c <> 1 then raise exception 'FAIL T3 current stint'; end if;
  n := n + 1;

  -- T4 identity guard: the fighter row must hold that ESPN athlete id
  r := public.ufc_training_record_association(f, 'someone-else', 'x9003', 'T032 Camp C', 'https://example.invalid/c', t0);
  if r->>'action' <> 'identity_mismatch' then raise exception 'FAIL T4 %', r; end if;
  n := n + 1;

  -- T5 no association = nothing written (unknown stays unknown)
  r := public.ufc_training_record_association(f2, 't032b', null, null, 'https://example.invalid/x', t0);
  if r->>'action' <> 'absent' then raise exception 'FAIL T5 %', r; end if;
  select count(*) into c from public.ufc_training_observations where fighter_id = f2;
  if c <> 0 then raise exception 'FAIL T5 wrote'; end if;
  n := n + 1;

  -- T6 observations are append-only: no content update, no delete, no backwards stamp
  begin
    update public.ufc_training_observations set value_raw = 'edited' where fighter_id = f;
    raise exception 'FAIL T6 update allowed';
  exception when restrict_violation then n := n + 1; end;
  begin
    delete from public.ufc_training_observations where fighter_id = f;
    raise exception 'FAIL T6 delete allowed';
  exception when restrict_violation then n := n + 1; end;
  begin
    update public.ufc_training_observations set last_confirmed_at = t0 - interval '10 days' where fighter_id = f and camp_id = camp_a;
    raise exception 'FAIL T6 backwards stamp allowed';
  exception when restrict_violation or check_violation then n := n + 1; end;

  -- T7 change events are append-only
  begin
    update public.ufc_training_change_events set new_value = 'edited' where id = ev_obs;
    raise exception 'FAIL T7 update allowed';
  exception when restrict_violation then n := n + 1; end;

  -- T8 an OBSERVED row cannot carry an inferred date
  begin
    insert into public.ufc_training_observations (fighter_id, fact, camp_id, relationship_type, value_raw, effective_from, certainty, source_id, source_url, obs_hash)
      select f, 'AFFILIATION', camp_a, 'AFFILIATION', 'x', '2029-01-01', 'OBSERVED', id, 'https://example.invalid/x', 't032-t8' from public.combat_sources where source_key = 'espn_athlete_association';
    raise exception 'FAIL T8 inferred date allowed';
  exception when check_violation then n := n + 1; end;

  -- T9 a manual CONFIRMED switch upgrades the OBSERVED event without deleting it
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'switch', 'fighter_id', f, 'camp_id', camp_b, 'from_camp_id', camp_a,
    'effective_from', '2030-01-20', 'source_url', 'https://example.invalid/announcement'));
  select id into ev_conf from public.ufc_training_change_events where id = (r->>'event_id')::uuid and kind = 'CAMP_CHANGED_CONFIRMED'
    and supersedes_event_id = ev_obs and effective_on = '2030-01-20' and previous_value = 'T032 Camp A';
  if ev_conf is null then raise exception 'FAIL T9 confirmed event %', r; end if;
  select count(*) into c from public.ufc_training_change_events where id = ev_obs;
  if c <> 1 then raise exception 'FAIL T9 observed event lost'; end if;
  -- the stated switch joins camp B's stint (same camp, consecutive) and dates it
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f and camp_id = camp_b and is_current and certainty = 'STATED' and joined_on = '2030-01-20';
  if c <> 1 then raise exception 'FAIL T9 stint'; end if;
  -- the identical payload again is a no-op
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'switch', 'fighter_id', f, 'camp_id', camp_b, 'from_camp_id', camp_a,
    'effective_from', '2030-01-20', 'source_url', 'https://example.invalid/announcement'));
  if r->>'action' <> 'duplicate' then raise exception 'FAIL T9 idempotency %', r; end if;
  n := n + 1;

  -- T10 coaches: added, then removed; the current view lists only active coaches
  insert into public.ufc_coaches (canonical_name, slug) values ('T032 Coach', 't032-coach') returning id into coach;
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'coach', 'fighter_id', f, 'coach_id', coach, 'coach_role', 'STRIKING', 'source_url', 'https://example.invalid/coach'));
  select count(*) into c from public.ufc_training_change_events where fighter_id = f and kind = 'COACH_ADDED' and new_value = 'T032 Coach · STRIKING';
  if c <> 1 then raise exception 'FAIL T10 added'; end if;
  select coaches into j from public.ufc_fighter_training_current where fighter_id = f;
  if jsonb_array_length(j) <> 1 or j->0->>'role' <> 'STRIKING' then raise exception 'FAIL T10 current %', j; end if;
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'coach_end', 'fighter_id', f, 'coach_id', coach, 'coach_role', 'STRIKING', 'source_url', 'https://example.invalid/coach-left'));
  select count(*) into c from public.ufc_training_change_events where fighter_id = f and kind = 'COACH_REMOVED' and previous_value = 'T032 Coach · STRIKING' and new_value is null;
  if c <> 1 then raise exception 'FAIL T10 removed'; end if;
  select coaches into j from public.ufc_fighter_training_current where fighter_id = f;
  if jsonb_array_length(j) <> 0 then raise exception 'FAIL T10 still listed %', j; end if;
  n := n + 1;

  -- T11 fighting out of: first fact is no event; a different place is FIGHTING_OUT_OF_CHANGED
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'fighting_out_of', 'fighter_id', f, 'city', 'Chicago', 'region', 'Illinois', 'country', 'USA', 'source_url', 'https://example.invalid/foo1'));
  if r->>'event_id' is not null then raise exception 'FAIL T11 first emitted'; end if;
  r := public.ufc_training_add_manual(jsonb_build_object('kind', 'fighting_out_of', 'fighter_id', f, 'city', 'Miami', 'region', 'Florida', 'country', 'USA', 'source_url', 'https://example.invalid/foo2'));
  select count(*) into c from public.ufc_training_change_events where id = (r->>'event_id')::uuid and kind = 'FIGHTING_OUT_OF_CHANGED'
    and previous_value = 'Chicago, Illinois, USA' and new_value = 'Miami, Florida, USA';
  if c <> 1 then raise exception 'FAIL T11 change'; end if;
  n := n + 1;

  -- T12 the current view assembles camp + fighting out of, and never invents a training location
  select to_jsonb(v) into j from public.ufc_fighter_training_current v where fighter_id = f;
  if j->'current_camp'->>'name' <> 'T032 Camp B' or j->'fighting_out_of'->>'city' <> 'Miami' or j->'training_location' <> 'null'::jsonb then
    raise exception 'FAIL T12 %', j;
  end if;
  n := n + 1;

  -- T13 a manually created camp without an ESPN id is attached by exact normalized name
  insert into public.ufc_training_camps (canonical_name, slug) values ('T032 Manual Gym', 't032-manual-gym') returning id into manual_camp;
  r := public.ufc_training_record_association(f2, 't032b', 'x9010', 'T032 MANUAL GYM', 'https://example.invalid/m', t0);
  if (r->>'camp_id')::uuid <> manual_camp or (r->>'attached_by_name')::boolean is not true then raise exception 'FAIL T13 %', r; end if;
  select count(*) into c from public.ufc_training_camps where id = manual_camp and espn_association_id = 'x9010';
  if c <> 1 then raise exception 'FAIL T13 id'; end if;
  n := n + 1;

  -- T14 A -> B -> A is three stints, the return is a new observed change
  r := public.ufc_training_record_association(f, 't032a', 'x9001', 'T032 Camp A', 'https://example.invalid/a', t0 + interval '90 days');
  if r->>'action' <> 'changed' then raise exception 'FAIL T14 action %', r; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f;
  if c <> 3 then raise exception 'FAIL T14 stints %', c; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f and is_current and camp_id = camp_a;
  if c <> 1 then raise exception 'FAIL T14 current'; end if;
  n := n + 1;

  -- T15 public roles cannot read the ledger or call the writers
  if has_table_privilege('anon', 'public.ufc_training_observations', 'select')
     or has_table_privilege('authenticated', 'public.ufc_fighter_training_current', 'select')
     or has_function_privilege('anon', 'public.ufc_training_record_association(uuid, text, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.ufc_training_add_manual(jsonb)', 'execute') then
    raise exception 'FAIL T15 privileges';
  end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end $$;
