-- 032_ufc_training_corner.sql
--
-- UFC Training & Corner: where a fighter trains, who coaches them, where they
-- fight out of — as an append-only, sourced history, never one mutable column.
--
-- OWNER DECISION 2026-09-26 (Justin Erickson): ESPN athlete `association`
-- (id + name only) is approved as the UFC current-camp signal. It is captured
-- from the athlete document ufc-stats-ingest already reads. association.location
-- is the FIGHTER's national context, not the gym's, and is never stored as a
-- training location. Customer-facing attribution is PropSports; the upstream
-- name lives here and in API provenance only. Source/rights audit:
-- docs/UFC_TRAINING_SOURCE_MATRIX.md.
--
-- FOUR FACTS, NEVER CONFLATED
--   AFFILIATION        a camp (relationship_type says which kind: PRIMARY_CAMP,
--                      AFFILIATION, TEMPORARY_CAMP, CROSS_TRAINING, FIGHT_CAMP)
--   FIGHTING_OUT_OF    the place the fighter represents (not a gym)
--   TRAINING_LOCATION  the physical training base (optionally the gym)
--   COACH              a named coach with a stated role
--
-- TRUTH RULES ENFORCED HERE
--   * ufc_training_observations is append-only. The only mutation allowed is the
--     re-confirmation stamp (last_confirmed_at, confirm_count) an unchanged
--     re-capture writes. Rows are never deleted.
--   * An OBSERVED row cannot carry effective dates: we saw it, the source did
--     not date it. Only STATED rows (a source that says when) have dates.
--   * Change events are append-only; a later CONFIRMED switch points at the
--     OBSERVED event it upgrades (supersedes_event_id) instead of replacing it.
--   * Every fact references combat_sources (rights state) and carries source_url
--     and captured_at.
--   * Fighter identity is ufc_fighters.id; the ESPN path is keyed on
--     espn_athlete_id and checked. Camp identity prefers the ESPN association id.

begin;

insert into public.combat_sources
  (source_key, source_name, source_kind, homepage_url, license_name, access_mode, rights_state, redistribution_allowed, enabled, rights_note, reviewed_at)
values
  ('espn_athlete_association', 'ESPN athlete association (UFC current camp)', 'data_provider', 'https://www.espn.com/mma/', null,
    'approved_ingest', 'approved', false, true,
    'OWNER DECISION 2026-09-26 (Justin Erickson): approved for UFC Training & Corner. Only association.id and association.name are captured, from the athlete document ufc-stats-ingest already reads. association.location is NOT a training location. Customer-facing attribution is PropSports.', now()),
  ('ufc_training_manual', 'Manually entered, cited training facts', 'internal', null, 'cited facts',
    'approved_ingest', 'internal', true, true,
    'Entered with scripts/training/enrich.mjs. Each row cites the page it was read from in source_url; facts only, never copied bio prose.', now())
on conflict (source_key) do nothing;

create or replace function public.ufc_training_norm(t text) returns text
language sql immutable parallel safe as $$
  select nullif(btrim(regexp_replace(lower(coalesce(t, '')), '[^[:alnum:]]+', ' ', 'g')), '')
$$;

