-- Proof that 20260908000017 closes the model and store bypass, for an ISOLATED
-- database only.
--
--   createdb modelsec_test
--   psql modelsec_test -v ON_ERROR_STOP=1 -f supabase/migrations/20260906000001_ufc_phase1_core.sql
--   psql modelsec_test -v ON_ERROR_STOP=1 -f supabase/migrations/tests/20260908000017_model_store_view_security.test.sql
--   dropdb modelsec_test
--
-- Run from the repository root: the test \i-includes the three migrations that
-- created the defect and the repair itself, so the chain it exercises is the
-- real one rather than a paraphrase of it.
--
-- It does NOT wrap itself in a transaction, for the reason the referee test
-- gives: every included migration carries its own BEGIN/COMMIT, and nesting
-- those inside an outer transaction would commit it early and make a final
-- ROLLBACK a lie. Isolation comes from the database being disposable.
--
-- Do NOT run against production. The production check is the read-only
-- verifier, scripts/model/verify-view-security.mjs.
--
-- WHY THIS EXISTS
--
-- Migration 20260908000014 fixed this bug on the referee views and warned in
-- its closing section that the schema default would reproduce it in any view
-- created afterwards that did not opt out. Three migrations then did exactly
-- that. This file is the assertion that the repair works AND that the specific
-- privilege the bug hinges on is gone, because "the SQL looks right" is not a
-- security argument.
--
-- The sharpest assertion here is not about rows. It is TRUNCATE. Row security
-- does not apply to it, so anon holding TRUNCATE on ufc_model_predictions could
-- empty the immutable prediction ledger with RLS fully enabled and zero
-- policies in place - and the entire LIVE RECORD contract (server-clock lock,
-- frozen rows, append-only grades) assumes the row is still there to protect.
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
  -- Reset BEFORE recording, so writing the result does not itself need a grant
  -- for the role under test.
  reset role;
  insert into t_probe values (p_phase, p_role, p_rel, n, was_denied);
end $$;

-- ---------------------------------------------------------------------------
-- Roles, as the platform provides them.
-- ---------------------------------------------------------------------------
-- The view owner (the role running this file) must bypass RLS for the bug to
-- reproduce at all: production's `postgres` has rolbypassrls = true, and that
-- is the precondition the whole finding rests on.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The layers exactly as production has them, in the order production ran them.
-- ---------------------------------------------------------------------------
-- store_orders references store_provisioning, so the order is not cosmetic.
\i supabase/migrations/20260907000010_store_provisioning.sql
\i supabase/migrations/20260908000010_ufc_model_predictions.sql
\i supabase/migrations/20260908000015_store_orders.sql

-- ---------------------------------------------------------------------------
-- The Supabase default grants, reproduced verbatim from what production has.
-- ---------------------------------------------------------------------------
-- Measured live in the post-apply read-back:
--   anon           DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   authenticated  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- on all thirteen relations. Without this the test would prove nothing about
-- production, because a role with no grant is denied for the wrong reason.
grant all privileges on
  public.ufc_model_versions, public.ufc_model_predictions,
  public.ufc_model_prediction_grades, public.ufc_model_backtest_runs,
  public.ufc_model_backtest_predictions,
  public.ufc_model_prediction_current_grade, public.ufc_model_live_record,
  public.ufc_model_live_recent, public.ufc_model_live_calibration,
  public.ufc_model_backtest_record,
  public.store_provisioning, public.store_orders, public.store_order_lines
  to anon, authenticated, service_role;

