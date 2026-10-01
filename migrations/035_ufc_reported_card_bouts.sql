-- Reported upcoming-card fallback.
-- Separate from canonical ufc_bouts: this table may contain sourced public
-- matchups before ESPN publishes usable competition identities.
begin;

create table if not exists public.ufc_reported_card_bouts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.ufc_events(id) on delete cascade,
  source_family text not null,
  source_url text not null,
  matchup_key text not null,
  fighter_a_name text not null check (btrim(fighter_a_name) <> ''),
  fighter_b_name text not null check (btrim(fighter_b_name) <> ''),
  weight_class_raw text,
  bout_order integer,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  active boolean not null default true,
  unique (event_id, source_family, matchup_key)
);

create index if not exists ufc_reported_card_bouts_event_active_idx
  on public.ufc_reported_card_bouts (event_id, active, bout_order);

alter table public.ufc_reported_card_bouts enable row level security;
revoke all on table public.ufc_reported_card_bouts from anon, authenticated;
grant all on table public.ufc_reported_card_bouts to service_role;

commit;
