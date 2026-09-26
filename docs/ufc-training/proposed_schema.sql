-- SUPERSEDED 2026-09-26 by migrations/032_ufc_training_corner.sql (applied). Kept as the design record.
-- PROPOSED — NOT A MIGRATION. Do not move into supabase/migrations/ until the owner
-- picks a source option in docs/UFC_TRAINING_SOURCE_MATRIX.md §6 and approves the migration.
--
-- Design rules (from the brief, tightened):
--   * append-only: observations are never updated or deleted; history is derived.
--   * every fact row carries source_id -> combat_sources (rights gate), source_url, captured_at.
--   * fighting-out-of, affiliation, training location and coaches are separate facts.
--   * CONFIRMED switches and OBSERVED affiliation changes are different change kinds.
--   * no fuzzy identity: fighter_id is required; camps/coaches join by external id or reviewed alias.

create table public.ufc_training_camps (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  slug text not null unique,
  city text, region text, country text,            -- the GYM's location, only when sourced for the gym itself
  website text,
  external_ids jsonb not null default '{}'::jsonb, -- e.g. {"espn_association": "7027", "wikidata": "Q..."}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ufc_training_camps_espn_uidx on public.ufc_training_camps ((external_ids->>'espn_association'))
  where external_ids ? 'espn_association';

create table public.ufc_training_camp_aliases (
  camp_id uuid not null references public.ufc_training_camps(id) on delete cascade,
  alias text not null,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  reviewed boolean not null default false,          -- alias resolution is exact + reviewed, never fuzzy
  primary key (camp_id, alias)
);

create table public.ufc_coaches (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  slug text not null unique,
  external_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- NB: no current_camp_id on coaches. "Current" is derived from dated coach history, like fighters.

-- Raw, append-only ledger: one row per fact per source capture.
create table public.ufc_training_observations (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id) on delete restrict,
  fact text not null check (fact in ('FIGHTING_OUT_OF','AFFILIATION','TRAINING_LOCATION','COACH')),
  camp_id uuid references public.ufc_training_camps(id),
  coach_id uuid references public.ufc_coaches(id),
  coach_role text check (coach_role is null or coach_role in
    ('HEAD','STRIKING','BOXING','MUAY_THAI','WRESTLING','GRAPPLING','STRENGTH_CONDITIONING','OTHER')),
  relationship_type text check (relationship_type is null or relationship_type in
    ('PRIMARY_CAMP','AFFILIATION','TEMPORARY_CAMP','CROSS_TRAINING','FIGHT_CAMP')),
  value_raw text not null,                            -- exactly what the source said
  city text, region text, country text,               -- for FIGHTING_OUT_OF / TRAINING_LOCATION only
  effective_from date, effective_to date,             -- ONLY when the source states them; never inferred
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  source_url text not null,
  source_published_at timestamptz,
  captured_at timestamptz not null default now(),
  certainty text not null check (certainty in ('STATED','OBSERVED')),
  evidence_note text,                                 -- short factual locator, never copied bio prose
  obs_hash text not null unique,                      -- idempotent re-capture
  check (fact <> 'COACH' or (coach_id is not null and coach_role is not null)),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create index ufc_training_obs_fighter_idx on public.ufc_training_observations (fighter_id, fact, captured_at desc);

create or replace function public.ufc_training_observations_append_only() returns trigger
language plpgsql as $$ begin raise exception 'ufc_training_observations is append-only'; end $$;
create trigger ufc_training_observations_no_update before update or delete on public.ufc_training_observations
  for each row execute function public.ufc_training_observations_append_only();

-- Change events emitted by the reconciler. Never silently rewritten.
create table public.ufc_training_change_events (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id),
  kind text not null check (kind in ('CAMP_CHANGED_CONFIRMED','AFFILIATION_CHANGED_OBSERVED',
    'COACH_ADDED','COACH_REMOVED','FIGHTING_OUT_OF_CHANGED')),
  previous_value text, new_value text not null,
  previous_observation_id uuid references public.ufc_training_observations(id),
  new_observation_id uuid not null references public.ufc_training_observations(id),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- a CONFIRMED switch requires a STATED observation (explicit join/leave/switch source)
  unique (new_observation_id, kind)
);

-- History = derived intervals, rebuilt from observations (view, not a mutable table):
--   first_observed / last_observed per (fighter, fact, camp) from OBSERVED rows;
--   effective_from / effective_to only from STATED rows.
-- UI copy rule: "First observed <month year>" unless effective_from is STATED.

alter table public.ufc_training_camps enable row level security;
alter table public.ufc_training_camp_aliases enable row level security;
alter table public.ufc_coaches enable row level security;
alter table public.ufc_training_observations enable row level security;
alter table public.ufc_training_change_events enable row level security;
-- Reads go through the service-role API (ufc-api), matching the rest of the UFC schema.
