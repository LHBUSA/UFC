-- Proof that 20260908000014 closes the referee view bypass, for an ISOLATED
-- database only.
--
--   createdb refsec_test
--   psql refsec_test -v ON_ERROR_STOP=1 -f supabase/migrations/20260906000001_ufc_phase1_core.sql
--   psql refsec_test -v ON_ERROR_STOP=1 -f supabase/migrations/tests/20260908000014_referee_view_security.test.sql
--   dropdb refsec_test
--
-- Run from the repository root: the test \i-includes migration 008 and the
-- repair itself, so the chain it exercises is the real one rather than a
-- paraphrase of it.
--
-- It does NOT wrap itself in a transaction. Both included migrations carry
-- their own BEGIN/COMMIT, and nesting those inside an outer transaction would
-- commit it early and make the final ROLLBACK a lie. The isolation comes from
-- the database being disposable, which the first line already required.
--
-- Do NOT run against production. The production proof is the read-only
-- verifier, scripts/referees/verify-view-security.mjs; this is the half that
-- verifier cannot do, because demonstrating that a fix works requires applying
-- it, and the fix is deliberately not applied to production yet.
--
-- WHY THIS EXISTS
--
-- The read-only verifier can show the hole is open. It cannot show the patch
-- shuts it, and "this SQL looks like it should work" is not a security
-- argument. So the situation is rebuilt here from the same migration files
-- production ran, the Supabase default grants are recreated exactly as
-- information_schema reports them live, the leak is reproduced, the migration
-- is applied, and the leak is measured again.
--

\set ON_ERROR_STOP on

create table t_note (seq serial, line text);
create table t_probe (phase text, role_name text, relation text, rows_seen int, denied boolean);

create or replace function pg_temp.ok(what text)
returns void language plpgsql as $$
begin insert into t_note (line) values (format('pass: %s', what)); end $$;

-- Read one relation as one role and record what happened. A permission error
-- and an empty result are both denials, and the difference matters: after the
-- repair anon should be refused at the door, not handed an empty array.
create or replace function pg_temp.probe(p_phase text, p_role text, p_rel text)
returns void language plpgsql as $$
declare
  n int;
  was_denied boolean := false;
begin
  execute format('set local role %I', p_role);
  begin
    execute format('select count(*) from public.%I', p_rel) into n;
  exception when insufficient_privilege then
    n := null; was_denied := true;
  end;
  -- Reset BEFORE recording. Writing the result while still wearing the probed
  -- role would need a grant on this table for anon, which is precisely the
  -- kind of privilege the test exists to prove has been removed.
  reset role;
  insert into t_probe values (p_phase, p_role, p_rel, n, was_denied);
end $$;

-- ---------------------------------------------------------------------------
-- Roles, as the platform provides them.
-- ---------------------------------------------------------------------------
-- anon and authenticated are ordinary NOLOGIN roles with no RLS exemption.
-- service_role carries BYPASSRLS. The view owner (the role running this file)
-- also bypasses RLS, which is the precondition for the whole bug: production's
-- `postgres` has rolbypassrls = true.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enough archive for the views to have something to leak.
-- ---------------------------------------------------------------------------
-- This has to come BEFORE migration 008. That migration seeds two alias rows
-- pointing at canonical referees ("Lukasz Bosacki", "Horacio Lopez
-- Villanueva") and its foreign key requires those referees to already exist in
-- the archive it derives profiles from. On production they did. On an empty
-- database 008 aborts, which is worth knowing on its own.
do $$
declare
  fa uuid; fb uuid; ev uuid; b1 uuid; b2 uuid;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('refsecaaaaaaaaa1', 'Test Fighter A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('refsecaaaaaaaaa2', 'Test Fighter B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url)
    values ('refseceeeeeeeee1', 'Test Event', date '2026-01-01', 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('refsecbbbbbbbbb1', ev, fa, fb, 1, 'http://example.invalid/b1') returning id into b1;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('refsecbbbbbbbbb2', ev, fa, fb, 2, 'http://example.invalid/b2') returning id into b2;
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, referee, result_source, source_url)
    values (b1, fa, 'KO_TKO', 'KO/TKO', 1, 120, 'Herb Dean', 'ufcstats', 'http://example.invalid/r1');
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, referee, result_source, source_url)
    values (b2, fb, 'DEC_U', 'Decision - Unanimous', 3, 300, 'Herb Dean', 'ufcstats', 'http://example.invalid/r2');

  -- The two referees migration 008's alias seeds depend on.
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('refsecbbbbbbbbb3', ev, fa, fb, 3, 'http://example.invalid/b3') returning id into b1;
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, referee, result_source, source_url)
    values (b1, fa, 'SUB', 'Submission', 2, 90, 'Lukasz Bosacki', 'ufcstats', 'http://example.invalid/r3');
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('refsecbbbbbbbbb4', ev, fa, fb, 4, 'http://example.invalid/b4') returning id into b2;
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, referee, result_source, source_url)
    values (b2, fb, 'DEC_S', 'Decision - Split', 3, 300, 'Horacio Lopez Villanueva', 'ufcstats', 'http://example.invalid/r4');
