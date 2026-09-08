-- Tests for migration 011, for an ISOLATED database only.
--
--   createdb pbe_model_test
--   psql pbe_model_test -v ON_ERROR_STOP=1 -f migrations/001_ufc_phase1_core.sql
--   psql pbe_model_test -v ON_ERROR_STOP=1 -f migrations/009_ufc_market.sql
--   psql pbe_model_test -v ON_ERROR_STOP=1 -f migrations/011_ufc_model_predictions.sql
--   psql pbe_model_test -v ON_ERROR_STOP=1 -f migrations/tests/011_ufc_model_predictions.test.sql
--
-- Do NOT run this against the production project. It inserts and mutates rows.
--
-- Every test asserts on BEHAVIOUR, not on the presence of a trigger. The claim
-- being made in public is that a locked pick was fixed before the fight and
-- cannot be rewritten; the only thing that can establish that is Postgres
-- refusing to rewrite one. Each expected failure also asserts on the REASON, so
-- a test cannot pass because something unrelated broke.
--
-- The whole file runs in a transaction that is rolled back.

\set ON_ERROR_STOP on
begin;

create temporary table t_fixture (k text primary key, v uuid);
create temporary table t_note (seq serial, line text);
create temporary sequence t_seq;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function pg_temp.must_fail(sql text, what text, expect text default null)
returns void language plpgsql as $$
declare
  msg text;
begin
  execute sql;
  raise exception 'FAIL: % was ALLOWED and should not have been', what;
exception
  when restrict_violation or check_violation or no_data_found or unique_violation or not_null_violation then
    get stacked diagnostics msg = message_text;
    if expect is not null and position(lower(expect) in lower(msg)) = 0 then
      raise exception 'FAIL: % was rejected for the wrong reason. Expected to see %, got: %', what, quote_literal(expect), msg;
    end if;
    insert into t_note (line) values (format('pass: %s rejected (%s)', what, left(msg, 88)));
end $$;

create or replace function pg_temp.must_succeed(sql text, what text)
returns void language plpgsql as $$
begin
  execute sql;
  insert into t_note (line) values (format('pass: %s allowed', what));
end $$;

create or replace function pg_temp.ok(what text)
returns void language plpgsql as $$
begin
  insert into t_note (line) values (format('pass: %s', what));
end $$;

-- ---------------------------------------------------------------------------
-- fixtures
-- ---------------------------------------------------------------------------
-- Event dates are expressed in UTC terms, because the lock cutoff is the start
-- of the event's UTC day. Deriving them from the server's local current_date
-- would make these tests pass or fail depending on the machine's timezone.

do $$
declare
  fa uuid; fb uuid; fc uuid;
  ev_future uuid; ev_tomorrow uuid; ev_today uuid; ev_past uuid; ev_undated uuid;
  utc_today date := (now() at time zone 'UTC')::date;