create table public.ufc_training_camps (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null check (btrim(canonical_name) <> ''),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_norm text generated always as (public.ufc_training_norm(canonical_name)) stored,
  city text, region text, country text,   -- the GYM's own location, only when sourced for the gym
  website text,
  espn_association_id text unique,        -- canonical external camp id where ESPN has one
  wikidata_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ufc_training_camps_norm_idx on public.ufc_training_camps (name_norm);

create table public.ufc_training_camp_aliases (
  id uuid primary key default gen_random_uuid(),
  camp_id uuid not null references public.ufc_training_camps(id) on delete cascade,
  alias text not null check (btrim(alias) <> ''),
  alias_norm text generated always as (public.ufc_training_norm(alias)) stored,
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (camp_id, alias_norm)
);
create index ufc_training_camp_aliases_norm_idx on public.ufc_training_camp_aliases (alias_norm);

create table public.ufc_coaches (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null check (btrim(canonical_name) <> ''),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_norm text generated always as (public.ufc_training_norm(canonical_name)) stored,
  wikidata_id text unique,
  created_at timestamptz not null default now()
);
create index ufc_coaches_norm_idx on public.ufc_coaches (name_norm);

create table public.ufc_training_observations (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id) on delete restrict,
  fact text not null check (fact in ('AFFILIATION', 'FIGHTING_OUT_OF', 'TRAINING_LOCATION', 'COACH')),
  camp_id uuid references public.ufc_training_camps(id) on delete restrict,
  coach_id uuid references public.ufc_coaches(id) on delete restrict,
  coach_role text check (coach_role is null or coach_role in
    ('HEAD', 'STRIKING', 'BOXING', 'MUAY_THAI', 'KICKBOXING', 'WRESTLING', 'GRAPPLING', 'BJJ', 'STRENGTH_CONDITIONING', 'OTHER')),
  relationship_type text check (relationship_type is null or relationship_type in
    ('PRIMARY_CAMP', 'AFFILIATION', 'TEMPORARY_CAMP', 'CROSS_TRAINING', 'FIGHT_CAMP')),
  ends_relationship boolean not null default false,   -- a STATED end of a camp/coach relationship
  value_raw text not null,                            -- exactly what the source said
  city text, region text, country text,               -- FIGHTING_OUT_OF / TRAINING_LOCATION only
  external_ref text,                                  -- e.g. the ESPN association id at capture
  effective_from date,                                -- only when the source states it
  effective_to date,
  certainty text not null check (certainty in ('STATED', 'OBSERVED')),
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  source_url text not null check (source_url ~ '^https?://'),
  source_published_at timestamptz,
  evidence_note text check (evidence_note is null or length(evidence_note) <= 500),
  captured_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  confirm_count integer not null default 1 check (confirm_count >= 1),
  obs_hash text not null unique,
  created_at timestamptz not null default now(),
  check (fact <> 'AFFILIATION' or (camp_id is not null and relationship_type is not null)),
  check (fact <> 'COACH' or (coach_id is not null and coach_role is not null)),
  check (fact not in ('FIGHTING_OUT_OF', 'TRAINING_LOCATION') or coalesce(city, region, country) is not null),
  check (fact = 'COACH' or coach_id is null),
  check (fact not in ('FIGHTING_OUT_OF') or camp_id is null),
  check (certainty = 'STATED' or (effective_from is null and effective_to is null and not ends_relationship)),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (last_confirmed_at >= captured_at)
);
create index ufc_training_obs_fighter_idx on public.ufc_training_observations (fighter_id, fact, captured_at desc);
create index ufc_training_obs_camp_idx on public.ufc_training_observations (camp_id) where camp_id is not null;
create index ufc_training_obs_coach_idx on public.ufc_training_observations (coach_id) where coach_id is not null;

create or replace function public.ufc_training_observations_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ufc_training_observations is append-only' using errcode = 'restrict_violation';
  end if;
  -- Only the re-confirmation stamp may move, and only forward.
  if (to_jsonb(new) - 'last_confirmed_at' - 'confirm_count') is distinct from (to_jsonb(old) - 'last_confirmed_at' - 'confirm_count')
     or new.last_confirmed_at < old.last_confirmed_at or new.confirm_count < old.confirm_count then
    raise exception 'ufc_training_observations is append-only (only last_confirmed_at/confirm_count may advance)' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger ufc_training_observations_guard before update or delete on public.ufc_training_observations
  for each row execute function public.ufc_training_observations_guard();

create table public.ufc_training_change_events (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id) on delete restrict,
  kind text not null check (kind in ('CAMP_CHANGED_CONFIRMED', 'AFFILIATION_CHANGED_OBSERVED',
    'COACH_ADDED', 'COACH_REMOVED', 'FIGHTING_OUT_OF_CHANGED')),
  previous_value text,
  new_value text,
  previous_camp_id uuid references public.ufc_training_camps(id),
  new_camp_id uuid references public.ufc_training_camps(id),
  previous_observation_id uuid references public.ufc_training_observations(id),
  new_observation_id uuid not null references public.ufc_training_observations(id),
  supersedes_event_id uuid references public.ufc_training_change_events(id),
  effective_on date,                    -- only for a CONFIRMED switch whose source states the date
  source_id uuid not null references public.combat_sources(id) on delete restrict,
  source_url text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (new_observation_id, kind),
  check (new_value is not null or kind = 'COACH_REMOVED'),
  check (kind <> 'AFFILIATION_CHANGED_OBSERVED' or (previous_camp_id is not null and new_camp_id is not null and previous_camp_id <> new_camp_id and effective_on is null)),
  check (kind <> 'CAMP_CHANGED_CONFIRMED' or new_camp_id is not null),
  check (supersedes_event_id is null or kind = 'CAMP_CHANGED_CONFIRMED')
);
create index ufc_training_events_fighter_idx on public.ufc_training_change_events (fighter_id, observed_at desc);

