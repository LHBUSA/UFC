-- 033_ufc_training_camp_merge.sql
--
-- Camp entity de-duplication through a canonical pointer (Training & Corner, 032).
--
-- ufc_training_observations is append-only, so a duplicate camp can never be
-- "moved": its rows keep the camp (and ESPN association id) the source used.
-- Instead a duplicate camp row points at its canonical camp (merged_into), and
-- every reader resolves through public.ufc_training_canonical_camp():
--   * the stint/current views collapse a camp and its merged twin into ONE camp
--     (no false stint split, one name);
--   * ufc_training_record_association compares canonical camps, so a fighter
--     whose ESPN id moves between two ids of the same gym is a confirmation,
--     never an AFFILIATION_CHANGED_OBSERVED;
--   * the merged row keeps its espn_association_id: future captures of that id
--     still land on it and resolve to the canonical camp.
-- Merges are reviewed, never by name automatically
-- (docs/ufc-training/CAMP_DUPLICATE_CANDIDATES.md). Reversible: set merged_into back to null.

begin;

alter table public.ufc_training_camps
  add column merged_into uuid references public.ufc_training_camps(id) on delete restrict,
  add column merged_at timestamptz,
  add column merge_note text,
  add constraint ufc_training_camps_merge_self check (merged_into is null or merged_into <> id),
  add constraint ufc_training_camps_merge_note check (merged_into is null or (merge_note is not null and merged_at is not null));

-- No chains: a canonical camp is never itself merged, and a merge target is never merged.
create or replace function public.ufc_training_camps_merge_guard() returns trigger
language plpgsql as $$
begin
  if new.merged_into is not null then
    if exists (select 1 from public.ufc_training_camps where id = new.merged_into and merged_into is not null) then
      raise exception 'camp % is itself merged; merge into its canonical camp instead', new.merged_into using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.ufc_training_camps where merged_into = new.id) then
      raise exception 'camp % is a merge target; it cannot be merged', new.id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger ufc_training_camps_merge_guard before insert or update of merged_into on public.ufc_training_camps
  for each row execute function public.ufc_training_camps_merge_guard();

create or replace function public.ufc_training_canonical_camp(p_camp uuid) returns uuid
language sql stable parallel safe as $$
  select coalesce((select merged_into from public.ufc_training_camps where id = p_camp), p_camp)
$$;

create or replace function public.ufc_training_record_association(
  p_fighter_id uuid, p_espn_athlete_id text, p_association_id text, p_association_name text,
  p_source_url text, p_captured_at timestamptz default now()
) returns jsonb
language plpgsql set search_path = public as $$
declare
  src uuid; camp uuid; camp_name text; canon uuid; canon_name text; prev record; obs uuid; ev uuid; attached boolean := false;
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
  -- A merged camp answers as its canonical camp; the observation keeps the source's own camp row (and ESPN id).
  canon := ufc_training_canonical_camp(camp);
  select canonical_name into canon_name from ufc_training_camps where id = canon;

  select o.id, ufc_training_canonical_camp(o.camp_id) as camp_id, o.last_confirmed_at, c.canonical_name as camp_name into prev
    from ufc_training_observations o join ufc_training_camps c on c.id = ufc_training_canonical_camp(o.camp_id)
    where o.fighter_id = p_fighter_id and o.fact = 'AFFILIATION' and o.source_id = src
    order by o.captured_at desc, o.id desc limit 1;

  if prev.id is not null and prev.camp_id = canon then
    update ufc_training_observations
      set last_confirmed_at = greatest(last_confirmed_at, p_captured_at), confirm_count = confirm_count + 1
      where id = prev.id and p_captured_at >= last_confirmed_at;
    return jsonb_build_object('action', 'confirmed', 'camp_id', canon, 'observation_id', prev.id, 'attached_by_name', attached);
  end if;

  insert into ufc_training_observations (fighter_id, fact, camp_id, relationship_type, value_raw, external_ref,
      certainty, source_id, source_url, captured_at, last_confirmed_at, obs_hash)
    values (p_fighter_id, 'AFFILIATION', camp, 'AFFILIATION', aname, aid, 'OBSERVED', src, p_source_url,
      p_captured_at, p_captured_at, md5('espn_assoc|' || p_fighter_id || '|' || aid || '|' || p_captured_at::text))
    returning id into obs;

  if prev.id is null then
    return jsonb_build_object('action', 'first', 'camp_id', canon, 'observation_id', obs, 'attached_by_name', attached);
  end if;

  insert into ufc_training_change_events (fighter_id, kind, previous_value, new_value, previous_camp_id, new_camp_id,
      previous_observation_id, new_observation_id, source_id, source_url, observed_at)
    values (p_fighter_id, 'AFFILIATION_CHANGED_OBSERVED', prev.camp_name, canon_name, prev.camp_id, canon,
      prev.id, obs, src, p_source_url, p_captured_at)
    returning id into ev;
  return jsonb_build_object('action', 'changed', 'camp_id', canon, 'observation_id', obs, 'event_id', ev,
    'previous_camp_id', prev.camp_id, 'attached_by_name', attached);
end $$;

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

revoke all on public.ufc_fighter_camp_stints, public.ufc_fighter_training_current from anon, authenticated;
grant select on public.ufc_fighter_camp_stints, public.ufc_fighter_training_current to service_role;
revoke all on function public.ufc_training_record_association(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ufc_training_record_association(uuid, text, text, text, text, timestamptz) to service_role;
revoke all on function public.ufc_training_camps_merge_guard() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
