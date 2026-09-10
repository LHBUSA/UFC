-- PropBetEdge UFC — combat career graph foundation.
--
-- Additive only. The existing ufc_* tables remain the authoritative UFC data
-- plane. combat_* is a cross-promotion identity/career layer that can hold
-- verified non-UFC professional MMA history without polluting UFC semantics.
--
-- Source policy is part of the schema: a source can be useful for identity or
-- human reference without being approved for canonical fact ingestion.

begin;

create table if not exists public.combat_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_name text not null,
  source_kind text not null check (source_kind in ('internal','promotion','commission','open_data','data_provider','media','reference')),
  homepage_url text,
  terms_url text,
  license_name text,
  access_mode text not null default 'review_required'
    check (access_mode in ('approved_ingest','identity_only','reference_only','review_required','blocked')),
  rights_state text not null default 'unknown'
    check (rights_state in ('internal','approved','reference_only','unknown','prohibited')),
  redistribution_allowed boolean not null default false,
  enabled boolean not null default false,
  rights_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not enabled or access_mode <> 'blocked'),
  check (not redistribution_allowed or rights_state in ('internal','approved'))
);

insert into public.combat_sources
  (source_key, source_name, source_kind, homepage_url, license_name, access_mode, rights_state, redistribution_allowed, enabled, rights_note, reviewed_at)
values
  ('ufc_canonical', 'PropBetEdge UFC canonical graph', 'internal', null, 'internal normalized facts', 'approved_ingest', 'internal', true, true,
    'Existing normalized UFC facts. This source key is for bridge/bootstrap records only; it does not change the upstream rights posture of UFC Stats or ESPN.', now()),
  ('ufcstats', 'UFC Stats', 'reference', 'http://ufcstats.com/', null, 'identity_only', 'reference_only', false, true,
    'Allowed here only as an identity namespace already present on ufc_fighters. New cross-promotion fact collection remains separately gated.', now()),
  ('espn', 'ESPN', 'data_provider', 'https://www.espn.com/mma/', null, 'identity_only', 'reference_only', false, true,
    'Allowed here only as an identity namespace already resolved on ufc_fighters. Do not treat this as approval for new combat fact ingestion.', now()),
  ('wikidata', 'Wikidata', 'open_data', 'https://www.wikidata.org/', 'CC0 1.0', 'approved_ingest', 'approved', true, true,
    'Open identity/reference layer. Sparse for bout-level MMA history; never use absence as evidence that a bout did not happen.', now()),
  ('ufc_official', 'UFC.com', 'promotion', 'https://www.ufc.com/', null, 'review_required', 'unknown', false, false,
    'Promotion-native source. Existing UFC collectors are unaffected; new combat_* collection must be explicitly reviewed before enablement.', null),
  ('athletic_commission', 'Athletic commission source', 'commission', null, null, 'review_required', 'unknown', false, false,
    'Jurisdiction-specific terms and formats; approve concrete commission adapters individually.', null),
  ('sherdog', 'Sherdog Fight Finder', 'reference', 'https://www.sherdog.com/', null, 'review_required', 'unknown', false, false,
    'Potential career-history discovery/reference source. No automated collection until terms/licensing are reviewed.', null),
  ('tapology', 'Tapology', 'reference', 'https://www.tapology.com/', null, 'review_required', 'unknown', false, false,
    'Potential career-history discovery/reference source. No automated collection until terms/licensing are reviewed.', null),
  ('fightmatrix', 'FightMatrix', 'reference', 'https://www.fightmatrix.com/', null, 'review_required', 'unknown', false, false,
    'Potential ranking/history reference source. No automated collection until terms/licensing are reviewed.', null),
  ('mma_decisions', 'MMA Decisions', 'reference', 'https://mmadecisions.com/', null, 'review_required', 'unknown', false, false,
    'Potential scorecard reference source. No automated collection until terms/licensing are reviewed.', null),
  ('fight_forensics', 'Fight Forensics', 'data_provider', 'https://fightforensics.com/', null, 'review_required', 'unknown', false, false,
    'API terms permit attributed applications but prohibit bulk/systematic dataset extraction and ML-model use. Keep disabled for persisted Career DNA ingestion unless written permission or a suitable agreement is obtained.', null),
  ('ufcalendar', 'UFCalendar Fight API', 'data_provider', 'https://www.ufcalendar.com/developers', null, 'review_required', 'unknown', false, false,
    'Paid terms permit commercial display and analysis but limit raw/bulk redistribution below Enterprise. Candidate provider only after the chosen plan/contract is confirmed for persistence and downstream product/API use.', null),
  ('combat_registry', 'Combat Registry / MixedMartialArts.com', 'reference', 'https://events.mixedmartialarts.com/results', null, 'blocked', 'prohibited', false, false,
    'ABC official record-keeper value is high, but current site terms prohibit scraping/copying and redistribution without consent. No automated access unless a written data agreement changes this state.', null),
  ('sportsdataio', 'SportsDataIO MMA', 'data_provider', 'https://sportsdata.io/', null, 'review_required', 'unknown', false, false,
    'Commercial provider candidate. Enable only after contract scope, storage and redistribution rights are confirmed.', null),
  ('sportradar', 'Sportradar MMA', 'data_provider', 'https://developer.sportradar.com/mma/', null, 'review_required', 'unknown', false, false,
    'Commercial provider candidate. Enable only after contract scope, storage and redistribution rights are confirmed.', null),
  ('promotion_official', 'Promotion official source', 'promotion', null, null, 'review_required', 'unknown', false, false,
    'Placeholder for promotion-native adapters. Each promotion should receive its own concrete source row before ingestion.', null)
