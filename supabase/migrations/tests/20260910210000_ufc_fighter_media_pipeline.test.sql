-- Behavioural test for 20260910210000_ufc_fighter_media_pipeline.sql.
--
-- Runs inside one transaction and rolls back. Safe against a scratch database
-- that has the migration applied; scripts/media/test_media_migration.mjs runs
-- it against a throwaway local Postgres with stub base tables.
--
-- Every block raises on failure, so psql -v ON_ERROR_STOP=1 exits non-zero.

begin;

-- Fixtures -------------------------------------------------------------------
insert into public.ufc_fighters (id, name) values
  ('00000000-0000-0000-0000-00000000000a', 'Test Fighter A'),
  ('00000000-0000-0000-0000-00000000000b', 'Test Fighter B');

insert into public.ufc_fighter_media_candidates
  (id, fighter_id, image_url, source_url, source_name, source_type, license_type, license_label,
   commercial_use_allowed, derivative_use_allowed, attribution_required, attribution_text,
   identity_evidence, identity_confidence, discovered_by)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a',
   'https://example.org/a1.jpg?x=1', 'https://commons.wikimedia.org/wiki/File:A1.jpg', 'Wikimedia Commons',
   'wikimedia_commons', 'cc_by_sa', 'CC BY-SA 4.0', true, true, true, 'Someone, CC BY-SA 4.0, via Wikimedia Commons',
   '{"method":"wikidata_p18","dob_match":true}', 0.95, 'test'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a',
   'https://example.org/a2.jpg', 'https://commons.wikimedia.org/wiki/File:A2.jpg', 'Wikimedia Commons',
   'wikimedia_commons', 'cc0', 'CC0', true, true, false, null,
   '{"method":"commons_category","dob_match":true}', 0.85, 'test'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000b',
   'https://a.espncdn.com/i/headshots/mma/players/full/1.png', 'https://www.espn.com/mma/fighter/_/id/1', 'ESPN',
   'espn', 'display_only', null, false, false, true, 'Photo: ESPN',
   '{"espn_athlete_id":"1","name_match":true}', 0.7, 'test'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000b',
   'https://example.org/no-evidence.jpg', 'https://example.org/no-evidence', 'Somewhere',
   'other', 'unknown', null, false, false, true, 'x',
   '{}', 0.1, 'test');

-- 1. Nothing is eligible before review ---------------------------------------
do $$ begin
  if (select count(*) from public.ufc_fighter_portrait_eligible) <> 0 then
    raise exception 'FAIL 1: unreviewed rows reached the eligible view';
  end if;
end $$;