begin
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('testaaaaaaaaaaa1', 'Test Fighter A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('testaaaaaaaaaaa2', 'Test Fighter B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_fighters (ufcstats_id, name, source_url)
    values ('testaaaaaaaaaaa3', 'Test Fighter C', 'http://example.invalid/c') returning id into fc;

  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values
    ('testeeeeeeeeeee1', 'Test Event (30 days out)',  utc_today + 30, 'http://example.invalid/e1') returning id into ev_future;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values
    ('testeeeeeeeeeee2', 'Test Event (tomorrow UTC)', utc_today + 1,  'http://example.invalid/e2') returning id into ev_tomorrow;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values
    ('testeeeeeeeeeee3', 'Test Event (today UTC)',    utc_today,      'http://example.invalid/e3') returning id into ev_today;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values
    ('testeeeeeeeeeee4', 'Test Event (30 days ago)',  utc_today - 30, 'http://example.invalid/e4') returning id into ev_past;
  insert into public.ufc_events (ufcstats_id, name, event_date, source_url) values
    ('testeeeeeeeeeee5', 'Test Event (undated)',      null,           'http://example.invalid/e5') returning id into ev_undated;

  insert into public.ufc_model_versions
    (model_version, model_family, feature_version, algorithm, validation, trained_at, coefficients, feature_scale, spec_sha256)
  values
    ('test-model-v1', 'test', 'test-features-v1', 'ridge logistic', 'walk-forward', now(), '{}'::jsonb, '{}'::jsonb, 'deadbeef');

  insert into t_fixture values
    ('fa', fa), ('fb', fb), ('fc', fc),
    ('ev_future', ev_future), ('ev_tomorrow', ev_tomorrow), ('ev_today', ev_today),
    ('ev_past', ev_past), ('ev_undated', ev_undated);
end $$;

-- Each draft gets its own bout on the named event, so no test can collide with
-- another through the one-prediction-per-bout constraint.
create or replace function pg_temp.new_bout(p_event uuid)
returns uuid language plpgsql as $$
declare
  new_id uuid;
  fa uuid := (select v from t_fixture where k = 'fa');
  fb uuid := (select v from t_fixture where k = 'fb');
begin
  insert into public.ufc_bouts (ufcstats_id, event_id, fighter_a_id, fighter_b_id, bout_order, source_url)
  values ('testbout' || lpad(nextval('t_seq')::text, 8, '0'), p_event, fa, fb, 1, 'http://example.invalid/bout')
  returning id into new_id;
  return new_id;
end $$;

create or replace function pg_temp.draft(p_event uuid, p_prob numeric default 0.618, p_band text default '60-65')
returns uuid language plpgsql as $$
declare
  new_id uuid;
  fa uuid := (select v from t_fixture where k = 'fa');
  fb uuid := (select v from t_fixture where k = 'fb');
begin
  insert into public.ufc_model_predictions
    (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
     prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector)
  values
    (pg_temp.new_bout(p_event), fa, fb, 'test-model-v1', 'test-features-v1',
     p_prob, 1 - p_prob, fa, p_prob, p_band, '{"age_diff_years": -2.1}'::jsonb)
  returning id into new_id;
  return new_id;
end $$;

-- ===========================================================================
-- 1. Coherence: a pick must agree with its own numbers
-- ===========================================================================

do $$
declare
  fb uuid := (select v from t_fixture where k = 'fb');
  pid uuid := pg_temp.draft((select v from t_fixture where k = 'ev_future'));
begin
  perform pg_temp.must_succeed(
    format('update public.ufc_model_predictions set prob_a = 0.60, prob_b = 0.40, pick_probability = 0.60 where id = %L', pid),
    'revising an UNLOCKED prediction');

  -- The write gate runs before the table CHECKs, so a lone prob_a change is
  -- caught by the coherence rule first. Both rejections matter, so both are
  -- asserted: an incoherent pick, then non-complementary probabilities that the
  -- pick nonetheless agrees with.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.70 where id = %L', pid),
    'a pick_probability that disagrees with the picked fighter''s probability', 'does not match');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.70, prob_b = 0.40, pick_probability = 0.70 where id = %L', pid),
    'probabilities that do not sum to one', 'complementary');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set pick_fighter_id = %L, pick_probability = 0.40 where id = %L', fb, pid),
    'a pick naming the corner the model made an underdog', 'underdog');

  delete from public.ufc_model_predictions where id = pid;  -- unlocked, so removable
  perform pg_temp.ok('an UNLOCKED draft can be discarded');
end $$;

-- ===========================================================================
-- 2. THE LOCK IS THE DATABASE'S, NOT THE CALLER'S
-- ===========================================================================

do $$
declare
  fa uuid := (select v from t_fixture where k = 'fa');
  fb uuid := (select v from t_fixture where k = 'fb');
  ev_future uuid := (select v from t_fixture where k = 'ev_future');
  ev_past uuid := (select v from t_fixture where k = 'ev_past');
  ev_today uuid := (select v from t_fixture where k = 'ev_today');
  ev_tomorrow uuid := (select v from t_fixture where k = 'ev_tomorrow');
  pid uuid;
  locked timestamptz;
  created timestamptz;
  before_ts timestamptz;
  after_ts timestamptz;
