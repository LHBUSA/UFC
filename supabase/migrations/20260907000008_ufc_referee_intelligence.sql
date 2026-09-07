-- Referee Intelligence
-- Canonical referee identities, optional sourced bio enrichment, and archive-derived
-- fight-impact statistics. Rates are descriptive historical tendencies only.

create table if not exists public.ufc_referee_profiles (
  canonical_name text primary key,
  slug text not null unique,
  display_name text not null,
  bio text,
  bio_source_url text,
  bio_source_name text,
  bio_verified_at timestamptz,
  country text,
  image_url text,
  image_source_url text,
  image_credit text,
  image_license text,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ufc_referee_aliases (
  raw_name text primary key,
  canonical_name text not null references public.ufc_referee_profiles(canonical_name) on delete cascade,
  source_note text,
  created_at timestamptz not null default now()
);

insert into public.ufc_referee_profiles (canonical_name, slug, display_name)
select distinct btrim(referee),
       trim(both '-' from regexp_replace(lower(btrim(referee)), '[^a-z0-9]+', '-', 'g')),
       btrim(referee)
from public.ufc_bout_results
where referee is not null and btrim(referee) <> ''
on conflict (canonical_name) do nothing;

insert into public.ufc_referee_aliases (raw_name, canonical_name, source_note)
values
  ('Lukas Bosacki', 'Lukasz Bosacki', 'Archive spelling variant; canonicalized to Lukasz Bosacki.'),
  ('Horacio Villanueva', 'Horacio Lopez Villanueva', 'Archive shortened-name variant; canonicalized to full stored name.')
on conflict (raw_name) do update set canonical_name = excluded.canonical_name, source_note = excluded.source_note;

delete from public.ufc_referee_profiles p
where p.canonical_name in ('Lukas Bosacki','Horacio Villanueva')
  and exists (select 1 from public.ufc_referee_aliases a where a.raw_name = p.canonical_name);

create or replace view public.ufc_referee_stats as
with normalized as (
  select
    coalesce(a.canonical_name, btrim(r.referee)) as referee_name,
    r.method,
    r.round,
    r.time_sec,
    r.bout_id,
    b.is_title,
    b.scheduled_rounds,
    e.event_date
  from public.ufc_bout_results r
  join public.ufc_bouts b on b.id = r.bout_id
  join public.ufc_events e on e.id = b.event_id
  left join public.ufc_referee_aliases a on a.raw_name = btrim(r.referee)
  where r.referee is not null and btrim(r.referee) <> ''
), agg as (
  select
    referee_name as name,
    count(*)::int as bouts,
    count(*) filter (where method in ('KO_TKO','SUB','DQ'))::int as stoppages,
    count(*) filter (where method = 'KO_TKO')::int as ko_tko,
    count(*) filter (where method = 'SUB')::int as submissions,
    count(*) filter (where method in ('DEC_U','DEC_S','DEC_M'))::int as decisions,
    count(*) filter (where method = 'DEC_S')::int as split_decisions,
    count(*) filter (where method in ('NC','DRAW'))::int as nc_draws,
    count(*) filter (where is_title)::int as title_bouts,
    count(*) filter (where scheduled_rounds = 5 or is_title)::int as five_round_bouts,
    round(avg(((coalesce(round,1)-1) * 300 + coalesce(time_sec,0)))::numeric)::int as avg_fight_seconds,
    round(avg(((coalesce(round,1)-1) * 300 + coalesce(time_sec,0))) filter (where method in ('KO_TKO','SUB','DQ'))::numeric)::int as avg_stoppage_seconds,
    min(event_date) as first_event_date,
    max(event_date) as last_event_date
  from normalized
  group by referee_name
), baseline as (
  select
    count(*)::numeric as all_bouts,
    count(*) filter (where method in ('KO_TKO','SUB','DQ'))::numeric as all_stoppages,
    count(*) filter (where method in ('DEC_U','DEC_S','DEC_M'))::numeric as all_decisions
  from normalized
)
select
  a.*,
  case when a.bouts > 0 then round((a.stoppages::numeric / a.bouts) * 100,1) else null end as stoppage_rate,
  case when a.bouts > 0 then round((a.decisions::numeric / a.bouts) * 100,1) else null end as decision_rate,
  case when a.decisions > 0 then round((a.split_decisions::numeric / a.decisions) * 100,1) else null end as split_decision_share,
  round((baseline.all_stoppages / nullif(baseline.all_bouts,0)) * 100,1) as archive_stoppage_rate,
  round((baseline.all_decisions / nullif(baseline.all_bouts,0)) * 100,1) as archive_decision_rate
from agg a cross join baseline;

create or replace view public.ufc_referee_directory as
select
  s.*,
  p.slug,
  coalesce(p.display_name, s.name) as display_name,
  p.bio,
  p.bio_source_url,
  p.bio_source_name,
  p.bio_verified_at,
  p.country,
  p.image_url,
  p.image_source_url,
  p.image_credit,
  p.image_license
from public.ufc_referee_stats s
left join public.ufc_referee_profiles p on p.canonical_name = s.name;

create or replace view public.ufc_referee_bouts as
select
  coalesce(a.canonical_name, btrim(r.referee)) as referee_name,
  p.slug as referee_slug,
  r.bout_id,
  r.method,
  r.method_raw,
  r.round,
  r.time_sec,
  r.finish_detail,
  r.result_source,
  r.has_stats,
  b.weight_class,
  b.is_womens,
  b.is_title,
  b.scheduled_rounds,
  b.card_position,
  e.id as event_id,
  e.name as event_name,
  e.event_date,
  e.venue,
  e.city,
  e.region,
  e.country,
  fa.id as fighter_a_id,
  fa.name as fighter_a_name,
  fb.id as fighter_b_id,
  fb.name as fighter_b_name,
  r.winner_id,
  case when r.winner_id = fa.id then fa.name when r.winner_id = fb.id then fb.name else null end as winner_name,
  r.source_url
from public.ufc_bout_results r
join public.ufc_bouts b on b.id = r.bout_id
join public.ufc_events e on e.id = b.event_id
join public.ufc_fighters fa on fa.id = b.fighter_a_id
join public.ufc_fighters fb on fb.id = b.fighter_b_id
left join public.ufc_referee_aliases a on a.raw_name = btrim(r.referee)
left join public.ufc_referee_profiles p on p.canonical_name = coalesce(a.canonical_name, btrim(r.referee))
where r.referee is not null and btrim(r.referee) <> '';

alter table public.ufc_referee_profiles enable row level security;
alter table public.ufc_referee_aliases enable row level security;
comment on table public.ufc_referee_profiles is 'Optional sourced biographical enrichment for MMA referees. Historical fight-impact statistics are computed from canonical UFC bout results, not hand-entered.';
comment on view public.ufc_referee_stats is 'Historical referee sample from stored UFC results. Rates describe observed bouts and must not be presented as causal referee effects.';
comment on view public.ufc_referee_bouts is 'Normalized referee-to-bout archive with event and fighter context for referee profile pages.';