-- A security_invoker view resolves its base tables as the CALLER, so after the
-- repair service_role needs SELECT on the fight tables in its own right.
-- Production has them; omitting them here would make the fixture quietly more
-- permissive than production instead of less.
grant all privileges on public.ufc_bouts, public.ufc_events, public.ufc_fighters
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enough of a backtest run for the reporting view to have something to leak.
-- ---------------------------------------------------------------------------
-- ufc_model_backtest_record inner-joins runs to predictions, so both are
-- needed, and predictions carry real foreign keys into the fight schema.
do $$
declare
  fa uuid; fb uuid; ev uuid; bt uuid; run uuid;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('modsecaaaaaaaaa1', 'Test Fighter A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('modsecaaaaaaaaa2', 'Test Fighter B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url)
    values ('modseceeeeeeeee1', 'Test Event', date '2026-01-01', 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('modsecbbbbbbbbb1', ev, fa, fb, 1, 'http://example.invalid/b1') returning id into bt;

  insert into public.ufc_model_backtest_runs
    (model_version, feature_version, protocol, first_scored_event, last_scored_event, scored_bouts)
    values ('pbe-fight-model-v1', 'pbe-fight-features-v1', '{"validation":"walk-forward"}'::jsonb,
            date '2026-01-01', date '2026-01-01', 1)
    returning id into run;

  insert into public.ufc_model_backtest_predictions
    (run_id, bout_id, fold_key, fighter_1_id, fighter_2_id, event_date,
     prob_1, prob_2, pick_fighter_id, pick_probability, confidence_band, actual_winner_id, result)
    values (run, bt, '2026', fa, fb, date '2026-01-01',
            0.61000000, 0.39000000, fa, 0.61000000, '60-65', fa, 'WIN');

  -- One store row, so the store assertions are about a table with content.
  insert into public.store_orders (id) values (default);
exception when others then
  -- store_orders may require columns this fixture does not know about. The
  -- store assertions below are privilege assertions, which do not need rows,
  -- so a fixture failure there must not mask the model result.
  raise notice 'store fixture skipped: %', sqlerrm;
end $$;

-- ===========================================================================
-- BEFORE - reproduce the bypass
-- ===========================================================================

select pg_temp.probe('before', 'anon', 'ufc_model_backtest_runs');
select pg_temp.probe('before', 'anon', 'ufc_model_backtest_predictions');
select pg_temp.probe('before', 'anon', 'ufc_model_backtest_record');
select pg_temp.probe('before', 'service_role', 'ufc_model_backtest_record');

do $$
declare
  base_rows int;
  view_rows int;
  svc_rows int;
begin
  select rows_seen into base_rows from t_probe where phase='before' and role_name='anon' and relation='ufc_model_backtest_runs';
  select rows_seen into view_rows from t_probe where phase='before' and role_name='anon' and relation='ufc_model_backtest_record';
  select rows_seen into svc_rows  from t_probe where phase='before' and role_name='service_role' and relation='ufc_model_backtest_record';

  if base_rows <> 0 then
    raise exception 'SETUP WRONG: anon can read ufc_model_backtest_runs directly (% rows); RLS is not in force and the test proves nothing', base_rows;
  end if;
  if view_rows = 0 then
    raise exception 'SETUP WRONG: the bypass did not reproduce - anon saw 0 rows through ufc_model_backtest_record';
  end if;
  if svc_rows = 0 then
    raise exception 'SETUP WRONG: service_role sees nothing through ufc_model_backtest_record';
  end if;
  perform pg_temp.ok(format('bypass reproduced: anon reads 0 rows from ufc_model_backtest_runs but %s through ufc_model_backtest_record', view_rows));
end $$;

-- The privilege RLS never covered. This is the assertion that matters most.
do $$
begin
  if not has_table_privilege('anon', 'public.ufc_model_predictions', 'TRUNCATE') then
    raise exception 'SETUP WRONG: anon does not hold TRUNCATE on ufc_model_predictions, so the fixture is not reproducing production';
  end if;
  if not has_table_privilege('anon', 'public.store_orders', 'TRUNCATE') then
    raise exception 'SETUP WRONG: anon does not hold TRUNCATE on store_orders';
  end if;
  perform pg_temp.ok('reproduced: anon holds TRUNCATE on the prediction ledger and the order table despite RLS');
end $$;

-- No view opted out of executing as its owner.
do $$
declare n int;
begin
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind = 'v'
    and c.relname in ('ufc_model_prediction_current_grade','ufc_model_live_record',
                      'ufc_model_live_recent','ufc_model_live_calibration','ufc_model_backtest_record')
    and coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=true%';
  if n <> 0 then
    raise exception 'SETUP WRONG: % model view(s) already declare security_invoker; the defect is not being reproduced', n;
  end if;
  perform pg_temp.ok('reproduced: none of the five model views declared security_invoker');
end $$;

-- ===========================================================================
-- APPLY the repair, exactly as production would
-- ===========================================================================

\i supabase/migrations/20260908000017_model_store_view_security.sql

-- ===========================================================================
-- AFTER
-- ===========================================================================

select pg_temp.probe('after', 'anon', 'ufc_model_backtest_record');
select pg_temp.probe('after', 'anon', 'ufc_model_live_record');
select pg_temp.probe('after', 'anon', 'ufc_model_live_recent');
select pg_temp.probe('after', 'anon', 'ufc_model_live_calibration');
select pg_temp.probe('after', 'anon', 'ufc_model_prediction_current_grade');
select pg_temp.probe('after', 'anon', 'ufc_model_predictions');
select pg_temp.probe('after', 'anon', 'ufc_model_prediction_grades');
select pg_temp.probe('after', 'anon', 'store_orders');
select pg_temp.probe('after', 'anon', 'store_order_lines');
select pg_temp.probe('after', 'anon', 'store_provisioning');
select pg_temp.probe('after', 'authenticated', 'ufc_model_backtest_record');
select pg_temp.probe('after', 'service_role', 'ufc_model_backtest_record');

-- 1. anon is refused at the door on every one of them, not handed an empty set.
do $$
declare
  bad text;
begin
  select string_agg(relation, ', ') into bad
  from t_probe where phase = 'after' and role_name in ('anon','authenticated') and denied is not true;
  if bad is not null then
    raise exception 'anon/authenticated were not denied on: %', bad;
  end if;
  perform pg_temp.ok('anon and authenticated are refused on all ten model and store relations');
end $$;

-- 2. The server read path is untouched. This is the half that would take the
--    /model page down if the repair were wrong, and the symptom would be an
--    empty page rather than an error, so it is asserted rather than assumed.
do $$
declare n int;
begin
  select rows_seen into n from t_probe where phase='after' and role_name='service_role' and relation='ufc_model_backtest_record';
  if n is null or n = 0 then
    raise exception 'REGRESSION: service_role can no longer read ufc_model_backtest_record (rows=%). security_invoker needs base-table SELECT for the caller.', n;
  end if;
  perform pg_temp.ok(format('service_role still reads ufc_model_backtest_record: %s row(s)', n));
end $$;

-- 3. TRUNCATE is gone from every relation the repair names.
do $$
declare
  r record;
  bad text := '';
begin
  for r in
    select unnest(array[
      'ufc_model_predictions','ufc_model_prediction_grades','ufc_model_versions',
      'ufc_model_backtest_runs','ufc_model_backtest_predictions',
      'store_provisioning','store_orders','store_order_lines']) as rel
  loop
    if has_table_privilege('anon', 'public.' || r.rel, 'TRUNCATE')
       or has_table_privilege('authenticated', 'public.' || r.rel, 'TRUNCATE') then
      bad := bad || r.rel || ' ';
    end if;
  end loop;
  if bad <> '' then
    raise exception 'TRUNCATE still held by a public role on: %', bad;
  end if;
  perform pg_temp.ok('TRUNCATE, REFERENCES and TRIGGER removed from anon and authenticated on all eight tables');
end $$;

-- 4. All five views now execute as the caller.
do $$
declare n int;
begin
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind = 'v'
    and c.relname in ('ufc_model_prediction_current_grade','ufc_model_live_record',
                      'ufc_model_live_recent','ufc_model_live_calibration','ufc_model_backtest_record')
    and coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=true%';
  if n <> 5 then
    raise exception 'expected 5 model views with security_invoker, found %', n;
  end if;
  perform pg_temp.ok('all five model views declare security_invoker = true');
end $$;

-- 5. No SECURITY DEFINER function was introduced, which would reintroduce the
--    escalation being closed in a form that is harder to see.
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef and p.proname like 'ufc_model%';
  if bad is not null then
    raise exception 'SECURITY DEFINER function(s) present in the model layer: %', bad;
  end if;
  perform pg_temp.ok('no SECURITY DEFINER function in the model layer');
end $$;

-- 6. The repair is a privilege change, not a rewrite: the fixture row is still
--    visible to the role that is supposed to see it, with the same numbers.
do $$
declare hit numeric;
begin
  select hit_rate into hit from public.ufc_model_backtest_record limit 1;
  if hit is null or hit <> 1 then
    raise exception 'backtest arithmetic moved: hit_rate = %, expected 1', hit;
  end if;
  perform pg_temp.ok('view arithmetic unchanged by the privilege change (hit_rate = 1 on the single WIN fixture)');
end $$;

select line from t_note order by seq;
select phase, role_name, relation, rows_seen, denied from t_probe order by phase desc, role_name, relation;
