-- Behavioural tests for migration 037. Always rolled back (scripts/db/prove_037.ps1). The last statement raises
-- 'ALLPASS n'.

do $$
declare
  n int := 0; c int; fa uuid; fb uuid; ev_today uuid; ev_old uuid; b1 uuid; b2 uuid; b3 uuid;
  t1 timestamptz; t2 timestamptz; today date := (now() at time zone 'America/New_York')::date;
begin
  -- T0 the migration stamps no existing row (historical results keep NULL, never the migration time)
  select count(*) into c from public.ufc_bout_results where first_observed_at is not null;
  if c <> 0 then raise exception 'FAIL T0 % existing rows stamped', c; end if;
  n := n + 1;

  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t037a', 'T037 A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (espn_athlete_id, name, source_url) values ('t037b', 'T037 B', 'http://example.invalid/b') returning id into fb;
  insert into public.ufc_events (espn_event_id, name, event_date, source_url) values ('t037-ev', 'T037 Fight Night', today, 'http://example.invalid/e') returning id into ev_today;
  insert into public.ufc_events (espn_event_id, name, event_date, source_url) values ('t037-old', 'T037 Old Card', date '2019-03-02', 'http://example.invalid/o') returning id into ev_old;
  insert into public.ufc_bouts (event_id, fighter_a_id, fighter_b_id, bout_order, source_url) values (ev_today, fa, fb, 1, 'http://example.invalid/b1') returning id into b1;
  insert into public.ufc_bouts (event_id, fighter_a_id, fighter_b_id, bout_order, source_url) values (ev_old, fa, fb, 1, 'http://example.invalid/b2') returning id into b2;
  insert into public.ufc_bouts (event_id, fighter_a_id, fighter_b_id, bout_order, source_url) values (ev_today, fb, fa, 2, 'http://example.invalid/b3') returning id into b3;

  -- T1 a new result on tonight's card gets one first_observed_at (a writer-supplied value is ignored)
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, result_source, source_url, first_observed_at)
  values (b1, fa, 'KO_TKO', 'KO/TKO', 1, 144, 'espn', 'http://example.invalid/r1', '2001-01-01T00:00:00Z');
  select first_observed_at into t1 from public.ufc_bout_results where bout_id = b1;
  if t1 is null or t1 <> now() then raise exception 'FAIL T1 stamp %', t1; end if;
  n := n + 1;

  -- T2 the fight-night re-ingest (PostgREST merge-duplicates = insert ... on conflict do update) keeps it
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, result_source, source_url, captured_at)
  values (b1, fa, 'KO_TKO', 'KO/TKO', 1, 144, 'espn', 'http://example.invalid/r1', now() + interval '1 day')
  on conflict (bout_id) do update set captured_at = excluded.captured_at, method_raw = excluded.method_raw;
  select first_observed_at into t2 from public.ufc_bout_results where bout_id = b1;
  if t2 is distinct from t1 then raise exception 'FAIL T2 moved % -> %', t1, t2; end if;
  n := n + 1;

  -- T3 an overturn / correction keeps the original first observation; a direct write cannot move or clear it
  update public.ufc_bout_results set winner_id = fb, method = 'NC', method_raw = 'Overturned', first_observed_at = now() + interval '7 days' where bout_id = b1;
  select first_observed_at into t2 from public.ufc_bout_results where bout_id = b1;
  if t2 is distinct from t1 then raise exception 'FAIL T3 moved %', t2; end if;
  update public.ufc_bout_results set first_observed_at = null where bout_id = b1;
  select first_observed_at into t2 from public.ufc_bout_results where bout_id = b1;
  if t2 is distinct from t1 then raise exception 'FAIL T3 cleared'; end if;
  n := n + 1;

  -- T4 a result first inserted for an old card (backfill) is not "observed live": NULL, and stays NULL on update
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, result_source, source_url)
  values (b2, fa, 'SUB', 'Submission', 'ufcstats', 'http://example.invalid/r2');
  update public.ufc_bout_results set captured_at = now(), first_observed_at = now() where bout_id = b2;
  select count(*) into c from public.ufc_bout_results where bout_id = b2 and first_observed_at is null;
  if c <> 1 then raise exception 'FAIL T4 old card stamped'; end if;
  n := n + 1;

  -- T5 a second result on tonight's card gets its own stamp; captured_at untouched by the trigger
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, result_source, source_url, captured_at)
  values (b3, fb, 'DEC_U', 'Decision - Unanimous', 'espn', 'http://example.invalid/r3', '2030-01-01T00:00:00Z');
  select count(*) into c from public.ufc_bout_results where bout_id = b3 and first_observed_at = now() and captured_at = '2030-01-01T00:00:00Z';
  if c <> 1 then raise exception 'FAIL T5'; end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end
$$;
