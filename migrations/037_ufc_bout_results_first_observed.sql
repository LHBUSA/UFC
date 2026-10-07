-- First-observed time of a bout result: the immutable moment PropBetEdge first saw this result (PLATINUM LIVE).
--
-- ufc_bout_results.captured_at is the time of the LATEST ingest pass: the ESPN fight-night lane upserts every
-- result of the active card each minute, and later re-captures (daily pass, UFC Stats enrichment) rewrite it
-- again. It answers "how current is this row", never "when did this fight become final". ESPN publishes no
-- wall-clock finish time, and round + time-in-round is not one.
--
-- first_observed_at is owned by the database, not by any writer:
--   * INSERT: stamped now() — only while the result is live news, i.e. its event is dated today or yesterday in
--     America/New_York (the fight-night window, which covers a card that runs past midnight ET). A result first
--     inserted for an older event (a backfill, a UFC Stats catch-up) stays NULL: we did not observe it go final.
--     Any value a writer supplies is ignored.
--   * UPDATE (re-ingest, overturn, scorecard enrichment, upsert merge): the stored value is kept, NULL included.
--     It can never move forward and can never be filled in later.
-- Existing rows are NOT stamped: they keep NULL (unknown first observation), never the migration time.
-- Nothing here changes captured_at or any other column.

begin;

alter table public.ufc_bout_results add column if not exists first_observed_at timestamptz;

comment on column public.ufc_bout_results.first_observed_at is
  'Immutable: when PropBetEdge first observed this result, stamped by trigger on INSERT only while the event is dated today/yesterday (America/New_York); kept on every UPDATE. NULL = not observed live (historical rows, backfills). Not a wall-clock finish time.';

create or replace function public.ufc_bout_results_first_observed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ev_date date;
begin
  if tg_op = 'INSERT' then
    select e.event_date into ev_date
      from public.ufc_bouts b join public.ufc_events e on e.id = b.event_id
     where b.id = new.bout_id;
    new.first_observed_at := case
      when ev_date is not null and ev_date >= ((now() at time zone 'America/New_York')::date - 1) then now()
      else null
    end;
  else
    new.first_observed_at := old.first_observed_at;
  end if;
  return new;
end
$$;

drop trigger if exists ufc_bout_results_first_observed on public.ufc_bout_results;
create trigger ufc_bout_results_first_observed
  before insert or update on public.ufc_bout_results
  for each row execute function public.ufc_bout_results_first_observed();

commit;