begin
  -- 2a. locked_at is not accepted on INSERT, in any form.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, locked_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb, now())
    $f$, pg_temp.new_bout(ev_future), fa, fb, fa),
    'INSERTING a prediction that is already locked', 'cannot be set on insert');

  -- 2b. THE FORGERY THE PREVIOUS GATE ALLOWED: a row inserted after the event
  --     carrying a locked_at backdated to before it. Rejected at the door.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, locked_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb,
              now() - interval '31 days')
    $f$, pg_temp.new_bout(ev_past), fa, fb, fa),
    'INSERTING a post-event prediction with a BACKDATED locked_at', 'cannot be set on insert');

  -- 2c. A locked_at in the future is refused for the same reason.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, locked_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb,
              now() + interval '10 days')
    $f$, pg_temp.new_bout(ev_future), fa, fb, fa),
    'INSERTING a prediction with a FUTURE locked_at', 'cannot be set on insert');

  -- 2d. generated_at cannot be in the future either.
  perform pg_temp.must_fail(
    format($f$
      insert into public.ufc_model_predictions
        (bout_id, fighter_a_id, fighter_b_id, model_version, feature_version,
         prob_a, prob_b, pick_fighter_id, pick_probability, confidence_band, feature_vector, generated_at)
      values (%L, %L, %L, 'test-model-v1', 'test-features-v1', 0.55, 0.45, %L, 0.55, '55-60', '{}'::jsonb,
              now() + interval '1 day')
    $f$, pg_temp.new_bout(ev_future), fa, fb, fa),
    'a generated_at in the future', 'future');

  -- 2e. created_at is the server's, whatever the caller says.
  pid := pg_temp.draft(ev_future);
  select created_at into created from public.ufc_model_predictions where id = pid;
  if created > now() + interval '1 minute' or created < now() - interval '1 minute' then
    raise exception 'FAIL: created_at % is not the server clock', created;
  end if;
  perform pg_temp.ok('created_at is stamped by the server');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set created_at = now() - interval ''400 days'' where id = %L', pid),
    'rewriting created_at', 'server-controlled');

  -- 2f. locked_at cannot be set by a plain UPDATE. The publishing function is
  --     the only door.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() where id = %L', pid),
    'locking with a direct UPDATE instead of the publish function', 'ufc_model_publish_prediction');

  -- 2g. THE DECISIVE ONE. A caller who reaches around the function by setting
  --     the guard flag themselves STILL cannot choose the timestamp: the
  --     trigger discards it and stamps the server clock.
  before_ts := clock_timestamp();
  perform set_config('pbe.model_publishing', 'on', true);
  update public.ufc_model_predictions set locked_at = timestamptz '2001-01-01 00:00:00+00' where id = pid;
  perform set_config('pbe.model_publishing', 'off', true);
  after_ts := clock_timestamp();
  select locked_at into locked from public.ufc_model_predictions where id = pid;
  if locked = timestamptz '2001-01-01 00:00:00+00' then
    raise exception 'FAIL: a caller-supplied locked_at was stored verbatim';
  end if;
  if locked < before_ts or locked > after_ts then
    raise exception 'FAIL: locked_at % is outside the transaction window [%, %]', locked, before_ts, after_ts;
  end if;
  perform pg_temp.ok('a spoofed locked_at is DISCARDED and replaced with the server clock');

  -- 2h. Once locked, nothing on the row may change. Anything at all.
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.55, prob_b = 0.45, pick_probability = 0.55 where id = %L', pid),
    'rewriting the probability of a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set pick_fighter_id = %L, pick_probability = 0.45 where id = %L', fb, pid),
    'switching the pick of a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set feature_vector = ''{}''::jsonb where id = %L', pid),
    'rewriting the feature vector of a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set model_version = ''other'' where id = %L', pid),
    'restamping a LOCKED prediction with another model version', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set model_edge_pts = 99 where id = %L', pid),
    'restating the market edge of a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() where id = %L', pid),
    'moving locked_at on a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = null where id = %L', pid),
    'unlocking a LOCKED prediction', 'locked');
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set record_class = ''BACKTEST'' where id = %L', pid),
    'relabelling a LOCKED live prediction as a backtest', 'locked');
  perform pg_temp.must_fail(
    format('delete from public.ufc_model_predictions where id = %L', pid),
    'deleting a LOCKED prediction', 'cannot be deleted');

  -- Even with the publishing guard held open by the caller.
  perform set_config('pbe.model_publishing', 'on', true);
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set prob_a = 0.9, prob_b = 0.1, pick_probability = 0.9 where id = %L', pid),
    'rewriting a LOCKED prediction while holding the publishing guard', 'locked');
  perform set_config('pbe.model_publishing', 'off', true);

  -- 2i. The publish function refuses a second lock.
  perform pg_temp.must_fail(
    format('select public.ufc_model_publish_prediction(%L)', pid),
    'publishing an already-locked prediction', 'already locked');

  insert into t_fixture values ('locked_pid', pid);

  -- 2j. THE LOCK WINDOW. Same-day is refused: an event dated today in UTC may
  --     already have had bouts finish.
  pid := pg_temp.draft(ev_today, 0.57, '55-60');
  perform pg_temp.must_fail(
    format('select public.ufc_model_publish_prediction(%L)', pid),
    'publishing on the event''s own UTC date, when a bout may already have finished', 'lock window');

  -- 2k. After the event, obviously refused - through the function, and through
  --     the spoofed-guard path, which the window rejects rather than the guard.
  pid := pg_temp.draft(ev_past, 0.57, '55-60');
  perform pg_temp.must_fail(
    format('select public.ufc_model_publish_prediction(%L)', pid),
    'publishing 30 days AFTER the event', 'lock window');
  perform set_config('pbe.model_publishing', 'on', true);
  perform pg_temp.must_fail(
    format('update public.ufc_model_predictions set locked_at = now() where id = %L', pid),
    'locking a past event by spoofing the publishing guard', 'lock window');
  perform set_config('pbe.model_publishing', 'off', true);

  -- 2l. LEGITIMATE PUBLICATION, the day before. This must work, or the schema
  --     is merely obstructive rather than safe.
  pid := pg_temp.draft(ev_tomorrow, 0.66, '65-70');
  before_ts := clock_timestamp();
  perform pg_temp.must_succeed(
    format('select public.ufc_model_publish_prediction(%L)', pid),
    'publishing the day before the event');
  select locked_at into locked from public.ufc_model_predictions where id = pid;
  if locked is null or locked < before_ts or locked > clock_timestamp() then
    raise exception 'FAIL: locked_at % was not stamped from the server clock', locked;
  end if;
  perform pg_temp.ok('the stored lock time is the server clock at the moment of publication');

  -- 2m. A publisher may demand MORE lead than the schema floor, never less.
  pid := pg_temp.draft(ev_tomorrow, 0.61, '60-65');
  perform pg_temp.must_fail(
    format('select public.ufc_model_publish_prediction(%L, interval ''30 days'')', pid),
    'publishing with a 30-day lead requirement one day out', 'lock window');
  perform pg_temp.must_succeed(
    format('select public.ufc_model_publish_prediction(%L, interval ''-90 days'')', pid),
    'a negative lead requirement, which cannot widen the window past the floor');

  -- 2n. A bout on an undated event can never be locked: there is nothing to
  --     prove the pick was pre-fight against.
  pid := pg_temp.draft((select v from t_fixture where k = 'ev_undated'), 0.58, '55-60');
  perform pg_temp.must_fail(
    format('select public.ufc_model_publish_prediction(%L)', pid),
    'publishing a pick for an undated event', 'no dated event');
