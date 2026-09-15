-- Event series classification + the model-input scope of every bout.
--
-- Owner decision 2026-09-15: UFC-promoted Road to UFC cards belong in the UFC
-- data universe (fighter histories, career-record reconciliation), classified
-- as their own series, never as a numbered or Fight Night card. Ingesting them
-- must NOT change what PBE Algo or Fight DNA consume.
--
-- 1. ufc_events.event_series: 'ufc' | 'contender_series' | 'road_to_ufc'.
--    Derived from the event name by trigger on insert and on rename, so every
--    writer (ESPN lane, UFC Stats backfill, repairs) classifies identically.
--
-- 2. ufc_bouts.model_scope: whether a bout is an input to Fight DNA features
--    and PBE Algo (inference and training). Every bout that exists when this
--    migration runs keeps model_scope = true: that is exactly the set V1 was
--    trained on and scores from (V1's contract had no series filter; it
--    included DWCS, TUF and the two UFC Stats "Road to UFC 4.6" bouts). A bout
--    INSERTED on a road_to_ufc event from now on is model_scope = false. The
--    flag is immutable afterwards: widening the model's inputs is a model
--    change and needs its own migration, never a data write.
--
-- Additive. Changes no existing value a consumer reads today.

begin;

alter table public.ufc_events add column if not exists event_series text not null default 'ufc';
alter table public.ufc_events drop constraint if exists ufc_events_event_series_check;
alter table public.ufc_events add constraint ufc_events_event_series_check check (event_series in ('ufc', 'contender_series', 'road_to_ufc'));

create or replace function public.ufc_event_series_for(p_name text)
returns text language sql immutable as $$
  select case
    when p_name ~* '^\s*(ufc\s*-\s*)?road\s+to\s+ufc\M' then 'road_to_ufc'
    when p_name ~* 'contender\s+series' then 'contender_series'
    else 'ufc'
  end
$$;
comment on function public.ufc_event_series_for(text) is
  'Series of a UFC event from its source name. road_to_ufc: names beginning "Road to UFC" (ESPN) or "UFC - Road to UFC" (UFC Stats). contender_series: Dana White''s Contender Series. Everything else: ufc.';

create or replace function public.ufc_events_classify_series()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    new.event_series := public.ufc_event_series_for(new.name);
  end if;
  return new;
end;
$$;
drop trigger if exists ufc_events_classify_series_trg on public.ufc_events;
create trigger ufc_events_classify_series_trg
  before insert or update of name on public.ufc_events
  for each row execute function public.ufc_events_classify_series();

update public.ufc_events set event_series = public.ufc_event_series_for(name)
 where event_series is distinct from public.ufc_event_series_for(name);

create index if not exists ufc_events_event_series_idx on public.ufc_events (event_series) where event_series <> 'ufc';

comment on column public.ufc_events.event_series is
  'ufc | contender_series | road_to_ufc. Set by trigger from the event name; a Road to UFC card is never a numbered or Fight Night card.';

-- ---------------------------------------------------------------------------

alter table public.ufc_bouts add column if not exists model_scope boolean not null default true;

create or replace function public.ufc_bouts_model_scope_guard()
returns trigger language plpgsql as $$
declare
  series text;
begin
  if tg_op = 'INSERT' then
    select e.event_series into series from public.ufc_events e where e.id = new.event_id;
    if series = 'road_to_ufc' then
      new.model_scope := false;
    end if;
    return new;
  end if;
  if new.model_scope is distinct from old.model_scope then
    raise exception 'ufc_bouts.model_scope is immutable (bout %): changing model inputs needs its own migration', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists ufc_bouts_model_scope_guard_trg on public.ufc_bouts;
create trigger ufc_bouts_model_scope_guard_trg
  before insert or update on public.ufc_bouts
  for each row execute function public.ufc_bouts_model_scope_guard();

create index if not exists ufc_bouts_out_of_model_scope_idx on public.ufc_bouts (event_id) where model_scope = false;

comment on column public.ufc_bouts.model_scope is
  'Input to Fight DNA features and PBE Algo (inference + training). True for every bout that existed at migration 028 (the V1 contract). A bout inserted on a road_to_ufc event is false: ingested for fighter history and record reconciliation only. Immutable.';

commit;
