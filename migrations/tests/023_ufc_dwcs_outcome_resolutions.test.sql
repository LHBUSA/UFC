-- 023 / 20260913000006 — Contender Series outcome resolutions.
--
-- Run CHAINED AFTER the migration, inside one BEGIN ... ROLLBACK:
--   pwsh scripts/db/apply_supabase_migration.ps1 -Mode proof -Chain \
--     -Paths "supabase/migrations/20260913000006_ufc_dwcs_outcome_resolutions.sql,migrations/tests/023_ufc_dwcs_outcome_resolutions.test.sql"
--
-- Every write below happens inside the rolled-back transaction.

do $test$
declare
  n int; fp text;
  ok_claim public.ufc_dwcs_outcome_claims%rowtype;
  espn_claim uuid; conflicted_claim uuid; review_claim uuid; other_fighter uuid;
  res uuid;
begin
  -- 1. Evidence is intact: same rows, same sources, same excerpts, same corroboration.
  select count(*), md5(string_agg(concat_ws('|', id, fighter_id, event_id, bout_id, claim_type, source_url, source_title, source_date,
                                            source_family, source_excerpt_short, evidence::text, captured_at), '#' order by id))
    into n, fp from public.ufc_dwcs_outcome_claims;
  assert n = 270, format('evidence rows changed: %s', n);
  assert fp = 'bf7ab162e8a99e9e395a06fabe64eeda', format('evidence content changed: %s', fp);
  select count(*) into n from public.ufc_dwcs_outcome_claims where claim_status = 'published';
  assert n = 0, 'legacy published triage remains';
  select count(*) into n from public.ufc_dwcs_outcome_claims where claim_status = 'eligible';
  assert n = 126, format('eligible triage count %s <> 126', n);
  select count(*) into n from public.ufc_dwcs_outcome_claims where evidence ? 'corroborated_by';
  assert n = 38, format('ESPN corroboration lost: %s', n);

  -- 2. A raw UFC.com claim without a resolution is not public.
  select count(*) into n from public.ufc_dwcs_outcome_display;
  assert n = 0, format('display is not empty before any resolution: %s', n);

  -- 3. Claims are evidence.
  begin
    delete from public.ufc_dwcs_outcome_claims where id = (select id from public.ufc_dwcs_outcome_claims limit 1);
    assert false, 'a claim was deleted';
  exception when raise_exception then null; end;
  begin
    update public.ufc_dwcs_outcome_claims set source_url = 'https://example.invalid/' where id = (select id from public.ufc_dwcs_outcome_claims limit 1);
    assert false, 'a claim source_url was rewritten';
  exception when raise_exception then null; end;
  begin
    update public.ufc_dwcs_outcome_claims set evidence = evidence - 'corroborated_by'
      where id = (select id from public.ufc_dwcs_outcome_claims where evidence ? 'corroborated_by' limit 1);
    assert false, 'ESPN corroboration was removed';
  exception when raise_exception then null; end;
  begin
    update public.ufc_dwcs_outcome_claims set fighter_id = (select id from public.ufc_fighters where id <> fighter_id limit 1)
      where id = (select id from public.ufc_dwcs_outcome_claims limit 1);
    assert false, 'a claim moved to another fighter without a recorded merge';
  exception when raise_exception then null; end;

  -- 4. Nothing but an eligible official claim can be selected.
  select id into espn_claim from public.ufc_dwcs_outcome_claims where source_family = 'espn.com' and claim_status = 'secondary_only' limit 1;
  select id into conflicted_claim from public.ufc_dwcs_outcome_claims where source_family = 'ufc.com' and claim_status = 'conflicted' limit 1;
  select id into review_claim from public.ufc_dwcs_outcome_claims where claim_status = 'review' limit 1;
  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      select fighter_id, event_id, bout_id, claim_type, id, 'operator_decision', 'test' from public.ufc_dwcs_outcome_claims where id = espn_claim;
    assert false, 'an ESPN-only claim was resolved for display';
  exception when raise_exception then null; end;
  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      select fighter_id, event_id, bout_id, claim_type, id, 'operator_decision', 'test' from public.ufc_dwcs_outcome_claims where id = conflicted_claim;
    assert false, 'a conflicted claim was resolved for display';
  exception when raise_exception then null; end;
  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      select fighter_id, event_id, bout_id, claim_type, id, 'operator_decision', 'test' from public.ufc_dwcs_outcome_claims where id = review_claim;
    assert false, 'a claim in review was resolved without clearing review';
  exception when raise_exception then null; end;

  -- An eligible, ESPN-corroborated claim for the recorded winner.
  select c.* into ok_claim from public.ufc_dwcs_outcome_claims c
    join public.ufc_bout_results r on r.bout_id = c.bout_id and r.winner_id = c.fighter_id
   where c.claim_status = 'eligible' and c.evidence ? 'corroborated_by' order by c.id limit 1;
  assert ok_claim.id is not null, 'no eligible corroborated claim to test with';

  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      values (ok_claim.fighter_id, ok_claim.event_id, ok_claim.bout_id, ok_claim.claim_type, ok_claim.id, 'sole_claim', 'test');
    assert false, 'an automatic resolution rule was accepted';
  exception when check_violation then null; end;
  select id into other_fighter from public.ufc_fighters where id <> ok_claim.fighter_id limit 1;
  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      values (other_fighter, ok_claim.event_id, ok_claim.bout_id, ok_claim.claim_type, ok_claim.id, 'operator_decision', 'test');
    assert false, 'a claim was resolved onto a different fighter';
  exception when foreign_key_violation then null; end;

  -- 5. An explicit approved resolution is public.
  insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by, review_notes)
    values (ok_claim.fighter_id, ok_claim.event_id, ok_claim.bout_id, ok_claim.claim_type, ok_claim.id, 'operator_decision', 'test-operator', 'migration test')
    returning id into res;
  select count(*) into n from public.ufc_dwcs_outcome_display;
  assert n = 1, format('an approved resolution did not display: %s', n);
  begin
    insert into public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, bout_id, claim_type, selected_claim_id, resolution_rule, resolved_by)
      values (ok_claim.fighter_id, ok_claim.event_id, ok_claim.bout_id, ok_claim.claim_type, ok_claim.id, 'operator_decision', 'test');
    assert false, 'two approved resolutions for one outcome';
  exception when unique_violation then null; end;

  -- 6. Withdrawing a resolution hides it and deletes no evidence.
  begin
    delete from public.ufc_dwcs_outcome_resolutions where id = res;
    assert false, 'a resolution was deleted';
  exception when raise_exception then null; end;
  begin
    update public.ufc_dwcs_outcome_resolutions set resolution_status = 'withdrawn', withdrawn_at = now() where id = res;
    assert false, 'a withdrawal without who/why was accepted';
  exception when check_violation then null; end;
  update public.ufc_dwcs_outcome_resolutions
     set resolution_status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'test-operator', withdrawn_reason = 'migration test'
   where id = res;
  select count(*) into n from public.ufc_dwcs_outcome_display;
  assert n = 0, 'a withdrawn resolution still displays';
  select count(*) into n from public.ufc_dwcs_outcome_claims where id = ok_claim.id;
  assert n = 1, 'withdrawing a resolution removed its evidence';
  begin
    update public.ufc_dwcs_outcome_resolutions set resolution_status = 'approved', withdrawn_at = null, withdrawn_by = null, withdrawn_reason = null where id = res;
    assert false, 'a withdrawn resolution was re-approved in place';
  exception when raise_exception then null; end;

  -- 7. A DWCS win alone never creates an outcome: no winner is displayed without a resolution.
  select count(*) into n from public.ufc_dwcs_outcome_display d
   where not exists (select 1 from public.ufc_dwcs_outcome_resolutions r where r.id = d.resolution_id and r.resolution_status = 'approved');
  assert n = 0, 'an outcome displayed without an approved resolution';

  select count(*) into n from public.ufc_dwcs_outcome_claims;
  assert n = 270, format('evidence rows changed during the test: %s', n);

  raise notice 'ALL 023 OUTCOME RESOLUTION ASSERTIONS PASSED';
end
$test$;

select (select count(*) from public.ufc_dwcs_outcome_claims) as evidence_rows,
       (select count(*) from public.ufc_dwcs_outcome_display) as public_outcomes;
