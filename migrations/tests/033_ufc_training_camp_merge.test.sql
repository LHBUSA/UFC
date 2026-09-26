-- Behavioural tests for migration 033 (runs after 032 is present). Always rolled back
-- (scripts/db/prove_033.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  f uuid; f2 uuid; r jsonb; n int := 0; c int; a uuid; b uuid; z uuid; j jsonb; t0 timestamptz := '2030-01-01T00:00:00Z';
begin
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t033a', 'T033 Fighter', 'http://example.invalid/f') returning id into f;
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t033b', 'T033 Other', 'http://example.invalid/g') returning id into f2;

  -- two ESPN ids for the same gym, before any merge: a move between them IS an observed change
  r := public.ufc_training_record_association(f, 't033a', 'x3301', 'T033 Planet', 'https://example.invalid/a', t0);
  a := (r->>'camp_id')::uuid;
  r := public.ufc_training_record_association(f2, 't033b', 'x3302', 'T033-Planet', 'https://example.invalid/b', t0);
  b := (r->>'camp_id')::uuid;
  if a = b then raise exception 'FAIL T0 distinct ESPN ids must be distinct camps'; end if;

  -- T1 merge b into a: the row keeps its ESPN id; merge requires a note
  begin
    update public.ufc_training_camps set merged_into = a where id = b;
    raise exception 'FAIL T1 merge without note allowed';
  exception when check_violation then null; end;
  update public.ufc_training_camps set merged_into = a, merged_at = now(), merge_note = 'test: identical names' where id = b;
  select count(*) into c from public.ufc_training_camps where id = b and espn_association_id = 'x3302' and merged_into = a;
  if c <> 1 then raise exception 'FAIL T1 source id kept'; end if;
  if public.ufc_training_canonical_camp(b) <> a or public.ufc_training_canonical_camp(a) <> a then raise exception 'FAIL T1 canonical'; end if;
  n := n + 1;

  -- T2 views resolve: f2's current camp is now the canonical camp
  select current_camp into j from public.ufc_fighter_training_current where fighter_id = f2;
  if (j->>'camp_id')::uuid <> a or j->>'name' <> 'T033 Planet' then raise exception 'FAIL T2 current %', j; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f2 and camp_id = a and camp_name = 'T033 Planet';
  if c <> 1 then raise exception 'FAIL T2 stint'; end if;
  n := n + 1;

  -- T3 moving between the merged twin ids is a confirmation, not an observed change, and one stint
  r := public.ufc_training_record_association(f, 't033a', 'x3302', 'T033-Planet', 'https://example.invalid/b', t0 + interval '5 days');
  if r->>'action' <> 'confirmed' then raise exception 'FAIL T3 action %', r; end if;
  select count(*) into c from public.ufc_training_change_events where fighter_id = f;
  if c <> 0 then raise exception 'FAIL T3 false change event'; end if;
  select count(*) into c from public.ufc_fighter_camp_stints where fighter_id = f;
  if c <> 1 then raise exception 'FAIL T3 stints %', c; end if;
  n := n + 1;

  -- T4 a real move still emits the observed change, named canonically
  r := public.ufc_training_record_association(f2, 't033b', 'x3309', 'T033 Elsewhere', 'https://example.invalid/e', t0 + interval '9 days');
  if r->>'action' <> 'changed' then raise exception 'FAIL T4 %', r; end if;
  select count(*) into c from public.ufc_training_change_events where fighter_id = f2 and kind = 'AFFILIATION_CHANGED_OBSERVED' and previous_camp_id = a and previous_value = 'T033 Planet';
  if c <> 1 then raise exception 'FAIL T4 event'; end if;
  n := n + 1;

  -- T5 no chains: a target cannot be merged, and nothing merges into a merged camp
  insert into public.ufc_training_camps (canonical_name, slug) values ('T033 Zed', 't033-zed') returning id into z;
  begin
    update public.ufc_training_camps set merged_into = z, merged_at = now(), merge_note = 'x' where id = a;
    raise exception 'FAIL T5 target merged';
  exception when check_violation then null; end;
  begin
    update public.ufc_training_camps set merged_into = b, merged_at = now(), merge_note = 'x' where id = z;
    raise exception 'FAIL T5 merged into a merged camp';
  exception when check_violation then null; end;
  n := n + 1;

  -- T6 reversible
  update public.ufc_training_camps set merged_into = null, merged_at = null, merge_note = null where id = b;
  if public.ufc_training_canonical_camp(b) <> b then raise exception 'FAIL T6'; end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end $$;