create or replace function public.ufc_training_events_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'ufc_training_change_events is append-only' using errcode = 'restrict_violation';
end $$;
create trigger ufc_training_events_guard before update or delete on public.ufc_training_change_events
  for each row execute function public.ufc_training_events_guard();

-- Slug helper: lowercase ascii words; a collision takes a numeric suffix.
create or replace function public.ufc_training_slug(p_name text, p_table text) returns text
language plpgsql as $$
declare
  base text := nullif(btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), '-'), '');
  cand text; i int := 1; hit boolean;
begin
  if base is null then base := 'camp'; end if;
  cand := base;
  loop
    if p_table = 'coaches' then select exists(select 1 from public.ufc_coaches where slug = cand) into hit;
    else select exists(select 1 from public.ufc_training_camps where slug = cand) into hit; end if;
    exit when not hit;
    i := i + 1; cand := base || '-' || i;
  end loop;
  return cand;
end $$;

-- ESPN current-camp capture. One call per athlete document read.
--   first      no prior ESPN observation: a new OBSERVED row ("first observed")
--   confirmed  same association id as the latest ESPN observation: stamp only
--   changed    a different association id: a new OBSERVED row + AFFILIATION_CHANGED_OBSERVED
--   absent     the document carries no association: nothing is written (unknown stays unknown)
--   identity_mismatch  the fighter row does not hold that espn_athlete_id: nothing is written
create or replace function public.ufc_training_record_association(
  p_fighter_id uuid, p_espn_athlete_id text, p_association_id text, p_association_name text,
  p_source_url text, p_captured_at timestamptz default now()
) returns jsonb
language plpgsql set search_path = public as $$
declare
  src uuid; camp uuid; camp_name text; prev record; obs uuid; ev uuid; attached boolean := false;
  aid text := nullif(btrim(coalesce(p_association_id, '')), '');
  aname text := nullif(btrim(coalesce(p_association_name, '')), '');