on conflict (source_key) do nothing;

create table if not exists public.combat_fighters (
  id uuid primary key default gen_random_uuid(),
  ufc_fighter_id uuid unique references public.ufc_fighters(id) on delete restrict,
  display_name text not null,
  normalized_name text,
  dob date,
  nationality text,
  career_status text not null default 'unknown'
    check (career_status in ('active','inactive','retired','unknown')),
  identity_state text not null default 'review_required'
    check (identity_state in ('verified','source_native','review_required','merged')),
  merged_into_id uuid references public.combat_fighters(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((identity_state = 'merged') = (merged_into_id is not null)),
  check (merged_into_id is null or merged_into_id <> id)
);
create index if not exists combat_fighters_name_idx on public.combat_fighters (lower(display_name));
create index if not exists combat_fighters_state_idx on public.combat_fighters (identity_state, career_status);

create table if not exists public.combat_fighter_identities (
  id uuid primary key default gen_random_uuid(),
  combat_fighter_id uuid not null references public.combat_fighters(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  external_id text not null,
  external_url text,
  display_name text,
  dob date,
  verification_state text not null default 'review'
    check (verification_state in ('verified','probable','review','rejected')),
  confidence smallint not null default 0 check (confidence between 0 and 100),
  evidence jsonb not null default '{}'::jsonb,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  unique (source_id, external_id),
  unique (combat_fighter_id, source_id, external_id)
);
create index if not exists combat_fighter_identities_fighter_idx on public.combat_fighter_identities (combat_fighter_id);
create index if not exists combat_fighter_identities_verify_idx on public.combat_fighter_identities (verification_state, confidence desc);

create table if not exists public.combat_fighter_aliases (
  id uuid primary key default gen_random_uuid(),
  combat_fighter_id uuid not null references public.combat_fighters(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  alias text not null,
  normalized text not null,
  kind text not null default 'name' check (kind in ('name','nickname','transliteration','former_name','other')),
  verification_state text not null default 'verified' check (verification_state in ('verified','review','rejected')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (combat_fighter_id, source_id, normalized)
);
create index if not exists combat_fighter_aliases_norm_idx on public.combat_fighter_aliases (normalized);

create table if not exists public.combat_identity_review_queue (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  raw_external_id text,
  raw_name text not null,
  raw_dob date,
  candidate_fighter_ids uuid[] not null default '{}',
  reason text not null,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','resolved','rejected')),
  resolved_fighter_id uuid references public.combat_fighters(id) on delete restrict,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_fighter_id is not null))
);
create index if not exists combat_identity_review_status_idx on public.combat_identity_review_queue (status, created_at);

create table if not exists public.combat_promotions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  country_code text,
  website_url text,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.combat_rulesets (
  id uuid primary key default gen_random_uuid(),
  ruleset_key text not null unique,
  name text not null,
  scoring_system text,
  round_structure jsonb not null default '{}'::jsonb,
  rule_notes jsonb not null default '{}'::jsonb,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  source_url text,
  effective_from date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

insert into public.combat_promotions (slug, name, country_code, website_url, source_id, source_url)
select 'ufc', 'Ultimate Fighting Championship', 'US', 'https://www.ufc.com/', s.id, null
from public.combat_sources s where s.source_key = 'ufc_canonical'
on conflict (slug) do nothing;

create table if not exists public.combat_events (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.combat_promotions(id) on delete restrict,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  external_event_id text,
  name text not null,
  event_date date,
  venue text,
  city text,
  region text,
  country text,
  ruleset_id uuid references public.combat_rulesets(id) on delete restrict,
  status text not null default 'unknown' check (status in ('announced','scheduled','complete','cancelled','unknown')),
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_event_id)
);
create index if not exists combat_events_date_idx on public.combat_events (event_date desc);
create index if not exists combat_events_promotion_idx on public.combat_events (promotion_id, event_date desc);

create table if not exists public.combat_bouts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.combat_events(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  external_bout_id text,
  fighter_a_id uuid not null references public.combat_fighters(id) on delete restrict,
  fighter_b_id uuid not null references public.combat_fighters(id) on delete restrict,
  competition_class text not null default 'professional'
    check (competition_class in ('professional','amateur','exhibition','unknown')),
  weight_class text,
  weight_class_raw text,
  is_womens boolean,
  is_title boolean not null default false,
  title_name text,
  scheduled_rounds int check (scheduled_rounds is null or scheduled_rounds between 1 and 10),
  ruleset_id uuid references public.combat_rulesets(id) on delete restrict,
  bout_order int,
  status text not null default 'unknown' check (status in ('announced','scheduled','complete','cancelled','replaced','unknown')),
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_bout_id),
  check (fighter_a_id <> fighter_b_id)
);
create index if not exists combat_bouts_event_idx on public.combat_bouts (event_id, bout_order);
create index if not exists combat_bouts_fighter_a_idx on public.combat_bouts (fighter_a_id);
create index if not exists combat_bouts_fighter_b_idx on public.combat_bouts (fighter_b_id);
create unique index if not exists combat_bouts_event_pair_uniq
  on public.combat_bouts (event_id, least(fighter_a_id, fighter_b_id), greatest(fighter_a_id, fighter_b_id));

create table if not exists public.combat_bout_results (
  bout_id uuid primary key references public.combat_bouts(id) on delete cascade,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  outcome text not null check (outcome in ('win','draw','no_contest','unknown')),
  winner_id uuid references public.combat_fighters(id) on delete restrict,
  method text check (method is null or method in ('KO_TKO','SUB','DEC_U','DEC_S','DEC_M','DQ','NC','DRAW','OTHER')),
  method_raw text,
  round int check (round is null or round between 1 and 10),
  time_sec int check (time_sec is null or time_sec >= 0),
  referee_name text,
  source_url text not null,
  source_record jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  check ((outcome = 'win' and winner_id is not null) or (outcome <> 'win' and winner_id is null))
);

create table if not exists public.combat_round_stats (
  bout_id uuid not null references public.combat_bouts(id) on delete cascade,
  fighter_id uuid not null references public.combat_fighters(id) on delete restrict,
  round int not null check (round between 1 and 10),
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  kd int,
  sig_str_landed int, sig_str_att int,
  total_str_landed int, total_str_att int,
  td_landed int, td_att int,
  sub_att int,
  rev int,
  ctrl_sec int,
  head_landed int, head_att int,
  body_landed int, body_att int,
  leg_landed int, leg_att int,
  distance_landed int, distance_att int,
  clinch_landed int, clinch_att int,
  ground_landed int, ground_att int,
  extra jsonb not null default '{}'::jsonb,
  source_url text not null,
  captured_at timestamptz not null default now(),
  primary key (bout_id, fighter_id, round),
  check (kd is null or kd >= 0),
  check (sig_str_landed is null or sig_str_landed >= 0),
  check (sig_str_att is null or sig_str_att >= 0),
  check (sig_str_landed is null or sig_str_att is null or sig_str_landed <= sig_str_att),
  check (td_landed is null or td_landed >= 0),
  check (td_att is null or td_att >= 0),
  check (td_landed is null or td_att is null or td_landed <= td_att),
  check (ctrl_sec is null or ctrl_sec >= 0)
);
create index if not exists combat_round_stats_fighter_idx on public.combat_round_stats (fighter_id, bout_id, round);

create table if not exists public.combat_source_claims (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  entity_type text not null check (entity_type in ('fighter','identity','promotion','event','bout','result','round_stat','scorecard','weigh_in','status','other')),
  entity_id uuid,
  field_name text not null,
  value_json jsonb,
  source_url text not null,
  source_locator text,
  confidence smallint not null default 0 check (confidence between 0 and 100),
  selected boolean not null default false,
  claim_hash text not null unique,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists combat_source_claims_entity_idx on public.combat_source_claims (entity_type, entity_id, field_name);
create index if not exists combat_source_claims_source_idx on public.combat_source_claims (source_id, observed_at desc);

create table if not exists public.combat_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.combat_sources(id) on delete restrict,
  worker text not null,
  mode text not null default 'audit' check (mode in ('audit','bootstrap','import','reconcile')),
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counters jsonb not null default '{}'::jsonb,
  notes jsonb not null default '{}'::jsonb,
  error_text text
);
create index if not exists combat_import_runs_worker_idx on public.combat_import_runs (worker, started_at desc);

-- ---------------------------------------------------------------------------
-- Source gates. Identity namespaces may be enabled in identity_only mode, but
-- canonical facts require approved_ingest. This does not govern the legacy
-- ufc_* pipeline; it only guards new combat_* writers.
-- ---------------------------------------------------------------------------
create or replace function public.combat_guard_fact_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_mode text;
begin
  select enabled, access_mode into v_enabled, v_mode
  from public.combat_sources where id = new.source_id;
  if coalesce(v_enabled, false) is not true or v_mode <> 'approved_ingest' then
    raise exception 'combat fact source % is not approved_ingest/enabled', new.source_id;
  end if;
  return new;
end;
$$;

create or replace function public.combat_guard_identity_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_mode text;
begin
  select enabled, access_mode into v_enabled, v_mode
  from public.combat_sources where id = new.source_id;
  if coalesce(v_enabled, false) is not true or v_mode not in ('approved_ingest','identity_only') then
    raise exception 'combat identity source % is not enabled for identity ingestion', new.source_id;
  end if;
  return new;
end;
$$;

create or replace function public.combat_guard_claim_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_mode text;
begin
  select enabled, access_mode into v_enabled, v_mode
  from public.combat_sources where id = new.source_id;
  if coalesce(v_enabled, false) is not true or v_mode not in ('approved_ingest','reference_only') then
    raise exception 'combat claim source % is not enabled for claim collection', new.source_id;
  end if;
  return new;
end;
$$;

-- Idempotent trigger creation.
drop trigger if exists combat_promotions_source_guard on public.combat_promotions;
create trigger combat_promotions_source_guard before insert or update of source_id on public.combat_promotions
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_rulesets_source_guard on public.combat_rulesets;
create trigger combat_rulesets_source_guard before insert or update of source_id on public.combat_rulesets
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_events_source_guard on public.combat_events;
create trigger combat_events_source_guard before insert or update of source_id on public.combat_events
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_bouts_source_guard on public.combat_bouts;
create trigger combat_bouts_source_guard before insert or update of source_id on public.combat_bouts
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_bout_results_source_guard on public.combat_bout_results;
create trigger combat_bout_results_source_guard before insert or update of source_id on public.combat_bout_results
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_round_stats_source_guard on public.combat_round_stats;
create trigger combat_round_stats_source_guard before insert or update of source_id on public.combat_round_stats
for each row execute function public.combat_guard_fact_source();
drop trigger if exists combat_identity_source_guard on public.combat_fighter_identities;
create trigger combat_identity_source_guard before insert or update of source_id on public.combat_fighter_identities
for each row execute function public.combat_guard_identity_source();
drop trigger if exists combat_alias_source_guard on public.combat_fighter_aliases;
create trigger combat_alias_source_guard before insert or update of source_id on public.combat_fighter_aliases
for each row execute function public.combat_guard_identity_source();
drop trigger if exists combat_claim_source_guard on public.combat_source_claims;
create trigger combat_claim_source_guard before insert or update of source_id on public.combat_source_claims
for each row execute function public.combat_guard_claim_source();

-- ---------------------------------------------------------------------------
-- UFC identity bridge. This is deliberately an explicit sync function rather
-- than a trigger on ufc_fighters: ufc-stats-ingest remains sole owner of the
-- UFC canonical tables, while this overlay can be re-run idempotently.
-- ---------------------------------------------------------------------------
create or replace function public.combat_sync_ufc_identity()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fighters int := 0;
  v_ufcstats int := 0;
  v_espn int := 0;
  v_aliases int := 0;
begin
  insert into public.combat_fighters
    (ufc_fighter_id, display_name, dob, career_status, identity_state, updated_at)
  select
    f.id,
    f.name,
    f.dob,
    case when f.is_active is true then 'active' when f.is_active is false then 'inactive' else 'unknown' end,
    'verified',
    now()
  from public.ufc_fighters f
  on conflict (ufc_fighter_id) do update set
    display_name = excluded.display_name,
    dob = excluded.dob,
    career_status = excluded.career_status,
    identity_state = case when public.combat_fighters.identity_state = 'merged' then 'merged' else 'verified' end,
    updated_at = now()
  where public.combat_fighters.display_name is distinct from excluded.display_name
     or public.combat_fighters.dob is distinct from excluded.dob
     or public.combat_fighters.career_status is distinct from excluded.career_status
     or public.combat_fighters.identity_state not in ('verified','merged');
  get diagnostics v_fighters = row_count;

  insert into public.combat_fighter_identities
    (combat_fighter_id, source_id, external_id, display_name, dob, verification_state, confidence, evidence, last_observed_at)
  select cf.id, s.id, f.ufcstats_id, f.name, f.dob, 'verified', 100,
    jsonb_build_object('bridge', 'ufc_fighters.ufcstats_id', 'ufc_fighter_id', f.id), now()
  from public.ufc_fighters f
  join public.combat_fighters cf on cf.ufc_fighter_id = f.id
  join public.combat_sources s on s.source_key = 'ufcstats'
  where f.ufcstats_id is not null
  on conflict (source_id, external_id) do update set
    combat_fighter_id = excluded.combat_fighter_id,
    display_name = excluded.display_name,
    dob = excluded.dob,
    verification_state = 'verified',
    confidence = 100,
    evidence = excluded.evidence,
    last_observed_at = now();
  get diagnostics v_ufcstats = row_count;

  insert into public.combat_fighter_identities
    (combat_fighter_id, source_id, external_id, display_name, dob, verification_state, confidence, evidence, last_observed_at)
  select cf.id, s.id, f.espn_athlete_id, f.name, f.dob, 'verified', 100,
    jsonb_build_object('bridge', 'ufc_fighters.espn_athlete_id', 'ufc_fighter_id', f.id), now()
  from public.ufc_fighters f
  join public.combat_fighters cf on cf.ufc_fighter_id = f.id
  join public.combat_sources s on s.source_key = 'espn'
  where f.espn_athlete_id is not null
  on conflict (source_id, external_id) do update set
    combat_fighter_id = excluded.combat_fighter_id,
    display_name = excluded.display_name,
    dob = excluded.dob,
    verification_state = 'verified',
    confidence = 100,
    evidence = excluded.evidence,
    last_observed_at = now();
  get diagnostics v_espn = row_count;

  insert into public.combat_fighter_aliases
    (combat_fighter_id, source_id, alias, normalized, kind, verification_state, evidence)
  select cf.id, s.id, a.alias, a.normalized,
    case when a.source like '%nickname%' then 'nickname' else 'name' end,
    'verified', jsonb_build_object('bridge', 'ufc_fighter_aliases', 'original_source', a.source)
  from public.ufc_fighter_aliases a
  join public.combat_fighters cf on cf.ufc_fighter_id = a.fighter_id
  join public.combat_sources s on s.source_key = 'ufc_canonical'
  on conflict (combat_fighter_id, source_id, normalized) do nothing;
  get diagnostics v_aliases = row_count;

  return jsonb_build_object(
    'fighters_upserted', v_fighters,
    'ufcstats_identities_upserted', v_ufcstats,
    'espn_identities_upserted', v_espn,
    'aliases_inserted', v_aliases,
    'linked_fighters', (select count(*) from public.combat_fighters where ufc_fighter_id is not null),
    'total_ufc_fighters', (select count(*) from public.ufc_fighters)
  );
end;
$$;

-- Bootstrap the current canonical UFC roster into the combat identity layer.
select public.combat_sync_ufc_identity();

-- ---------------------------------------------------------------------------
-- Unified career read model. UFC rows stay in ufc_*; non-UFC rows live in
-- combat_* and are unioned here. A consumer can always tell which scope a row
-- came from. Do not silently blend samples in Fight DNA.
-- ---------------------------------------------------------------------------
create or replace view public.combat_career_bouts
with (security_invoker = true)
as
select
  ('ufc:' || b.id::text) as career_bout_key,
  'ufc'::text as source_scope,
  ca.id as fighter_a_id,
  cb.id as fighter_b_id,
  cw.id as winner_id,
  'ufc'::text as promotion_slug,
  'Ultimate Fighting Championship'::text as promotion_name,
  e.name as event_name,
  e.event_date,
  b.weight_class,
  b.weight_class_raw,
  b.is_womens,
  b.is_title,
  'professional'::text as competition_class,
  b.scheduled_rounds,
  b.status,
  case
    when r.method = 'DRAW' then 'draw'
    when r.method = 'NC' then 'no_contest'
    when r.winner_id is not null then 'win'
    else 'unknown'
  end::text as outcome,
  r.method,
  r.method_raw,
  r.round,
  r.time_sec,
  b.source_url,
  b.id as ufc_bout_id,
  null::uuid as combat_bout_id
from public.ufc_bouts b
join public.ufc_events e on e.id = b.event_id
join public.combat_fighters ca on ca.ufc_fighter_id = b.fighter_a_id
join public.combat_fighters cb on cb.ufc_fighter_id = b.fighter_b_id
left join public.ufc_bout_results r on r.bout_id = b.id
left join public.combat_fighters cw on cw.ufc_fighter_id = r.winner_id

union all

select
  ('combat:' || b.id::text) as career_bout_key,
  'combat'::text as source_scope,
  b.fighter_a_id,
  b.fighter_b_id,
  r.winner_id,
  p.slug as promotion_slug,
  p.name as promotion_name,
  e.name as event_name,
  e.event_date,
  b.weight_class,
  b.weight_class_raw,
  b.is_womens,
  b.is_title,
  b.competition_class,
  b.scheduled_rounds,
  b.status,
  coalesce(r.outcome, 'unknown') as outcome,
  r.method,
  r.method_raw,
  r.round,
  r.time_sec,
  b.source_url,
  null::uuid as ufc_bout_id,
  b.id as combat_bout_id
from public.combat_bouts b
join public.combat_events e on e.id = b.event_id
join public.combat_promotions p on p.id = e.promotion_id
left join public.combat_bout_results r on r.bout_id = b.id;

create or replace view public.combat_fighter_career_summary
with (security_invoker = true)
as
with expanded as (
  select fighter_a_id as fighter_id, * from public.combat_career_bouts
  union all
  select fighter_b_id as fighter_id, * from public.combat_career_bouts
)
select
  f.id as combat_fighter_id,
  f.ufc_fighter_id,
  f.display_name,
  count(e.career_bout_key)::int as career_appearances,
  count(e.career_bout_key) filter (where e.source_scope = 'ufc')::int as ufc_appearances,
  count(e.career_bout_key) filter (where e.source_scope = 'combat')::int as external_appearances,
  count(e.career_bout_key) filter (where e.outcome = 'win' and e.winner_id = f.id)::int as wins,
  count(e.career_bout_key) filter (where e.outcome = 'win' and e.winner_id is distinct from f.id)::int as losses,
  count(e.career_bout_key) filter (where e.outcome = 'draw')::int as draws,
  count(e.career_bout_key) filter (where e.outcome = 'no_contest')::int as no_contests,
  count(distinct e.promotion_slug) filter (where e.career_bout_key is not null)::int as promotions_seen,
  min(e.event_date) as first_bout_date,
  max(e.event_date) as last_bout_date
from public.combat_fighters f
left join expanded e on e.fighter_id = f.id
where f.identity_state <> 'merged'
group by f.id, f.ufc_fighter_id, f.display_name;

create or replace view public.combat_ufc_bridge_coverage
with (security_invoker = true)
as
select
  (select count(*) from public.ufc_fighters)::int as total_ufc_fighters,
  (select count(*) from public.combat_fighters where ufc_fighter_id is not null)::int as linked_combat_fighters,
  (select count(*) from public.ufc_fighters where ufcstats_id is not null)::int as ufcstats_ids,
  (select count(*) from public.ufc_fighters where espn_athlete_id is not null)::int as espn_ids,
  (select count(*) from public.combat_fighter_identities ci join public.combat_sources s on s.id = ci.source_id where s.source_key = 'ufcstats')::int as bridged_ufcstats_ids,
  (select count(*) from public.combat_fighter_identities ci join public.combat_sources s on s.id = ci.source_id where s.source_key = 'espn')::int as bridged_espn_ids,
  (select count(*) from public.combat_identity_review_queue where status = 'pending')::int as pending_identity_reviews,
  (select count(*) from public.combat_bouts)::int as external_bouts,
  (select count(distinct promotion_id) from public.combat_events)::int as external_promotions_with_events;

-- RLS / privileges. Service role only; there is no public combat data plane yet.
alter table public.combat_sources enable row level security;
alter table public.combat_fighters enable row level security;
alter table public.combat_fighter_identities enable row level security;
alter table public.combat_fighter_aliases enable row level security;
alter table public.combat_identity_review_queue enable row level security;
alter table public.combat_promotions enable row level security;
alter table public.combat_rulesets enable row level security;
alter table public.combat_events enable row level security;
alter table public.combat_bouts enable row level security;
alter table public.combat_bout_results enable row level security;
alter table public.combat_round_stats enable row level security;
alter table public.combat_source_claims enable row level security;
alter table public.combat_import_runs enable row level security;

revoke all on table public.combat_sources, public.combat_fighters, public.combat_fighter_identities,
  public.combat_fighter_aliases, public.combat_identity_review_queue, public.combat_promotions,
  public.combat_rulesets, public.combat_events, public.combat_bouts, public.combat_bout_results,
  public.combat_round_stats, public.combat_source_claims, public.combat_import_runs
from public, anon, authenticated;

grant select, insert, update on table public.combat_sources, public.combat_fighters, public.combat_fighter_identities,
  public.combat_fighter_aliases, public.combat_identity_review_queue, public.combat_promotions,
  public.combat_rulesets, public.combat_events, public.combat_bouts, public.combat_bout_results,
  public.combat_round_stats, public.combat_source_claims, public.combat_import_runs
to service_role;

revoke all on table public.combat_career_bouts, public.combat_fighter_career_summary, public.combat_ufc_bridge_coverage
from public, anon, authenticated;
grant select on table public.combat_career_bouts, public.combat_fighter_career_summary, public.combat_ufc_bridge_coverage
to service_role;

revoke all on function public.combat_sync_ufc_identity() from public, anon, authenticated;
grant execute on function public.combat_sync_ufc_identity() to service_role;
revoke all on function public.combat_guard_fact_source() from public, anon, authenticated;
revoke all on function public.combat_guard_identity_source() from public, anon, authenticated;
revoke all on function public.combat_guard_claim_source() from public, anon, authenticated;

comment on table public.combat_fighters is 'Cross-promotion MMA identity shell. UFC-specific facts remain authoritative in ufc_*; this table links one person across promotions/sources.';
comment on view public.combat_career_bouts is 'Unioned career read model: UFC canonical bouts plus separately sourced combat_* bouts. source_scope must be preserved by consumers.';
comment on table public.combat_sources is 'Operational source-rights gate for new combat_* ingestion. A public webpage is not automatically an approved ingest source.';

commit;