end $$;

-- ===========================================================================
-- 3. GRADING: append-only, correctable, and never the prediction
-- ===========================================================================

do $$
declare
  fa uuid := (select v from t_fixture where k = 'fa');
  fb uuid := (select v from t_fixture where k = 'fb');
  fc uuid := (select v from t_fixture where k = 'fc');
  ev_tomorrow uuid := (select v from t_fixture where k = 'ev_tomorrow');
  pid uuid := (select v from t_fixture where k = 'locked_pid');
  draft_pid uuid;
  g1 uuid; g2 uuid;
  cur record;
  rec record;
  probs record;
begin
  -- 3a. An unlocked draft cannot be graded. It was never part of the record.
  draft_pid := pg_temp.draft(ev_tomorrow, 0.52, '50-55');
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source)
              values (%L, 'WIN', %L, 'test')$f$, draft_pid, fa),
    'grading an UNLOCKED draft', 'never locked');

  -- 3b. A locked pick whose bout has no stored result cannot be graded either.
  --     Elapsed time is not evidence that a fight has finished; a result is.
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source)
              values (%L, 'WIN', %L, 'test')$f$, pid, fa),
    'grading a locked pick whose bout has no stored result', 'no stored result');

  -- The fight happens.
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, result_source, source_url)
    select p.bout_id, fa, 'DEC_U', 'Decision - Unanimous', 3, 300, 'ufcstats', 'http://example.invalid/r1'
      from public.ufc_model_predictions p where p.id = pid;

  -- 3c. A grade may not contradict itself or the bout.
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source)
              values (%L, 'WIN', %L, 'test')$f$, pid, fb),
    'a WIN grade naming the opponent as the winner', 'names');
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source)
              values (%L, 'WIN', %L, 'test')$f$, pid, fc),
    'a WIN grade naming a fighter who was not in the bout', 'names');
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, source)
              values (%L, 'DRAW', %L, 'test')$f$, pid, fa),
    'a DRAW grade that also names a winner');
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, source)
              values (%L, 'WIN', 'test')$f$, pid),
    'a WIN grade with no winner named');
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, source)
              values (%L, 'VOID', 'test')$f$, pid),
    'voiding a bout that has a stored result', 'cannot be graded VOID');

  -- 3d. The real first grade.
  insert into public.ufc_model_prediction_grades (prediction_id, result, winner_id, method, source, source_ref, graded_by)
    values (pid, 'WIN', fa, 'DEC_U', 'ufc_bout_results', 'http://example.invalid/r1', 'test')
    returning id into g1;
  select * into rec from public.ufc_model_prediction_grades where id = g1;
  if rec.revision <> 1 or rec.supersedes_grade_id is not null then
    raise exception 'FAIL: first grade should be revision 1 superseding nothing, got revision % superseding %',
      rec.revision, rec.supersedes_grade_id;
  end if;
  perform pg_temp.ok('the first grade is revision 1 and supersedes nothing');

  -- 3e. A grade is never edited or removed.
  perform pg_temp.must_fail(
    format('update public.ufc_model_prediction_grades set result = ''LOSS'' where id = %L', g1),
    'editing an existing grade', 'cannot be edited');
  perform pg_temp.must_fail(
    format('delete from public.ufc_model_prediction_grades where id = %L', g1),
    'deleting a grade', 'cannot be deleted');

  -- 3f. A correction must say why.
  perform pg_temp.must_fail(
    format($f$insert into public.ufc_model_prediction_grades (prediction_id, result, source)
              values (%L, 'NC', 'commission')$f$, pid),
    'revising a grade without a reason', 'must state why');

  -- 3g. THE POINT OF ALL THIS: the result is overturned to a no-contest.
  insert into public.ufc_model_prediction_grades
    (prediction_id, result, method, source, source_ref, revision_reason, graded_by)
  values
    (pid, 'NC', 'NC', 'commission', 'http://example.invalid/appeal',
     'Overturned to a no-contest following an adverse analytical finding.', 'test')
  returning id into g2;

  select * into rec from public.ufc_model_prediction_grades where id = g2;
  if rec.revision <> 2 then raise exception 'FAIL: the correction should be revision 2, got %', rec.revision; end if;
  if rec.supersedes_grade_id <> g1 then raise exception 'FAIL: revision 2 should supersede revision 1'; end if;
  perform pg_temp.ok('an overturned result is revision 2, superseding revision 1, with a stated reason');

  -- The superseded grade is still there, unchanged.
  select * into rec from public.ufc_model_prediction_grades where id = g1;
  if rec.result <> 'WIN' then raise exception 'FAIL: the superseded grade was altered'; end if;
  if (select count(*) from public.ufc_model_prediction_grades where prediction_id = pid) <> 2 then
    raise exception 'FAIL: the grading history should hold both revisions';
  end if;
  perform pg_temp.ok('the superseded grade remains readable and unchanged');

  -- The current-grade view shows only the correction.
  select * into cur from public.ufc_model_prediction_current_grade where prediction_id = pid;
  if cur.revision <> 2 or cur.result <> 'NC' then
    raise exception 'FAIL: current grade should be revision 2 NC, got revision % %', cur.revision, cur.result;
  end if;
  perform pg_temp.ok('the current-grade view reports the correction, not the original');

  -- 3h. AND THE PREDICTION ITSELF NEVER MOVED.
  select prob_a, prob_b, pick_fighter_id, pick_probability, locked_at into probs
    from public.ufc_model_predictions where id = pid;
  if probs.pick_fighter_id <> fa or probs.locked_at is null or probs.pick_probability <> 0.618 then
    raise exception 'FAIL: the prediction changed while its grade was corrected';
  end if;
  perform pg_temp.ok('the prediction is untouched by two rounds of grading');

  -- 3i. A third revision is still possible: results can be corrected twice.
  insert into public.ufc_model_prediction_grades
    (prediction_id, result, winner_id, method, source, revision_reason, graded_by)
  values
    (pid, 'WIN', fa, 'DEC_U', 'commission', 'No-contest vacated on appeal; the original result stands.', 'test');
  select * into cur from public.ufc_model_prediction_current_grade where prediction_id = pid;
  if cur.revision <> 3 or cur.result <> 'WIN' then
    raise exception 'FAIL: a second correction should be revision 3 WIN, got revision % %', cur.revision, cur.result;
  end if;
  perform pg_temp.ok('a result can be corrected more than once and the whole chain stays readable');
