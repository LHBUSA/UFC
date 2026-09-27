-- 034_ufc_training_reported_moves.sql
--
-- REPORTED CAMP MOVE: a dated source says a fighter moved camps, but states no
-- effective move date (Bellato, Moura). Before this, the only ways to store it
-- were a switch row -- which sorts at capture time and would REPLACE the current
-- observed camp -- or an invented date. Both are wrong.
--
-- Now:
--   * CURRENT OBSERVED AFFILIATION is unchanged: the stint/current views are
--     built from observed + dated rows only.
--   * A reported move is an append-only observation with reported_only = true
--     (STATED, effective_from NULL, source_published_at REQUIRED; destination may
--     be a raw name when no camp entity exists, so research never creates a
--     duplicate camp) plus a CAMP_MOVE_REPORTED change event with
--     exact_date_known = false. Both views exclude reported_only rows, so a
--     reported move can never become, or displace, the current camp -- however
--     new its article or capture timestamp.
--   * No effective date is ever derived from the publication date.

begin;

alter table public.ufc_training_observations
  add column reported_only boolean not null default false;
alter table public.ufc_training_observations
  drop constraint ufc_training_observations_check,
  add constraint ufc_training_observations_affiliation_shape check (
    fact <> 'AFFILIATION' or (relationship_type is not null and (camp_id is not null or reported_only))),
  add constraint ufc_training_observations_reported_shape check (
    not reported_only or (fact = 'AFFILIATION' and certainty = 'STATED' and effective_from is null and effective_to is null
      and not ends_relationship and source_published_at is not null));

alter table public.ufc_training_change_events
  add column exact_date_known boolean not null default true,
  add column source_published_at timestamptz;
alter table public.ufc_training_change_events
  drop constraint ufc_training_change_events_kind_check,
  add constraint ufc_training_change_events_kind_check check (kind in ('CAMP_CHANGED_CONFIRMED', 'AFFILIATION_CHANGED_OBSERVED',
    'COACH_ADDED', 'COACH_REMOVED', 'FIGHTING_OUT_OF_CHANGED', 'CAMP_MOVE_REPORTED')),
  add constraint ufc_training_change_events_reported_shape check (
    kind <> 'CAMP_MOVE_REPORTED' or (not exact_date_known and effective_on is null and source_published_at is not null));