begin
  if not exists (select 1 from ufc_fighters where id = p_fighter_id and espn_athlete_id = p_espn_athlete_id) then
    return jsonb_build_object('action', 'identity_mismatch');
  end if;
  if aid is null or aname is null then
    return jsonb_build_object('action', 'absent');
  end if;
  select id into src from combat_sources where source_key = 'espn_athlete_association' and enabled;
  if src is null then raise exception 'combat_sources.espn_athlete_association missing or disabled'; end if;

  perform pg_advisory_xact_lock(hashtext('ufc_training:' || p_fighter_id::text));

  select id, canonical_name into camp, camp_name from ufc_training_camps where espn_association_id = aid;
  if camp is null then
    -- A manually created camp with the same normalized name and no ESPN id yet is the same camp: attach the id.
    select id, canonical_name into camp, camp_name from ufc_training_camps
      where espn_association_id is null and name_norm = ufc_training_norm(aname)
      order by created_at limit 1;
    if camp is not null then
      update ufc_training_camps set espn_association_id = aid, updated_at = now() where id = camp;
      attached := true;
    else
      insert into ufc_training_camps (canonical_name, slug, espn_association_id)
        values (aname, ufc_training_slug(aname, 'camps'), aid) returning id, canonical_name into camp, camp_name;
    end if;
  end if;
  insert into ufc_training_camp_aliases (camp_id, alias, source_id) values (camp, aname, src)
    on conflict (camp_id, alias_norm) do nothing;

  select o.id, o.camp_id, o.last_confirmed_at, c.canonical_name as camp_name into prev
    from ufc_training_observations o join ufc_training_camps c on c.id = o.camp_id
    where o.fighter_id = p_fighter_id and o.fact = 'AFFILIATION' and o.source_id = src
    order by o.captured_at desc, o.id desc limit 1;

  if prev.id is not null and prev.camp_id = camp then
    update ufc_training_observations
      set last_confirmed_at = greatest(last_confirmed_at, p_captured_at), confirm_count = confirm_count + 1
      where id = prev.id and p_captured_at >= last_confirmed_at;
    return jsonb_build_object('action', 'confirmed', 'camp_id', camp, 'observation_id', prev.id, 'attached_by_name', attached);
  end if;

  insert into ufc_training_observations (fighter_id, fact, camp_id, relationship_type, value_raw, external_ref,
      certainty, source_id, source_url, captured_at, last_confirmed_at, obs_hash)
    values (p_fighter_id, 'AFFILIATION', camp, 'AFFILIATION', aname, aid, 'OBSERVED', src, p_source_url,
      p_captured_at, p_captured_at, md5('espn_assoc|' || p_fighter_id || '|' || aid || '|' || p_captured_at::text))
    returning id into obs;

  if prev.id is null then
    return jsonb_build_object('action', 'first', 'camp_id', camp, 'observation_id', obs, 'attached_by_name', attached);
  end if;

  insert into ufc_training_change_events (fighter_id, kind, previous_value, new_value, previous_camp_id, new_camp_id,
      previous_observation_id, new_observation_id, source_id, source_url, observed_at)
    values (p_fighter_id, 'AFFILIATION_CHANGED_OBSERVED', prev.camp_name, camp_name, prev.camp_id, camp,
      prev.id, obs, src, p_source_url, p_captured_at)
    returning id into ev;
  return jsonb_build_object('action', 'changed', 'camp_id', camp, 'observation_id', obs, 'event_id', ev,
    'previous_camp_id', prev.camp_id, 'attached_by_name', attached);
end $$;

