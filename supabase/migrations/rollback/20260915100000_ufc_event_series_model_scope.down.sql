-- Rollback for 20260915100000_ufc_event_series_model_scope. Refused once any
-- bout is out of model scope: dropping the column would silently put Road to
-- UFC bouts back into Fight DNA and PBE Algo inputs. Remove those consumers'
-- rows deliberately first.
begin;
do $$ begin
  if exists (select 1 from public.ufc_bouts where model_scope = false) then
    raise exception 'refusing rollback: out-of-model-scope bouts exist';
  end if;
end $$;
drop trigger if exists ufc_bouts_model_scope_guard_trg on public.ufc_bouts;
drop function if exists public.ufc_bouts_model_scope_guard();
drop index if exists public.ufc_bouts_out_of_model_scope_idx;
alter table public.ufc_bouts drop column if exists model_scope;
drop trigger if exists ufc_events_classify_series_trg on public.ufc_events;
drop function if exists public.ufc_events_classify_series();
drop index if exists public.ufc_events_event_series_idx;
alter table public.ufc_events drop constraint if exists ufc_events_event_series_check;
alter table public.ufc_events drop column if exists event_series;
drop function if exists public.ufc_event_series_for(text);
commit;