end $$;

-- ===========================================================================
-- 4. The tracker follows the current grade
-- ===========================================================================

do $$
declare
  rec record;
  pid uuid := (select v from t_fixture where k = 'locked_pid');
begin
  select * into rec from public.ufc_model_live_record where model_version = 'test-model-v1';
  if rec.wins <> 1 or rec.losses <> 0 or rec.decided <> 1 then
    raise exception 'FAIL: live record should read 1-0 on the reinstated result, got w=% l=% decided=%',
      rec.wins, rec.losses, rec.decided;
  end if;
  if rec.revised_grades <> 1 then
    raise exception 'FAIL: live record should flag 1 prediction whose grade has been revised, got %', rec.revised_grades;
  end if;
  perform pg_temp.ok('the live record follows the current grade and reports that it was revised');

  -- Roll the current grade back to a no-contest and watch the record move.
  insert into public.ufc_model_prediction_grades
    (prediction_id, result, method, source, revision_reason, graded_by)
  values
    (pid, 'NC', 'NC', 'commission', 'Appeal reversed a second time; recorded as a no-contest.', 'test');
  select * into rec from public.ufc_model_live_record where model_version = 'test-model-v1';
  if rec.wins <> 0 or rec.no_decision <> 1 or rec.decided <> 0 or rec.hit_rate is not null then
    raise exception 'FAIL: live record did not follow the correction: w=% nd=% decided=% hit=%',
      rec.wins, rec.no_decision, rec.decided, rec.hit_rate;
  end if;
  perform pg_temp.ok('a later correction moves the published record without touching any prediction');

  if (select count(*) from public.ufc_model_prediction_grades where prediction_id = pid) <> 4 then
    raise exception 'FAIL: four grades should be on file';
  end if;
  perform pg_temp.ok('all four grade revisions remain on file and auditable');
