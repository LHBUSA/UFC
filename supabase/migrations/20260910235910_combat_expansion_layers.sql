-- PropBetEdge UFC — combat career graph expansion layers.
-- Depends on 20260910235900_combat_career_graph.sql.
--
-- Still additive and service-role only. These relations make the cross-promotion
-- graph capable of preserving scorecards, weigh-ins, titles, rankings,
-- officials, availability/status and awards when an approved source exists.
-- No source is enabled here and no outside data is collected by this migration.

begin;

create table if not exists public.combat_ingest_packets (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  ingest_key text not null,
  packet_version int not null default 1 check (packet_version >= 1),
  packet_type text not null check (packet_type in ('fighter','event','bout','career','ranking','weigh_in','scorecard','status','award','mixed')),
  external_id text,
  source_url text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  validation_state text not null default 'pending' check (validation_state in ('pending','validated','rejected')),
  validation_errors jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, ingest_key, packet_version),
  unique (source_id, payload_sha256)
);
create index if not exists combat_ingest_packets_validation_idx
  on public.combat_ingest_packets (validation_state, created_at);

create table if not exists public.combat_officials (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  normalized_name text not null,
  identity_state text not null default 'review_required'
    check (identity_state in ('verified','source_native','review_required','merged')),
  merged_into_id uuid references public.combat_officials(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((identity_state = 'merged') = (merged_into_id is not null)),
  check (merged_into_id is null or merged_into_id <> id)
);
create index if not exists combat_officials_norm_idx on public.combat_officials (normalized_name);

create table if not exists public.combat_official_identities (
  id uuid primary key default gen_random_uuid(),
  official_id uuid not null references public.combat_officials(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  external_id text not null,
  display_name text,
  verification_state text not null default 'review'
    check (verification_state in ('verified','probable','review','rejected')),
  confidence smallint not null default 0 check (confidence between 0 and 100),
  evidence jsonb not null default '{}'::jsonb,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  unique (source_id, external_id)
);
create index if not exists combat_official_identities_official_idx
  on public.combat_official_identities (official_id);

create table if not exists public.combat_bout_officials (
  id uuid primary key default gen_random_uuid(),
  bout_id uuid not null references public.combat_bouts(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  official_id uuid references public.combat_officials(id) on delete restrict,
  role text not null check (role in ('referee','judge','inspector','other')),
  official_slot smallint check (official_slot is null or official_slot between 1 and 9),
  raw_name text not null,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (bout_id, source_id, role, official_slot, raw_name)
);
create index if not exists combat_bout_officials_bout_idx on public.combat_bout_officials (bout_id, role);
create index if not exists combat_bout_officials_official_idx on public.combat_bout_officials (official_id) where official_id is not null;

create table if not exists public.combat_scorecards (
  id uuid primary key default gen_random_uuid(),
  bout_id uuid not null references public.combat_bouts(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  judge_id uuid references public.combat_officials(id) on delete restrict,
  judge_slot smallint not null check (judge_slot between 1 and 9),
  judge_name_raw text,
  round int not null check (round between 1 and 10),
  fighter_a_score smallint not null check (fighter_a_score between 0 and 10),
  fighter_b_score smallint not null check (fighter_b_score between 0 and 10),
  fighter_a_deduction smallint not null default 0 check (fighter_a_deduction between 0 and 10),
  fighter_b_deduction smallint not null default 0 check (fighter_b_deduction between 0 and 10),
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (bout_id, source_id, judge_slot, round)
);
create index if not exists combat_scorecards_bout_idx on public.combat_scorecards (bout_id, judge_slot, round);

create table if not exists public.combat_weigh_ins (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.combat_events(id) on delete cascade,
  bout_id uuid references public.combat_bouts(id) on delete set null,
  fighter_id uuid not null references public.combat_fighters(id) on delete restrict,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  official_weight_lbs numeric(6,2),
  contracted_limit_lbs numeric(6,2),
  allowance_lbs numeric(5,2),
  limit_basis text not null default 'unsupported'
    check (limit_basis in ('sourced','ruleset','division_rule','unsupported')),
  attempt_number int not null default 1 check (attempt_number >= 1),
  result text not null default 'pending'
    check (result in ('pending','made','missed','cancelled','withdrawn')),
  over_by_lbs numeric(5,2),
  catchweight_lbs numeric(6,2),
  weighed_at timestamptz,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  fingerprint text not null unique,
  supersedes_id uuid references public.combat_weigh_ins(id) on delete set null,
  superseded_at timestamptz,
  captured_at timestamptz not null default now(),
  check (
    (limit_basis = 'unsupported' and contracted_limit_lbs is null and allowance_lbs is null)
    or (limit_basis <> 'unsupported' and contracted_limit_lbs is not null)
  ),
  check (over_by_lbs is null or (official_weight_lbs is not null and contracted_limit_lbs is not null)),
  check (official_weight_lbs is null or (official_weight_lbs > 50 and official_weight_lbs < 700)),
  check (
    (result in ('made','missed') and official_weight_lbs is not null)
    or (result in ('pending','cancelled','withdrawn') and official_weight_lbs is null)
  )
);
create index if not exists combat_weigh_ins_event_idx on public.combat_weigh_ins (event_id, result);
create index if not exists combat_weigh_ins_fighter_idx on public.combat_weigh_ins (fighter_id, captured_at desc);

create table if not exists public.combat_titles (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.combat_promotions(id) on delete restrict,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  external_title_id text,
  name text not null,
  division text,
  is_interim boolean not null default false,
  is_tournament boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive','retired','unknown')),
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_title_id)
);
create index if not exists combat_titles_promotion_idx on public.combat_titles (promotion_id, division);

create table if not exists public.combat_title_bouts (
  title_id uuid not null references public.combat_titles(id) on delete cascade,
  bout_id uuid not null references public.combat_bouts(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  designation text not null default 'title_bout'
    check (designation in ('title_bout','interim_title_bout','tournament_final','tournament_bout','other')),
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  primary key (title_id, bout_id, source_id)
);

create table if not exists public.combat_rankings (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.combat_promotions(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  snapshot_date date not null,
  division text not null,
  rank int not null check (rank >= 0),
  fighter_id uuid references public.combat_fighters(id) on delete restrict,
  name_raw text not null,
  is_champion boolean not null default false,
  rank_change int,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (promotion_id, source_id, snapshot_date, division, rank, name_raw),
  check (not is_champion or rank = 0)
);
create index if not exists combat_rankings_snapshot_idx on public.combat_rankings (promotion_id, snapshot_date desc, division);
create index if not exists combat_rankings_fighter_idx on public.combat_rankings (fighter_id) where fighter_id is not null;

create table if not exists public.combat_status_events (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.combat_fighters(id) on delete cascade,
  event_id uuid references public.combat_events(id) on delete set null,
  bout_id uuid references public.combat_bouts(id) on delete set null,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  status_type text not null check (status_type in (
    'injury','illness','visa','suspension','withdrawal','weight_miss','booking_change','inactive','retirement','other'
  )),
  state text not null default 'open' check (state in ('open','resolved','superseded','retracted')),
  effective_at timestamptz,
  expires_at timestamptz,
  detail text,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  fingerprint text not null unique,
  supersedes_id uuid references public.combat_status_events(id) on delete set null,
  captured_at timestamptz not null default now(),
  check (expires_at is null or effective_at is null or expires_at >= effective_at)
);
create index if not exists combat_status_events_fighter_idx on public.combat_status_events (fighter_id, state, effective_at desc);
create index if not exists combat_status_events_bout_idx on public.combat_status_events (bout_id) where bout_id is not null;

create table if not exists public.combat_awards (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.combat_promotions(id) on delete cascade,
  event_id uuid references public.combat_events(id) on delete cascade,
  bout_id uuid references public.combat_bouts(id) on delete set null,
  fighter_id uuid references public.combat_fighters(id) on delete set null,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  award_type text not null,
  award_name text not null,
  amount numeric,
  currency text,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (source_id, event_id, bout_id, fighter_id, award_type, award_name)
);
create index if not exists combat_awards_fighter_idx on public.combat_awards (fighter_id) where fighter_id is not null;
create index if not exists combat_awards_event_idx on public.combat_awards (event_id) where event_id is not null;

-- Source guards. Staging packets also require approved_ingest: we do not store
-- raw provider payloads merely because a source is useful for human reference.
drop trigger if exists combat_ingest_packets_source_guard on public.combat_ingest_packets;
create trigger combat_ingest_packets_source_guard before insert or update of source_id on public.combat_ingest_packets
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_official_identity_source_guard on public.combat_official_identities;
create trigger combat_official_identity_source_guard before insert or update of source_id on public.combat_official_identities
for each row execute function public.combat_guard_identity_source();

drop trigger if exists combat_bout_officials_source_guard on public.combat_bout_officials;
create trigger combat_bout_officials_source_guard before insert or update of source_id on public.combat_bout_officials
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_scorecards_source_guard on public.combat_scorecards;
create trigger combat_scorecards_source_guard before insert or update of source_id on public.combat_scorecards
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_weigh_ins_source_guard on public.combat_weigh_ins;
create trigger combat_weigh_ins_source_guard before insert or update of source_id on public.combat_weigh_ins
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_titles_source_guard on public.combat_titles;
create trigger combat_titles_source_guard before insert or update of source_id on public.combat_titles
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_title_bouts_source_guard on public.combat_title_bouts;
create trigger combat_title_bouts_source_guard before insert or update of source_id on public.combat_title_bouts
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_rankings_source_guard on public.combat_rankings;
create trigger combat_rankings_source_guard before insert or update of source_id on public.combat_rankings
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_status_events_source_guard on public.combat_status_events;
create trigger combat_status_events_source_guard before insert or update of source_id on public.combat_status_events
for each row execute function public.combat_guard_fact_source();

drop trigger if exists combat_awards_source_guard on public.combat_awards;
create trigger combat_awards_source_guard before insert or update of source_id on public.combat_awards
for each row execute function public.combat_guard_fact_source();

alter table public.combat_ingest_packets enable row level security;
alter table public.combat_officials enable row level security;
alter table public.combat_official_identities enable row level security;
alter table public.combat_bout_officials enable row level security;
alter table public.combat_scorecards enable row level security;
alter table public.combat_weigh_ins enable row level security;
alter table public.combat_titles enable row level security;
alter table public.combat_title_bouts enable row level security;
alter table public.combat_rankings enable row level security;
alter table public.combat_status_events enable row level security;
alter table public.combat_awards enable row level security;

revoke all on table public.combat_ingest_packets, public.combat_officials, public.combat_official_identities,
  public.combat_bout_officials, public.combat_scorecards, public.combat_weigh_ins, public.combat_titles,
  public.combat_title_bouts, public.combat_rankings, public.combat_status_events, public.combat_awards
from public, anon, authenticated;

grant select, insert, update on table public.combat_ingest_packets, public.combat_officials, public.combat_official_identities,
  public.combat_bout_officials, public.combat_scorecards, public.combat_weigh_ins, public.combat_titles,
  public.combat_title_bouts, public.combat_rankings, public.combat_status_events, public.combat_awards
to service_role;

comment on table public.combat_ingest_packets is 'Validated source-native staging packets from approved combat data sources. Raw payload persistence is source-gated.';
comment on table public.combat_scorecards is 'Cross-promotion per-judge per-round scorecards. UFC canonical scorecards remain in ufc_bout_scorecards.';
comment on table public.combat_weigh_ins is 'Cross-promotion weigh-in measurements with source/limit provenance. Missing limits stay unsupported/null.';

commit;
