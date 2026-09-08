-- Deterministic tests for migrations/010_ufc_model_predictions.sql.
--
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/model/schema_tests.sql
--
-- Run against a THROWAWAY database that already has 001, 009 and 010 applied.
-- Every test asserts on behaviour, not on the presence of a trigger: the claim
-- being made in public is that a locked pick cannot be rewritten, so the test
-- has to actually try to rewrite one.
--
-- The whole file runs inside a transaction that is rolled back, so it leaves no
-- rows behind even when pointed at a database that has some.

begin;

create temporary table t_fixture (k text primary key, v uuid);

do $$
declare
  ev uuid; b uuid; fa uuid; fb uuid;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('testaaaaaaaaaaa1', 'Test Fighter A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('testaaaaaaaaaaa2', 'Test Fighter B', 'http://example.invalid/b') returning id into fb;
  -- Dated in the future so a lock is legal during the test run.
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url)
    values ('testeeeeeeeeeee1', 'Test Event', (current_date + 30), 'http://example.invalid/e') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('testbbbbbbbbbbb1', ev, fa, fb, 1, 'http://example.invalid/b1') returning id into b;
  -- A second bout on an event that has already happened, for the late-lock test.
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url)
    values ('testeeeeeeeeeee2', 'Test Past Event', (current_date - 30), 'http://example.invalid/e2') returning id into ev;
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
    values ('testbbbbbbbbbbb2', ev, fa, fb, 1, 'http://example.invalid/b2');

  insert into public.ufc_model_versions
    (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256)
  values
    ('test-model-v1', 'test', 'test-features-v1', 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 'deadbeef');

  insert into t_fixture values ('fa', fa), ('fb', fb), ('bout_future', b);
end $$;

-- Small helper: run a statement, assert it fails.
create or replace function pg_temp.must_fail(sql text, what text)
returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: % was allowed and should not have been', what;
exception
  when restrict_violation or check_violation then
    raise notice 'pass: % rejected', what;
end $$;

create or replace function pg_temp.must_succeed(sql text, what text)
returns void language plpgsql as $$
begin
  execute sql;
  raise notice 'pass: % allowed', what;
end $$;

do $$
declare
  fa uuid := (select v from t_fixture where k = 'fa');
  fb uuid := (select v from t_fixture where k = 'fb');
  bout uuid := (select v from t_fixture where k = 'bout_future');
  past_bout uuid := (select id from public.ufc_bouts where ufcstats_id = 'testbbbbbbbbbbb2');
  ev uuid := (select event_id from public.ufc_bouts where id = (select v from t_fixture where k = 'bout_future'));
  pid uuid;
  late_pid uuid;
  live_wins int;
  live_hit numeric;
