-- Authoritative current card truth, as an append-only observation ledger (D1).
--
-- Defect D1 (2026-09-15): when ESPN drops a competition from a card (a bout
-- scratched, or re-listed as a new matchup under a new competition id), the
-- ESPN pass only logged AnnouncedBoutVanished. ufc_bouts.status stayed
-- 'announced', so PBE Algo kept treating the old matchup as scheduled and
-- could regenerate and lock it (live example: UFC 331 Moicano vs Ortega,
-- competition 401905377, absent from ESPN since 2026-09-15 06:03Z).
--
-- Each completed ESPN card pass appends one row: which competitions the card
-- listed as parseable bouts and which it listed only as placeholders. Nothing
-- in ufc_bouts is mutated; the stale row and every prediction stay as they
-- are. ufc-algo reads the newest observation per event and treats a bout that
-- is not a listed competition (or only a placeholder) as not scheduled.

begin;

create table if not exists public.ufc_event_card_observations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.ufc_events(id) on delete cascade,
  source text not null check (source in ('espn')),
  observed_at timestamptz not null default clock_timestamp(),
  -- Competitions the source listed as bouts on this card at observed_at.
  competition_ids text[] not null,
  -- Competitions the source listed without a complete matchup (placeholder).
  placeholder_ids text[] not null default '{}',
  -- True only when the whole card payload was read and every listed competition processed.
  complete boolean not null,
  source_url text,
  writer text not null,
  check (cardinality(competition_ids) + cardinality(placeholder_ids) >= 0)
);

create index if not exists ufc_event_card_observations_latest_idx
  on public.ufc_event_card_observations (event_id, source, observed_at desc);

comment on table public.ufc_event_card_observations is
  'Append-only ESPN card observations (D1). Newest row per event = current authoritative card truth for PBE Algo scheduling. Never updated or deleted; ufc_bouts is not mutated by it.';

create or replace function public.ufc_event_card_observations_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'card observation % is append-only', old.id using errcode = 'restrict_violation';
end;
$$;
drop trigger if exists ufc_event_card_observations_append_only_trg on public.ufc_event_card_observations;
create trigger ufc_event_card_observations_append_only_trg
  before update or delete on public.ufc_event_card_observations
  for each row execute function public.ufc_event_card_observations_append_only();

alter table public.ufc_event_card_observations enable row level security;
revoke all on table public.ufc_event_card_observations from anon, authenticated;
revoke truncate on table public.ufc_event_card_observations from service_role, anon, authenticated;
grant select, insert on table public.ufc_event_card_observations to service_role;

commit;