-- 2. Approve promotes to a primary asset --------------------------------------
select public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000001', 'approve', 'wikidata P18, DOB match, face checked', 'test-reviewer');
do $$ begin
  if (select count(*) from public.ufc_fighter_portrait_eligible where fighter_id = '00000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL 2: approved candidate is not the eligible primary';
  end if;
  if (select status from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000001') <> 'approved' then
    raise exception 'FAIL 2b: candidate status not approved';
  end if;
  if not (select verified_identity and identity_evidence ? 'review' from public.ufc_fighter_media_assets where candidate_id = '10000000-0000-0000-0000-000000000001') then
    raise exception 'FAIL 2c: asset missing verified_identity or review evidence';
  end if;
end $$;

-- 3. A second approval with make_primary swaps the primary; still exactly one --
select public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000002', 'approve', 'better crop', 'test-reviewer', true);
do $$ begin
  if (select count(*) from public.ufc_fighter_media_assets where fighter_id = '00000000-0000-0000-0000-00000000000a' and is_primary) <> 1 then
    raise exception 'FAIL 3: more or fewer than one primary';
  end if;
  if (select image_url from public.ufc_fighter_portrait_eligible where fighter_id = '00000000-0000-0000-0000-00000000000a') <> 'https://example.org/a2.jpg' then
    raise exception 'FAIL 3b: primary did not move to the new approval';
  end if;
end $$;

-- 4. The unique partial index rejects a second primary written directly -------
do $$ begin
  begin
    update public.ufc_fighter_media_assets set is_primary = true
     where fighter_id = '00000000-0000-0000-0000-00000000000a' and not is_primary;
    raise exception 'FAIL 4: second primary accepted';
  exception when unique_violation then null;
  end;
end $$;

-- 5. No evidence, no approval ------------------------------------------------
do $$ begin
  begin
    perform public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000004', 'approve', 'looks right', 'test-reviewer');
    raise exception 'FAIL 5: approved a candidate with empty identity evidence';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

-- 6. Direct writes cannot fake an approval -----------------------------------
do $$ begin
  begin
    insert into public.ufc_fighter_media_assets (fighter_id, image_url, source_url, source_name, source_type, review_status, is_primary)
    values ('00000000-0000-0000-0000-00000000000b', 'https://example.org/fake.jpg', 'https://example.org/fake', 'x', 'other', 'approved', true);
    raise exception 'FAIL 6: approval without verification accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ufc_fighter_media_assets (fighter_id, image_url, source_url, source_name, source_type, license_type, commercial_use_allowed)
    values ('00000000-0000-0000-0000-00000000000b', 'https://example.org/fake2.jpg', 'https://example.org/fake2', 'x', 'espn', 'display_only', true);
    raise exception 'FAIL 6b: commercial flag without a rights basis accepted';
  exception when check_violation then null;
  end;
end $$;

-- 7. Reject needs a reason and records it -------------------------------------
do $$ begin
  begin
    perform public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000004', 'reject', '  ', 'test-reviewer');
    raise exception 'FAIL 7: reject without reason accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;
select public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000004', 'reject', 'no provenance', 'test-reviewer');
do $$ begin
  if (select status || '|' || review_reason from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000004') <> 'rejected|no provenance' then
    raise exception 'FAIL 7b: rejection not recorded';
  end if;
end $$;

-- 8. Quarantine takes an approved primary out of service ---------------------
select public.ufc_media_quarantine_asset(
  (select id from public.ufc_fighter_media_assets where fighter_id = '00000000-0000-0000-0000-00000000000a' and is_primary),
  'wrong person', 'test-reviewer');
do $$ begin
  if exists (select 1 from public.ufc_fighter_portrait_eligible where image_url = 'https://example.org/a2.jpg') then
    raise exception 'FAIL 8: quarantined asset still eligible';
  end if;
  if (select review_status from public.ufc_fighter_media_assets where image_url = 'https://example.org/a2.jpg') <> 'quarantined' then
    raise exception 'FAIL 8b: asset not marked quarantined';
  end if;
  if (select status from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000002') <> 'quarantined' then
    raise exception 'FAIL 8c: source candidate not marked quarantined';
  end if;
end $$;

-- 9. Quarantine blocks re-use: re-queue for another fighter, re-approve -------
insert into public.ufc_fighter_media_candidates
  (id, fighter_id, image_url, source_url, source_name, source_type, license_type, identity_evidence, discovered_by)
values ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000b',
        'https://EXAMPLE.org/a2.jpg?utm=1', 'https://commons.wikimedia.org/wiki/File:A2.jpg', 'Wikimedia Commons',
        'wikimedia_commons', 'cc0', '{"method":"x"}', 'test');
do $$ begin
  if (select status from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000005') <> 'quarantined' then
    raise exception 'FAIL 9: quarantined image re-entered the queue as pending';
  end if;
  begin
    update public.ufc_fighter_media_assets set review_status = 'approved', is_primary = false
     where image_url = 'https://example.org/a2.jpg';
    raise exception 'FAIL 9b: quarantined asset re-approved by direct write';
  exception when check_violation then null;
  end;
  update public.ufc_fighter_media_candidates set status = 'pending' where id = '10000000-0000-0000-0000-000000000005';
  if (select status from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000005') <> 'quarantined' then
    raise exception 'FAIL 9c: status flip back to pending was not blocked';
  end if;
end $$;

-- 10. The carried-over ESPN quarantine is present -----------------------------
do $$ begin
  if not public.ufc_media_is_quarantined('https://a.espncdn.com/i/headshots/mma/players/full/5307124.png', null) then
    raise exception 'FAIL 10: Pasley ESPN quarantine missing';
  end if;
end $$;

-- 11. Public roles are refused -----------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.ufc_fighter_media_assets', 'select')
       or has_table_privilege(r, 'public.ufc_fighter_media_candidates', 'select')
       or has_table_privilege(r, 'public.ufc_media_quarantine', 'select')
       or has_table_privilege(r, 'public.ufc_fighter_portrait_eligible', 'select')
       or has_function_privilege(r, 'public.ufc_media_review_candidate(uuid, text, text, text, boolean)', 'execute')
       or has_function_privilege(r, 'public.ufc_media_quarantine_asset(uuid, text, text)', 'execute') then
      raise exception 'FAIL 11: % can read or execute the media pipeline', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.ufc_media_review_candidate(uuid, text, text, text, boolean)', 'execute')
     or not has_table_privilege('service_role', 'public.ufc_fighter_portrait_eligible', 'select') then
    raise exception 'FAIL 11b: service_role lost access';
  end if;
end $$;

-- 12. Primary survives when a non-primary approval is added without make_primary
select public.ufc_media_review_candidate('10000000-0000-0000-0000-000000000003', 'approve', 'ESPN athlete API name+DOB match, face checked', 'test-reviewer', false);
do $$ begin
  -- B had no primary, so the first approval becomes primary even with make_primary=false.
  if (select count(*) from public.ufc_fighter_media_assets where fighter_id = '00000000-0000-0000-0000-00000000000b' and is_primary) <> 1 then
    raise exception 'FAIL 12: first approval for a fighter did not become primary';
  end if;
  if (select surface_policy from public.ufc_fighter_portrait_eligible where fighter_id = '00000000-0000-0000-0000-00000000000b') is null then
    raise exception 'FAIL 12b: ESPN approval missing from eligible view';
  end if;
end $$;

-- 13. The generator's upsert target (on_conflict=fighter_id,image_key,
--     ignore-duplicates) works against the generated column and never resets
--     a reviewed candidate.
insert into public.ufc_fighter_media_candidates
  (fighter_id, image_url, source_url, source_name, source_type, identity_evidence, discovered_by, status)
values ('00000000-0000-0000-0000-00000000000a', 'https://example.org/a1.jpg?x=2', 'https://commons.wikimedia.org/wiki/File:A1.jpg',
        'Wikimedia Commons', 'wikimedia_commons', '{"method":"rerun"}', 'test-rerun', 'pending')
on conflict (fighter_id, image_key) do nothing;
do $$ begin
  if (select count(*) from public.ufc_fighter_media_candidates where fighter_id = '00000000-0000-0000-0000-00000000000a' and image_key = 'https://example.org/a1.jpg') <> 1 then
    raise exception 'FAIL 13: re-run duplicated a candidate';
  end if;
  if (select status from public.ufc_fighter_media_candidates where id = '10000000-0000-0000-0000-000000000001') <> 'approved' then
    raise exception 'FAIL 13b: re-run reset a reviewed candidate';
  end if;
end $$;

select 'ufc_fighter_media_pipeline: all checks passed' as result;

rollback;