-- Manual, cited facts (scripts/training/enrich.mjs). p carries ids already resolved by the CLI.
--   kind: fighting_out_of | training_location | coach | coach_end | camp | camp_end | switch
create or replace function public.ufc_training_add_manual(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  src uuid; k text := p->>'kind'; f uuid := (p->>'fighter_id')::uuid;
  url text := p->>'source_url'; cap timestamptz := coalesce((p->>'captured_at')::timestamptz, clock_timestamp());  -- wall clock: two facts in one transaction stay ordered
  eff_from date := (p->>'effective_from')::date; eff_to date := (p->>'effective_to')::date;
  pub timestamptz := (p->>'source_published_at')::timestamptz; note text := p->>'evidence_note';
  camp uuid := (p->>'camp_id')::uuid; coach uuid := (p->>'coach_id')::uuid; role text := p->>'coach_role';
  rel text := coalesce(p->>'relationship_type', 'PRIMARY_CAMP');
  obs uuid; ev uuid; prev record; hash text; nm text; prev_camp uuid := (p->>'from_camp_id')::uuid; prev_name text; sup uuid;
begin
  if f is null or url is null or k is null then raise exception 'fighter_id, kind and source_url are required'; end if;
  if not exists (select 1 from ufc_fighters where id = f) then raise exception 'fighter % not found', f; end if;
  select id into src from combat_sources where source_key = 'ufc_training_manual' and enabled;
  hash := md5('manual|' || p::text);
  if exists (select 1 from ufc_training_observations where obs_hash = hash) then
    return jsonb_build_object('action', 'duplicate');
  end if;
  perform pg_advisory_xact_lock(hashtext('ufc_training:' || f::text));

  if k in ('fighting_out_of', 'training_location') then
    select o.id, concat_ws(', ', o.city, o.region, o.country) as v into prev from ufc_training_observations o
      where o.fighter_id = f and o.fact = upper(k) order by o.captured_at desc, o.id desc limit 1;
    insert into ufc_training_observations (fighter_id, fact, camp_id, value_raw, city, region, country,
        effective_from, certainty, source_id, source_url, source_published_at, evidence_note, captured_at, last_confirmed_at, obs_hash)
      values (f, upper(k), case when k = 'training_location' then camp end,
        coalesce(p->>'value_raw', concat_ws(', ', p->>'city', p->>'region', p->>'country')),
        p->>'city', p->>'region', p->>'country', eff_from, 'STATED', src, url, pub, note, cap, cap, hash)
      returning id into obs;
    if k = 'fighting_out_of' and prev.id is not null and prev.v is distinct from concat_ws(', ', p->>'city', p->>'region', p->>'country') then
      insert into ufc_training_change_events (fighter_id, kind, previous_value, new_value, previous_observation_id, new_observation_id, source_id, source_url, observed_at)
        values (f, 'FIGHTING_OUT_OF_CHANGED', prev.v, concat_ws(', ', p->>'city', p->>'region', p->>'country'), prev.id, obs, src, url, cap) returning id into ev;
    end if;

  elsif k in ('coach', 'coach_end') then
    if coach is null or role is null then raise exception 'coach_id and coach_role are required'; end if;
    select canonical_name into nm from ufc_coaches where id = coach;
    select o.id, o.ends_relationship into prev from ufc_training_observations o
      where o.fighter_id = f and o.fact = 'COACH' and o.coach_id = coach and o.coach_role = role
      order by o.captured_at desc, o.id desc limit 1;
    insert into ufc_training_observations (fighter_id, fact, coach_id, coach_role, camp_id, ends_relationship, value_raw,
        effective_from, effective_to, certainty, source_id, source_url, source_published_at, evidence_note, captured_at, last_confirmed_at, obs_hash)
      values (f, 'COACH', coach, role, camp, k = 'coach_end', coalesce(p->>'value_raw', nm), eff_from, eff_to,
        'STATED', src, url, pub, note, cap, cap, hash)
      returning id into obs;
    if k = 'coach' and (prev.id is null or prev.ends_relationship) then
      insert into ufc_training_change_events (fighter_id, kind, new_value, new_observation_id, source_id, source_url, observed_at)
        values (f, 'COACH_ADDED', nm || ' · ' || role, obs, src, url, cap) returning id into ev;
    elsif k = 'coach_end' and prev.id is not null and not prev.ends_relationship then
      insert into ufc_training_change_events (fighter_id, kind, previous_value, previous_observation_id, new_observation_id, source_id, source_url, observed_at)
        values (f, 'COACH_REMOVED', nm || ' · ' || role, prev.id, obs, src, url, cap) returning id into ev;
    end if;

  elsif k in ('camp', 'camp_end', 'switch') then
    if camp is null then raise exception 'camp_id is required'; end if;
    select canonical_name into nm from ufc_training_camps where id = camp;
    if k = 'switch' then rel := 'PRIMARY_CAMP'; end if;
    insert into ufc_training_observations (fighter_id, fact, camp_id, relationship_type, ends_relationship, value_raw,
        effective_from, effective_to, certainty, source_id, source_url, source_published_at, evidence_note, captured_at, last_confirmed_at, obs_hash)
      values (f, 'AFFILIATION', camp, rel, k = 'camp_end', coalesce(p->>'value_raw', nm), eff_from, eff_to,
        'STATED', src, url, pub, note, cap, cap, hash)
      returning id into obs;
    if k = 'switch' then
      if prev_camp is not null then select canonical_name into prev_name from ufc_training_camps where id = prev_camp; end if;
      -- The OBSERVED event this evidence upgrades, if the detector already saw the same move.
      select e.id into sup from ufc_training_change_events e
        where e.fighter_id = f and e.kind = 'AFFILIATION_CHANGED_OBSERVED' and e.new_camp_id = camp
          and (prev_camp is null or e.previous_camp_id = prev_camp)
        order by e.observed_at desc limit 1;
      insert into ufc_training_change_events (fighter_id, kind, previous_value, new_value, previous_camp_id, new_camp_id,
          new_observation_id, supersedes_event_id, effective_on, source_id, source_url, observed_at)
        values (f, 'CAMP_CHANGED_CONFIRMED', prev_name, nm, prev_camp, camp, obs, sup, eff_from, src, url, cap)
        returning id into ev;
    end if;
  else
    raise exception 'unknown kind %', k;
  end if;
  return jsonb_build_object('action', 'inserted', 'observation_id', obs, 'event_id', ev);
end $$;

-- Primary-camp timeline: consecutive observations of the same camp collapse into
-- one stint (gaps and islands). Temporary / cross-training / fight camps are not
-- stints; they are listed separately by ufc_fighter_training_current.
create view public.ufc_fighter_camp_stints with (security_invoker = true) as
with p as (
  select o.*, s.source_key, coalesce(o.effective_from::timestamptz, o.captured_at) as sort_at
  from public.ufc_training_observations o
  join public.combat_sources s on s.id = o.source_id
  where o.fact = 'AFFILIATION' and o.relationship_type in ('PRIMARY_CAMP', 'AFFILIATION') and not o.ends_relationship
), g as (
  select p.*, case when lag(p.camp_id) over (partition by p.fighter_id order by p.sort_at, p.id) is distinct from p.camp_id then 1 else 0 end as brk
  from p
), i as (
  select g.*, sum(g.brk) over (partition by g.fighter_id order by g.sort_at, g.id rows unbounded preceding) as island
  from g
), s as (
  select i.fighter_id, i.island, i.camp_id,
    min(i.sort_at) as stint_start_at,
    min(i.captured_at) as first_observed_at,
    max(i.last_confirmed_at) as last_confirmed_at,
    min(i.effective_from) filter (where i.certainty = 'STATED') as joined_on,
    bool_or(i.certainty = 'STATED') as has_stated,
    jsonb_agg(jsonb_build_object(
      'observation_id', i.id, 'source_key', i.source_key, 'source_url', i.source_url, 'certainty', i.certainty,
      'relationship_type', i.relationship_type, 'value_raw', i.value_raw, 'external_ref', i.external_ref,
      'captured_at', i.captured_at, 'last_confirmed_at', i.last_confirmed_at, 'effective_from', i.effective_from,
      'source_published_at', i.source_published_at) order by i.sort_at, i.id) as evidence
  from i group by i.fighter_id, i.island, i.camp_id
)
select s.fighter_id, s.island as stint_no, s.camp_id, c.canonical_name as camp_name, c.slug as camp_slug,
  s.stint_start_at, s.first_observed_at, s.last_confirmed_at, s.joined_on,
  case when s.has_stated then 'STATED' else 'OBSERVED' end as certainty,
  lead(s.stint_start_at) over (partition by s.fighter_id order by s.island) as next_stint_start_at,
  lead(s.first_observed_at) over (partition by s.fighter_id order by s.island) as next_first_observed_at,
  e.left_on,
  (lead(s.island) over (partition by s.fighter_id order by s.island) is null and e.end_id is null) as is_current,
  s.evidence
from s join public.ufc_training_camps c on c.id = s.camp_id
-- A STATED end of this camp relationship after the stint began closes the stint.
left join lateral (
  select x.id as end_id, x.effective_to as left_on from public.ufc_training_observations x
  where x.fighter_id = s.fighter_id and x.camp_id = s.camp_id and x.fact = 'AFFILIATION' and x.ends_relationship
    and x.relationship_type in ('PRIMARY_CAMP', 'AFFILIATION')
    and coalesce(x.effective_to::timestamptz, x.captured_at) >= s.stint_start_at
  order by x.captured_at desc limit 1
) e on true;

-- One row per fighter with any training fact: everything the API/profile needs.
create view public.ufc_fighter_training_current with (security_invoker = true) as
with fighters as (select distinct fighter_id from public.ufc_training_observations)
select fs.fighter_id,
  (select jsonb_build_object('camp_id', st.camp_id, 'name', st.camp_name, 'slug', st.camp_slug,
      'first_observed_at', st.first_observed_at, 'last_confirmed_at', st.last_confirmed_at,
      'joined_on', st.joined_on, 'certainty', st.certainty, 'evidence', st.evidence)
     from public.ufc_fighter_camp_stints st where st.fighter_id = fs.fighter_id and st.is_current limit 1) as current_camp,
  (select jsonb_build_object('city', o.city, 'region', o.region, 'country', o.country, 'value_raw', o.value_raw,
      'certainty', o.certainty, 'source_key', s.source_key, 'source_url', o.source_url, 'captured_at', o.captured_at,
      'source_published_at', o.source_published_at)
     from public.ufc_training_observations o join public.combat_sources s on s.id = o.source_id
     where o.fighter_id = fs.fighter_id and o.fact = 'FIGHTING_OUT_OF' order by o.captured_at desc, o.id desc limit 1) as fighting_out_of,
  (select jsonb_build_object('city', o.city, 'region', o.region, 'country', o.country, 'value_raw', o.value_raw,
      'camp_id', o.camp_id, 'camp_name', c.canonical_name, 'certainty', o.certainty, 'source_key', s.source_key,
      'source_url', o.source_url, 'captured_at', o.captured_at, 'source_published_at', o.source_published_at)
     from public.ufc_training_observations o join public.combat_sources s on s.id = o.source_id
     left join public.ufc_training_camps c on c.id = o.camp_id
     where o.fighter_id = fs.fighter_id and o.fact = 'TRAINING_LOCATION' order by o.captured_at desc, o.id desc limit 1) as training_location,
  coalesce((select jsonb_agg(jsonb_build_object('coach_id', x.coach_id, 'name', x.coach_name, 'slug', x.coach_slug,
      'role', x.coach_role, 'since', x.effective_from, 'certainty', x.certainty, 'source_key', x.source_key,
      'source_url', x.source_url, 'captured_at', x.captured_at) order by x.coach_role, x.coach_name)
     from (select distinct on (o.coach_id, o.coach_role) o.*, k.canonical_name as coach_name, k.slug as coach_slug, s.source_key
           from public.ufc_training_observations o join public.ufc_coaches k on k.id = o.coach_id
           join public.combat_sources s on s.id = o.source_id
           where o.fighter_id = fs.fighter_id and o.fact = 'COACH'
           order by o.coach_id, o.coach_role, o.captured_at desc, o.id desc) x
     where not x.ends_relationship), '[]'::jsonb) as coaches,
  coalesce((select jsonb_agg(jsonb_build_object('camp_id', x.camp_id, 'name', x.camp_name, 'slug', x.camp_slug,
      'relationship_type', x.relationship_type, 'since', x.effective_from, 'certainty', x.certainty,
      'source_key', x.source_key, 'source_url', x.source_url, 'captured_at', x.captured_at) order by x.captured_at desc)
     from (select distinct on (o.camp_id, o.relationship_type) o.*, c.canonical_name as camp_name, c.slug as camp_slug, s.source_key
           from public.ufc_training_observations o join public.ufc_training_camps c on c.id = o.camp_id
           join public.combat_sources s on s.id = o.source_id
           where o.fighter_id = fs.fighter_id and o.fact = 'AFFILIATION'
             and o.relationship_type in ('TEMPORARY_CAMP', 'CROSS_TRAINING', 'FIGHT_CAMP')
           order by o.camp_id, o.relationship_type, o.captured_at desc, o.id desc) x
     where not x.ends_relationship), '[]'::jsonb) as other_camps,
  (select max(greatest(o.captured_at, o.last_confirmed_at)) from public.ufc_training_observations o where o.fighter_id = fs.fighter_id) as updated_at
from fighters fs;

revoke all on public.ufc_training_camps, public.ufc_training_camp_aliases, public.ufc_coaches,
  public.ufc_training_observations, public.ufc_training_change_events,
  public.ufc_fighter_camp_stints, public.ufc_fighter_training_current from anon, authenticated;
grant select on public.ufc_training_camps, public.ufc_training_camp_aliases, public.ufc_coaches,
  public.ufc_training_observations, public.ufc_training_change_events,
  public.ufc_fighter_camp_stints, public.ufc_fighter_training_current to service_role;
grant insert, update on public.ufc_training_camps, public.ufc_coaches to service_role;
grant insert on public.ufc_training_camp_aliases to service_role;
revoke all on function public.ufc_training_record_association(uuid, text, text, text, text, timestamptz),
  public.ufc_training_add_manual(jsonb), public.ufc_training_slug(text, text) from public, anon, authenticated;
grant execute on function public.ufc_training_record_association(uuid, text, text, text, text, timestamptz),
  public.ufc_training_add_manual(jsonb), public.ufc_training_slug(text, text) to service_role;

alter table public.ufc_training_camps enable row level security;
alter table public.ufc_training_camp_aliases enable row level security;
alter table public.ufc_coaches enable row level security;
alter table public.ufc_training_observations enable row level security;
alter table public.ufc_training_change_events enable row level security;

notify pgrst, 'reload schema';

commit;