end $$;

-- ===========================================================================
-- 5. Model versions, record separation, and the empty state
-- ===========================================================================

do $$
declare
  n int;
  rec record;
begin
  perform pg_temp.must_fail(
    'update public.ufc_model_versions set coefficients = ''{"x": 1}''::jsonb where model_version = ''test-model-v1''',
    'editing the coefficients of a released model version', 'immutable');
  perform pg_temp.must_fail(
    'delete from public.ufc_model_versions where model_version = ''test-model-v1''',
    'deleting a released model version', 'permanent');
  perform pg_temp.must_succeed(
    'update public.ufc_model_versions set status = ''live'' where model_version = ''test-model-v1''',
    'promoting a model version to live');

  -- A registered model that has published nothing produces NO ROW, not a
  -- zeroed one. "No picks yet" and "0 for 0" are different statements.
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
  perform pg_temp.ok('a model that has published nothing has an empty record, not a zeroed one');

  -- Unlocked drafts are not part of the record either.
  select * into rec from public.ufc_model_live_record where model_version = 'test-model-v1';
  select count(*) into n from public.ufc_model_predictions where locked_at is null;
  if n = 0 then raise exception 'FAIL: the fixture should have left unlocked drafts behind'; end if;
  if rec.locked_predictions <> 3 then
    raise exception 'FAIL: live record should count only the 3 locked picks, got %', rec.locked_predictions;
  end if;
  perform pg_temp.ok(format('unlocked drafts (%s of them) are excluded from the live record', n));
end $$;

-- ---------------------------------------------------------------------------
select line as result from t_note order by seq;

do $$
begin
  raise notice 'ALL SCHEMA TESTS PASSED (% assertions)', (select count(*) from t_note);
end $$;

rollback;
