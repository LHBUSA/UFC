-- Rollback for 20260927000000_ufc_training_reported_moves (migrations/034).
-- DESTROYS reported-move rows (export first: select * from ufc_training_change_events where kind='CAMP_MOVE_REPORTED').
-- The append-only guards are disabled only for that delete, inside this transaction.
begin;
create or replace view public.ufc_fighter_camp_stints with (security_invoker = true) as
with p as (
  select o.*, s.source_key, coalesce(o.effective_from::timestamptz, o.captured_at) as sort_at,
    public.ufc_training_canonical_camp(o.camp_id) as rcamp
  from public.ufc_training_observations o
  join public.combat_sources s on s.id = o.source_id
  where o.fact = 'AFFILIATION' and o.relationship_type in ('PRIMARY_CAMP', 'AFFILIATION') and not o.ends_relationship
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
             and o.relationship_type in ('TEMPORARY_CAMP', 'CROSS_TRAINING', 'FIGHT_CAMP')
           order by c.id, o.relationship_type, o.captured_at desc, o.id desc) x
     where not x.ends_relationship), '[]'::jsonb) as other_camps,
  (select max(greatest(o.captured_at, o.last_confirmed_at)) from public.ufc_training_observations o where o.fighter_id = fs.fighter_id) as updated_at
from fighters fs;

drop function if exists public.ufc_training_add_reported_move(jsonb);
alter table public.ufc_training_change_events disable trigger ufc_training_events_guard;
alter table public.ufc_training_observations disable trigger ufc_training_observations_guard;
delete from public.ufc_training_change_events where kind = 'CAMP_MOVE_REPORTED';
delete from public.ufc_training_observations where reported_only;
alter table public.ufc_training_observations enable trigger ufc_training_observations_guard;
alter table public.ufc_training_change_events enable trigger ufc_training_events_guard;
alter table public.ufc_training_change_events drop constraint if exists ufc_training_change_events_reported_shape,
  drop constraint ufc_training_change_events_kind_check,
  add constraint ufc_training_change_events_kind_check check (kind in ('CAMP_CHANGED_CONFIRMED', 'AFFILIATION_CHANGED_OBSERVED', 'COACH_ADDED', 'COACH_REMOVED', 'FIGHTING_OUT_OF_CHANGED')),
  drop column if exists source_published_at, drop column if exists exact_date_known;
alter table public.ufc_training_observations drop constraint if exists ufc_training_observations_reported_shape,
  drop constraint if exists ufc_training_observations_affiliation_shape,
  add constraint ufc_training_observations_check check (fact <> 'AFFILIATION' or (camp_id is not null and relationship_type is not null)),
  drop column if exists reported_only;
notify pgrst, 'reload schema';
commit;