-- Manual lane for a reported move (scripts/training/enrich.mjs reported-move).
create or replace function public.ufc_training_add_reported_move(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  src uuid; f uuid := (p->>'fighter_id')::uuid; url text := p->>'source_url';
  pub timestamptz := (p->>'source_published_at')::timestamptz; cap timestamptz := clock_timestamp();
  to_camp uuid := public.ufc_training_canonical_camp((p->>'camp_id')::uuid);
  from_camp uuid := public.ufc_training_canonical_camp((p->>'from_camp_id')::uuid);
  to_raw text := nullif(btrim(coalesce(p->>'to_raw', '')), '');
  from_raw text := nullif(btrim(coalesce(p->>'from_raw', '')), '');
  to_name text; from_name text; hash text; obs uuid; ev uuid;
begin
  if f is null or url is null or pub is null then raise exception 'fighter_id, source_url and source_published_at are required'; end if;
  if p ? 'effective_from' or p ? 'effective_on' then raise exception 'a reported move carries no effective date (exact_date_known = false)'; end if;
  if to_camp is null and to_raw is null then raise exception 'a destination is required (camp_id or to_raw)'; end if;
  if not exists (select 1 from ufc_fighters where id = f) then raise exception 'fighter % not found', f; end if;
  select id into src from combat_sources where source_key = 'ufc_training_manual' and enabled;
  hash := md5('reported_move|' || p::text);
  if exists (select 1 from ufc_training_observations where obs_hash = hash) then return jsonb_build_object('action', 'duplicate'); end if;
  perform pg_advisory_xact_lock(hashtext('ufc_training:' || f::text));
  if to_camp is not null then select canonical_name into to_name from ufc_training_camps where id = to_camp; end if;
  if from_camp is not null then select canonical_name into from_name from ufc_training_camps where id = from_camp; end if;
  insert into ufc_training_observations (fighter_id, fact, camp_id, relationship_type, reported_only, value_raw, certainty,
      source_id, source_url, source_published_at, evidence_note, captured_at, last_confirmed_at, obs_hash)
    values (f, 'AFFILIATION', to_camp, 'PRIMARY_CAMP', true, coalesce(to_name, to_raw), 'STATED',
      src, url, pub, p->>'evidence_note', cap, cap, hash)
    returning id into obs;
  insert into ufc_training_change_events (fighter_id, kind, previous_value, new_value, previous_camp_id, new_camp_id,
      new_observation_id, effective_on, exact_date_known, source_id, source_url, source_published_at, observed_at)
    values (f, 'CAMP_MOVE_REPORTED', coalesce(from_name, from_raw), coalesce(to_name, to_raw), from_camp, to_camp,
      obs, null, false, src, url, pub, cap)
    returning id into ev;
  return jsonb_build_object('action', 'inserted', 'observation_id', obs, 'event_id', ev);
end $$;

create or replace view public.ufc_fighter_camp_stints with (security_invoker = true) as
with p as (
  select o.*, s.source_key, coalesce(o.effective_from::timestamptz, o.captured_at) as sort_at,
    public.ufc_training_canonical_camp(o.camp_id) as rcamp
  from public.ufc_training_observations o
  join public.combat_sources s on s.id = o.source_id
  where o.fact = 'AFFILIATION' and o.relationship_type in ('PRIMARY_CAMP', 'AFFILIATION') and not o.ends_relationship
    and not o.reported_only  -- 034: a reported move is history/events only, never a stint
), g as (
  select p.*, case when lag(p.rcamp) over (partition by p.fighter_id order by p.sort_at, p.id) is distinct from p.rcamp then 1 else 0 end as brk
  from p
), i as (
  select g.*, sum(g.brk) over (partition by g.fighter_id order by g.sort_at, g.id rows unbounded preceding) as island
  from g
), s as (
  select i.fighter_id, i.island, i.rcamp as camp_id,
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
  from i group by i.fighter_id, i.island, i.rcamp
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
  where x.fighter_id = s.fighter_id and public.ufc_training_canonical_camp(x.camp_id) = s.camp_id and x.fact = 'AFFILIATION' and x.ends_relationship
    and x.relationship_type in ('PRIMARY_CAMP', 'AFFILIATION')
    and coalesce(x.effective_to::timestamptz, x.captured_at) >= s.stint_start_at
  order by x.captured_at desc limit 1
) e on true;

create or replace view public.ufc_fighter_training_current with (security_invoker = true) as
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
      'camp_id', c.id, 'camp_name', c.canonical_name, 'certainty', o.certainty, 'source_key', s.source_key,
      'source_url', o.source_url, 'captured_at', o.captured_at, 'source_published_at', o.source_published_at)
     from public.ufc_training_observations o join public.combat_sources s on s.id = o.source_id
     left join public.ufc_training_camps c on c.id = public.ufc_training_canonical_camp(o.camp_id)
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
  coalesce((select jsonb_agg(jsonb_build_object('camp_id', x.rcamp, 'name', x.camp_name, 'slug', x.camp_slug,
      'relationship_type', x.relationship_type, 'since', x.effective_from, 'certainty', x.certainty,
      'source_key', x.source_key, 'source_url', x.source_url, 'captured_at', x.captured_at) order by x.captured_at desc)
     from (select distinct on (c.id, o.relationship_type) o.*, c.id as rcamp, c.canonical_name as camp_name, c.slug as camp_slug, s.source_key
           from public.ufc_training_observations o join public.ufc_training_camps c on c.id = public.ufc_training_canonical_camp(o.camp_id)
           join public.combat_sources s on s.id = o.source_id
           where o.fighter_id = fs.fighter_id and o.fact = 'AFFILIATION'
             and o.relationship_type in ('TEMPORARY_CAMP', 'CROSS_TRAINING', 'FIGHT_CAMP') and not o.reported_only
           order by c.id, o.relationship_type, o.captured_at desc, o.id desc) x
     where not x.ends_relationship), '[]'::jsonb) as other_camps,
  (select max(greatest(o.captured_at, o.last_confirmed_at)) from public.ufc_training_observations o where o.fighter_id = fs.fighter_id) as updated_at
from fighters fs;

revoke all on public.ufc_fighter_camp_stints, public.ufc_fighter_training_current from anon, authenticated;
grant select on public.ufc_fighter_camp_stints, public.ufc_fighter_training_current to service_role;
revoke all on function public.ufc_training_add_reported_move(jsonb) from public, anon, authenticated;
grant execute on function public.ufc_training_add_reported_move(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
