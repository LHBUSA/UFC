-- Behavioural tests for migration 029. Run INSIDE a transaction that is always
-- rolled back (scripts/db/prove_029.ps1). The last statement raises 'ALLPASS n'.

do $$
declare
  ev uuid; obs uuid; n int := 0; c int;
begin
  insert into public.ufc_events (espn_event_id, name, event_date, source_url) values ('t029ev', 'UFC T029', '2030-02-01', 'http://example.invalid/e') returning id into ev;

  -- T1 insert works and defaults the clock
  insert into public.ufc_event_card_observations (event_id, source, competition_ids, placeholder_ids, complete, writer)
    values (ev, 'espn', array['c1','c2'], array['c3'], true, 't029') returning id into obs;
  select count(*) into c from public.ufc_event_card_observations where id = obs and observed_at is not null;
  if c <> 1 then raise exception 'FAIL T1 insert'; end if;
  n := n + 1;

  -- T2 append-only: no update
  begin
    update public.ufc_event_card_observations set competition_ids = array['c1'] where id = obs;
    raise exception 'FAIL T2 update allowed';
  exception when restrict_violation then n := n + 1; end;

  -- T3 append-only: no delete
  begin
    delete from public.ufc_event_card_observations where id = obs;
    raise exception 'FAIL T3 delete allowed';
  exception when restrict_violation then n := n + 1; end;

  -- T4 unknown source refused
  begin
    insert into public.ufc_event_card_observations (event_id, source, competition_ids, complete, writer) values (ev, 'rumor', array['c1'], true, 't029');
    raise exception 'FAIL T4 unknown source';
  exception when check_violation then n := n + 1; end;

  -- T5 no public access
  if has_table_privilege('anon', 'public.ufc_event_card_observations', 'select')
     or has_table_privilege('authenticated', 'public.ufc_event_card_observations', 'insert') then
    raise exception 'FAIL T5 public privilege';
  end if;
  n := n + 1;

  -- T6 ufc_bouts untouched by the table's existence (no trigger on bouts)
  if exists (select 1 from pg_trigger t join pg_class r on r.oid = t.tgrelid where r.relname = 'ufc_bouts' and t.tgname like '%card_observation%') then
    raise exception 'FAIL T6 bouts trigger';
  end if;
  n := n + 1;

  raise exception 'ALLPASS %', n;
end;
$$;