end $$;

-- ---------------------------------------------------------------------------
-- The referee layer exactly as production has it.
-- ---------------------------------------------------------------------------
\i supabase/migrations/20260907000008_ufc_referee_intelligence.sql

-- ---------------------------------------------------------------------------
-- The Supabase default grants, reproduced verbatim from what production has.
-- ---------------------------------------------------------------------------
-- Measured live:
--   anon           DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   authenticated  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- on all five referee relations. Without this the test would prove nothing
-- about production, because a role with no grant is denied for the wrong reason.
grant all privileges on public.ufc_referee_stats, public.ufc_referee_directory,
  public.ufc_referee_bouts, public.ufc_referee_profiles, public.ufc_referee_aliases
  to anon, authenticated, service_role;

-- The base tables carry the same default, and they matter more than they look.
-- A security_invoker view resolves its base tables as the CALLER, so after the
-- repair service_role needs SELECT on these four in its own right - it stops
-- inheriting the owner's access the moment the flag goes on. Production has
-- them (verified: service_role holds the full default on all four). Omitting
-- them here made this test fail on its first run, which is the failure worth
-- having: without it the fixture would have been quietly more permissive than
-- production instead of less.
grant all privileges on public.ufc_bout_results, public.ufc_bouts,
  public.ufc_events, public.ufc_fighters
  to anon, authenticated, service_role;

-- ===========================================================================
-- BEFORE — reproduce the bypass
-- ===========================================================================

select pg_temp.probe('before', 'anon', 'ufc_bout_results');
select pg_temp.probe('before', 'anon', 'ufc_bouts');
select pg_temp.probe('before', 'anon', 'ufc_referee_profiles');
select pg_temp.probe('before', 'anon', 'ufc_referee_stats');
select pg_temp.probe('before', 'anon', 'ufc_referee_directory');
select pg_temp.probe('before', 'anon', 'ufc_referee_bouts');
select pg_temp.probe('before', 'service_role', 'ufc_referee_directory');

do $$
declare
  base_rows int;
  view_rows int;
  svc_rows int;
begin
  select rows_seen into base_rows from t_probe where phase='before' and role_name='anon' and relation='ufc_bout_results';
  select rows_seen into view_rows from t_probe where phase='before' and role_name='anon' and relation='ufc_referee_bouts';
  select rows_seen into svc_rows  from t_probe where phase='before' and role_name='service_role' and relation='ufc_referee_directory';

  if base_rows <> 0 then
    raise exception 'SETUP WRONG: anon can read ufc_bout_results directly (% rows); RLS is not in force and the test proves nothing', base_rows;
  end if;
  if view_rows = 0 then
    raise exception 'SETUP WRONG: the bypass did not reproduce - anon saw 0 rows through ufc_referee_bouts';
  end if;
  if svc_rows = 0 then
    raise exception 'SETUP WRONG: service_role sees nothing through ufc_referee_directory';
  end if;
  perform pg_temp.ok(format('bypass reproduced: anon reads 0 rows from ufc_bout_results but %s through ufc_referee_bouts', view_rows));
end $$;

-- ===========================================================================
-- APPLY the repair, exactly as production would
-- ===========================================================================

\i supabase/migrations/20260908000014_referee_view_security.sql

-- ===========================================================================
-- AFTER
-- ===========================================================================

select pg_temp.probe('after', 'anon', 'ufc_referee_stats');
select pg_temp.probe('after', 'anon', 'ufc_referee_directory');
select pg_temp.probe('after', 'anon', 'ufc_referee_bouts');
select pg_temp.probe('after', 'anon', 'ufc_referee_profiles');
select pg_temp.probe('after', 'anon', 'ufc_referee_aliases');
select pg_temp.probe('after', 'authenticated', 'ufc_referee_directory');
select pg_temp.probe('after', 'service_role', 'ufc_referee_stats');
select pg_temp.probe('after', 'service_role', 'ufc_referee_directory');
select pg_temp.probe('after', 'service_role', 'ufc_referee_bouts');

do $$
declare
  r record;
  svc int;
begin
  -- 1. anon is refused outright on every referee relation.
  for r in select * from t_probe where phase='after' and role_name in ('anon','authenticated') loop
    if not r.denied then
      raise exception 'FAIL: % still reads public.% after the repair (% rows)', r.role_name, r.relation, r.rows_seen;
    end if;
  end loop;
  perform pg_temp.ok('after the repair, anon and authenticated are refused on all five referee relations');

  -- 2. The server read path is untouched.
  for r in select * from t_probe where phase='after' and role_name='service_role' loop
    if r.denied or coalesce(r.rows_seen,0) = 0 then
      raise exception 'FAIL: service_role lost access to public.% (denied=%, rows=%)', r.relation, r.denied, r.rows_seen;
    end if;
  end loop;
  select rows_seen into svc from t_probe where phase='after' and role_name='service_role' and relation='ufc_referee_directory';
  perform pg_temp.ok(format('service_role still reads every referee view (directory: %s rows)', svc));
  perform pg_temp.ok('security_invoker resolves base tables as the caller: service_role reads through only because it holds SELECT on ufc_bout_results, ufc_bouts, ufc_events and ufc_fighters in its own right');
