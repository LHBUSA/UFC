-- Behavioural tests for migration 028. Run INSIDE a transaction that is always
-- rolled back (scripts/db/prove_028.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  fa uuid; fb uuid; ev_rtu uuid; ev_ufc uuid; ev_dwcs uuid; bt_rtu uuid; bt_ufc uuid; bt_legacy uuid;
  n int := 0; s text; b boolean; before_true bigint; before_false bigint;
begin
  -- T1 backfill: every event classified by name, every pre-existing bout in model scope
  if exists (select 1 from public.ufc_events where event_series <> public.ufc_event_series_for(name)) then raise exception 'FAIL T1 event misclassified'; end if;
  if exists (select 1 from public.ufc_bouts where model_scope is not true) then raise exception 'FAIL T1 existing bout out of model scope'; end if;
  n := n + 1;

  -- T2 the legacy UFC Stats Road to UFC event is classified road_to_ufc; its bouts stay in model scope (V1 contract)
  select event_series into s from public.ufc_events where ufcstats_id = '8fbcd82bf7f352bf';
  if s is distinct from 'road_to_ufc' then raise exception 'FAIL T2 legacy RTU series %', s; end if;
  if exists (select 1 from public.ufc_bouts bb join public.ufc_events e on e.id = bb.event_id where e.ufcstats_id = '8fbcd82bf7f352bf' and bb.model_scope is not true) then raise exception 'FAIL T2 legacy RTU bouts left model scope'; end if;
  n := n + 1;

  -- T3 name classifier
  if public.ufc_event_series_for('Road to UFC Season 5: Macau Quarterfinals 1') <> 'road_to_ufc'
     or public.ufc_event_series_for('UFC - Road to UFC 4.6') <> 'road_to_ufc'
     or public.ufc_event_series_for('Dana White''s Contender Series: Season 10, Week 6') <> 'contender_series'
     or public.ufc_event_series_for('UFC 331: Van vs. Pantoja 2') <> 'ufc'
     or public.ufc_event_series_for('UFC Fight Night: Rosas Jr. vs. Barcelos') <> 'ufc'
     or public.ufc_event_series_for('UFC Fight Night: Road to Glory') <> 'ufc' then
    raise exception 'FAIL T3 classifier';
  end if;
  n := n + 1;

  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t028fa0000000001', 'T028 A', 'http://example.invalid/a') returning id into fa;
  insert into public.ufc_fighters (ufcstats_id, name, source_url) values ('t028fb0000000002', 'T028 B', 'http://example.invalid/b') returning id into fb;

  -- T4 an inserted event is classified by trigger, whatever the writer sends
  insert into public.ufc_events (espn_event_id, name, event_date, source_url, event_series) values ('t028rtu', 'Road to UFC Season 9: Test Episode 1', '2030-01-01', 'http://example.invalid/e', 'ufc') returning id, event_series into ev_rtu, s;
  if s <> 'road_to_ufc' then raise exception 'FAIL T4 rtu insert %', s; end if;
  insert into public.ufc_events (espn_event_id, name, event_date, source_url) values ('t028ufc', 'UFC Fight Night: T028', '2030-01-02', 'http://example.invalid/f') returning id, event_series into ev_ufc, s;
  if s <> 'ufc' then raise exception 'FAIL T4 ufc insert %', s; end if;
  insert into public.ufc_events (espn_event_id, name, event_date, source_url) values ('t028dwcs', 'Dana White''s Contender Series: Season 99, Week 1', '2030-01-03', 'http://example.invalid/g') returning id, event_series into ev_dwcs, s;
  if s <> 'contender_series' then raise exception 'FAIL T4 dwcs insert %', s; end if;
  n := n + 1;

  -- T5 a bout inserted on a Road to UFC event is out of model scope, even if the writer asks otherwise
  insert into public.ufc_bouts (espn_competition_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url, model_scope)
    values ('t028b1', ev_rtu, fa, fb, 1, 'complete', 'http://example.invalid/1', true) returning id, model_scope into bt_rtu, b;
  if b is not false then raise exception 'FAIL T5 rtu bout in model scope'; end if;
  n := n + 1;

  -- T6 bouts on UFC and Contender Series cards stay in model scope (V1 contract unchanged)
  insert into public.ufc_bouts (espn_competition_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url)
    values ('t028b2', ev_ufc, fa, fb, 1, 'complete', 'http://example.invalid/2') returning id, model_scope into bt_ufc, b;
  if b is not true then raise exception 'FAIL T6 ufc bout out of scope'; end if;
  insert into public.ufc_bouts (espn_competition_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url)
    values ('t028b3', ev_dwcs, fa, fb, 1, 'complete', 'http://example.invalid/3') returning model_scope into b;
  if b is not true then raise exception 'FAIL T6 dwcs bout out of scope'; end if;
  n := n + 1;

  -- T7 model_scope is immutable in both directions
  begin
    update public.ufc_bouts set model_scope = true where id = bt_rtu;
    raise exception 'FAIL T7 widened model scope';
  exception when restrict_violation then n := n + 1; end;
  begin
    update public.ufc_bouts set model_scope = false where id = bt_ufc;
    raise exception 'FAIL T7b narrowed model scope';
  exception when restrict_violation then n := n + 1; end;

  -- T8 an ordinary bout update (result status, ESPN link) still works and keeps the flag
  update public.ufc_bouts set status = 'complete', espn_competition_id = 't028b1x' where id = bt_rtu returning model_scope into b;
  if b is not false then raise exception 'FAIL T8 flag moved on update'; end if;
  n := n + 1;

  -- T9 upsert on espn_competition_id (the ingest path) keeps an existing bout's flag
  insert into public.ufc_bouts (espn_competition_id, event_id, fighter_a_id, fighter_b_id, bout_order, status, source_url)
    values ('t028b2', ev_ufc, fa, fb, 2, 'complete', 'http://example.invalid/2b')
    on conflict (espn_competition_id) do update set bout_order = excluded.bout_order, source_url = excluded.source_url
    returning model_scope into b;
  if b is not true then raise exception 'FAIL T9 upsert moved flag'; end if;
  n := n + 1;

  -- T10 renaming an event reclassifies it; existing bouts keep their flag
  select model_scope into b from public.ufc_bouts where id = bt_ufc;
  update public.ufc_events set name = 'Road to UFC: Renamed' where id = ev_ufc returning event_series into s;
  if s <> 'road_to_ufc' then raise exception 'FAIL T10 rename %', s; end if;
  if (select model_scope from public.ufc_bouts where id = bt_ufc) is distinct from b then raise exception 'FAIL T10 rename moved bout flag'; end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end;
$$;