begin
  -- 1. A draft prediction is writable.
  insert into public.ufc_model_predictions
    (bout_id, event_id, fighter_a_id, fighter_b_id, model_version, feature_version,
     prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
  values
    (bout, ev, fa, fb, 'test-model-v1', 'test-features-v1',
     0.618, 0.382, fa, 0.618, '60-65', '{"age_diff_years": -2.1}'::jsonb)
  returning id into pid;

  perform pg_temp.must_succeed(
    format('update public.ufc_model_predictions set prob_a = 0.60, prob_b = 0.40, pick_probability = 0.60 where id = %L', pid),
    'revising an UNLOCKED prediction');

  -- 2. Probabilities must be complementary and the pick must match them.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.70 where id = %L', pid),
    'probabilities that do not sum to one');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set pick_fighter_id = %L where id = %L', fb, pid),
    'a pick naming the corner the model made an underdog');

  -- 3. Lock it. From here the row is history.
  update public.ufc_model_predictions set locked_at = now() where id = pid;

  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.55, prob_b = 0.45, pick_probability = 0.55 where id = %L', pid),
    'rewriting the probability of a LOCKED prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set pick_fighter_id = %L, pick_probability = 0.60 where id = %L', fb, pid),
    'switching the pick of a LOCKED prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set feature_vector = ''{}''::jsonb where id = %L', pid),
    'rewriting the feature vector of a LOCKED prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set model_version = ''other'' where id = %L', pid),
    'restamping a LOCKED prediction with another model version');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() + interval ''1 day'' where id = %L', pid),
    'moving locked_at');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = null where id = %L', pid),
    'unlocking a locked prediction');
  perform pg_temp.must_fail(
    format('delete from public.ufc_model_predictions where id = %L', pid),
    'deleting a LOCKED prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set model_edge_pts = 99 where id = %L', pid),
    'restating the market edge of a LOCKED prediction');

  -- 4. Grading is permitted exactly once.
  perform pg_temp.must_succeed(
    format('update public.ufc_model_predictions set result = ''WIN'', result_winner_id = %L, graded_at = now(), graded_by = ''test'' where id = %L', fa, pid),
    'grading a locked prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set result = ''LOSS'' where id = %L', pid),
    'regrading a graded prediction');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set result_winner_id = %L where id = %L', fb, pid),
    'changing the recorded winner');

  -- 5. A pick cannot be locked once its event has happened. Both shapes are
  --    tested: the normal publishing path, which INSERTS a row with locked_at
  --    already set, and the two-step draft-then-lock UPDATE. The insert form is
  --    the one that matters and the one an update-only trigger would miss.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, locked_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb, now())
    $f$, past_bout, fa, fb, fa),
    'INSERTING an already-locked prediction after its event date');

  insert into public.ufc_model_predictions
    (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
     prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
  values (past_bout, fa, fb, 'test-model-v1', 'test-features-v1', 0.55, 0.45, fa, 0.55, '55-60', '{}'::jsonb)
  returning id into late_pid;
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() where id = %L', late_pid),
    'locking an existing draft after its event date');

  -- A lock cannot be dated in the future either.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() + interval ''10 days'' where id = %L', late_pid),
    'locking a prediction with a future timestamp');

  -- 6. Grading requires a lock.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector,
         result, graded_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb, 'WIN', now())
    $f$, past_bout, fa, fb, fa),
    'grading a prediction that was never locked');

  -- 7. The live table cannot hold a backtest row, and vice versa.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set record_class = ''BACKTEST'' where id = %L', pid),
    'relabelling a live prediction as a backtest');

  -- 8. A released model version is frozen.
  perform pg_temp.must_fail(
    'update public.ufc_model_versions set coefficients = ''{"x": 1}''::jsonb where model_version = ''test-model-v1''',
    'editing the coefficients of a released model version');
  perform pg_temp.must_fail(
    'delete from public.ufc_model_versions where model_version = ''test-model-v1''',
    'deleting a released model version');
  perform pg_temp.must_succeed(
    'update public.ufc_model_versions set status = ''live'' where model_version = ''test-model-v1''',
    'promoting a model version to live');

  -- 9. The live record view reflects only what was actually locked and graded.
  select wins, hit_rate into live_wins, live_hit
    from public.ufc_model_live_record where model_version = 'test-model-v1';
  if live_wins <> 1 or live_hit <> 1 then
    raise exception 'FAIL: live record view reported wins=% hit_rate=%, expected 1 and 1', live_wins, live_hit;
  end if;
  raise notice 'pass: live record view reports 1-0 from one graded locked pick';

end $$;

-- 10. A registered model that has published nothing produces NO ROW in the live
--     record - not a zeroed row. "No picks yet" and "0 for 0" are different
--     statements, and a tracker that cannot tell them apart will eventually
--     show a fabricated record for a model that never ran.
do $$
declare
  n int;
begin
  insert into public.ufc_model_versions
    (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256)
  values
    ('test-model-v2', 'test', 'test-features-v1', 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 'cafebabe');

  select count(*) into n from public.ufc_model_live_record where model_version = 'test-model-v2';
  if n <> 0 then raise exception 'FAIL: live record invented a row for a model with no predictions'; end if;

  select count(*) into n from public.ufc_model_live_recent where model_version = 'test-model-v2';
  if n <> 0 then raise exception 'FAIL: last-30 view invented a row for a model with no predictions'; end if;

  select count(*) into n from public.ufc_model_backtest_record;
  if n <> 0 then raise exception 'FAIL: backtest record is not empty on a fresh schema'; end if;

  raise notice 'pass: a model that has published nothing has an empty record, not a zeroed one';
  raise notice 'ALL SCHEMA TESTS PASSED';
end $$;

rollback;