end $$;

-- 3. security_invoker is doing the work, not just the revoke.
--
--    The revoke and the flag are two independent layers, and a test that only
--    proves "anon is denied" cannot tell which one is holding. So this hands
--    anon back EVERY grant the view needs - on the view and on both referee
--    tables it joins - and reads it again. If only the grant had been closing
--    the hole, anon would now see the whole archive, which is exactly what a
--    future well-meaning "grant read access to the public catalogue" would do.
--
--    Note what happens on the way there: with the flag on, anon is refused on
--    ufc_referee_aliases before it ever reaches a row, because a
--    security_invoker view resolves its joins as the caller. That is the
--    defence-in-depth working, and it is why the grants have to be restored
--    deliberately to isolate the flag.
do $$
declare
  n int;
begin
  grant select on public.ufc_referee_bouts, public.ufc_referee_aliases,
    public.ufc_referee_profiles to anon;

  set local role anon;
  select count(*) into n from public.ufc_referee_bouts;
  reset role;

  if n <> 0 then
    raise exception 'FAIL: with every needed SELECT restored, anon read % rows - security_invoker is not in force', n;
  end if;
  perform pg_temp.ok('with every needed SELECT deliberately restored, anon still reads 0 rows: base-table RLS now applies through the view, so the flag is carrying the guarantee on its own');

  revoke select on public.ufc_referee_bouts, public.ufc_referee_aliases,
    public.ufc_referee_profiles from anon;
end $$;

-- 3b. And the same view, read the same way, WITHOUT the flag: the control.
--     Turning security_invoker off and back on again is the difference between
--     asserting the mechanism and demonstrating it.
do $$
declare
  n int;
begin
  alter view public.ufc_referee_bouts set (security_invoker = false);
  grant select on public.ufc_referee_bouts, public.ufc_referee_aliases,
    public.ufc_referee_profiles to anon;

  set local role anon;
  select count(*) into n from public.ufc_referee_bouts;
  reset role;

  if n = 0 then
    raise exception 'CONTROL FAILED: with security_invoker off, anon still read 0 rows. Something other than the flag is denying, and this test proves nothing about the flag.';
  end if;
  perform pg_temp.ok(format('control: with security_invoker OFF and the same grants, anon reads %s rows - the flag is the whole difference', n));

  revoke select on public.ufc_referee_bouts, public.ufc_referee_aliases,
    public.ufc_referee_profiles from anon;
  alter view public.ufc_referee_bouts set (security_invoker = true);
end $$;

-- 4. The views still declare the flag, and no mutation grant survives.
do $$
declare
  r record;
  bad text[];
begin
  for r in select c.relname, coalesce(c.reloptions::text,'') as reloptions
             from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='v'
              and c.relname in ('ufc_referee_stats','ufc_referee_directory','ufc_referee_bouts') loop
    if r.reloptions !~* 'security_invoker\s*=\s*true' then
      raise exception 'FAIL: view % does not carry security_invoker (reloptions=%)', r.relname, r.reloptions;
    end if;
  end loop;
  perform pg_temp.ok('all three views carry security_invoker = true in pg_class.reloptions');

  select array_agg(format('%s on %s to %s', privilege_type, table_name, grantee))
    into bad
    from information_schema.role_table_grants
   where table_schema='public'
     and table_name in ('ufc_referee_stats','ufc_referee_directory','ufc_referee_bouts','ufc_referee_profiles','ufc_referee_aliases')
     and grantee in ('anon','authenticated');
  if bad is not null then
    raise exception 'FAIL: public roles still hold privileges after the repair: %', array_to_string(bad, ', ');
  end if;
  perform pg_temp.ok('no privilege of any kind remains for anon or authenticated on the five referee relations');
end $$;

-- 5. The repair introduced no SECURITY DEFINER routine.
do $$
declare
  n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.prosecdef and p.proname ilike '%referee%';
  if n > 0 then raise exception 'FAIL: % referee SECURITY DEFINER routine(s) exist', n; end if;
  perform pg_temp.ok('no referee SECURITY DEFINER routine was introduced');
end $$;

-- ---------------------------------------------------------------------------
select phase, role_name, relation,
       case when denied then 'DENIED' else rows_seen::text || ' rows' end as result
  from t_probe order by phase desc, role_name, relation;

select line as assertion from t_note order by seq;

do $$
begin
  raise notice 'REFEREE VIEW SECURITY: ALL % ASSERTIONS PASSED', (select count(*) from t_note);
end $$;

drop table t_note;
drop table t_probe;
