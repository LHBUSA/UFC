-- Weigh-ins: separate an official CONFIRMATION from a CORRECTION.
-- Project: tkmlnhmylqnttmnsnief
--
-- WHY
-- ufc_weigh_in_current defined is_correction as "supersedes_id is not null",
-- so every UFC.com reading that superseded the wire at the SAME weight was
-- counted as a correction. Noche UFC (2026-09-12) showed 26 corrections when
-- UFC.com had changed nothing: it confirmed all 26 wire weights.
--
--   confirmation = a reading superseded an earlier one at the same weight
--   correction   = a reading superseded an earlier one at a different weight
--                  (null -> number and number -> null count as different)
--
-- Views only. No row in ufc_weigh_in_results is touched; every historical
-- source row stays exactly as stored. Existing columns keep their names,
-- types and positions (is_correction and corrections change meaning to the
-- above); new columns are appended, so CREATE OR REPLACE is valid and grants
-- and the security_invoker posture carry over.

create or replace view public.ufc_weigh_in_current
  with (security_invoker = true) as
select distinct on (w.event_id, w.fighter_id)
  w.id,
  w.event_id,
  e.name as event_name,
  e.event_date,
  w.bout_id,
  w.fighter_id,
  f.name as fighter_name,
  f.espn_athlete_id as fighter_espn_athlete_id,
  f.ufcstats_id as fighter_ufcstats_id,
  b.weight_class,
  b.weight_class_raw,
  b.is_womens,
  b.is_title,
  b.card_position,
  b.bout_order,
  b.status as bout_status,
  w.contracted_limit_lbs,
  w.allowance_lbs,
  w.limit_basis,
  case when w.contracted_limit_lbs is null then null
       else w.contracted_limit_lbs + coalesce(w.allowance_lbs, 0) end as applicable_limit_lbs,
  w.official_weight_lbs,
  w.attempt_number,
  w.result,
  w.over_by_lbs,
  w.catchweight_lbs,
  w.weighed_at,
  w.source_url,
  w.source_name,
  w.source_kind,
  w.source_published_at,
  w.detected_at,
  w.first_seen_at,
  w.last_seen_at,
  w.raw_text,
  w.supersedes_id,
  -- A correction CHANGED the stored weight. Same-weight supersession is a
  -- confirmation (below), not a correction.
  (w.supersedes_id is not null and p.official_weight_lbs is distinct from w.official_weight_lbs) as is_correction,
  (w.supersedes_id is not null and p.official_weight_lbs is not distinct from w.official_weight_lbs) as is_confirmation,
  p.official_weight_lbs as superseded_weight_lbs,
  p.source_kind as superseded_source_kind,
  p.source_name as superseded_source_name
from public.ufc_weigh_in_results w
join public.ufc_events e on e.id = w.event_id
join public.ufc_fighters f on f.id = w.fighter_id
left join public.ufc_bouts b on b.id = w.bout_id
left join public.ufc_weigh_in_results p on p.id = w.supersedes_id
where w.superseded_at is null
order by w.event_id, w.fighter_id, w.attempt_number desc, w.detected_at desc, w.id;

create or replace view public.ufc_weigh_in_event_summary
  with (security_invoker = true) as
select
  c.event_id,
  c.event_name,
  c.event_date,
  count(*) as expected,
  count(*) filter (where c.result in ('made', 'missed')) as weighed,
  count(*) filter (where c.result = 'made') as made,
  count(*) filter (where c.result = 'missed') as missed,
  count(*) filter (where c.result = 'pending') as pending,
  count(*) filter (where c.result = 'withdrawn') as withdrawn,
  count(*) filter (where c.result = 'cancelled') as cancelled,
  count(*) filter (where c.catchweight_lbs is not null) as catchweights,
  count(*) filter (where c.is_correction) as corrections,
  count(*) filter (where c.limit_basis = 'unsupported') as limit_unsupported,
  max(c.last_seen_at) as last_source_update,
  max(c.source_published_at) as newest_source_published_at,
  min(c.first_seen_at) as first_seen_at,
  count(*) filter (where c.is_confirmation) as confirmations
from public.ufc_weigh_in_current c
group by c.event_id, c.event_name, c.event_date;

-- The trail labels each superseding reading the same way.
create or replace view public.ufc_weigh_in_history
  with (security_invoker = true) as
select
  w.id,
  w.event_id,
  w.bout_id,
  w.fighter_id,
  f.name as fighter_name,
  w.official_weight_lbs,
  w.attempt_number,
  w.result,
  w.over_by_lbs,
  w.catchweight_lbs,
  w.limit_basis,
  w.contracted_limit_lbs,
  w.allowance_lbs,
  w.weighed_at,
  w.source_url,
  w.source_name,
  w.source_kind,
  w.source_published_at,
  w.detected_at,
  w.first_seen_at,
  w.last_seen_at,
  w.supersedes_id,
  w.superseded_at,
  w.correction_reason,
  w.raw_text,
  coalesce(w.weighed_at, w.source_published_at, w.detected_at) as occurred_at,
  case when w.supersedes_id is null then null
       when p.official_weight_lbs is not distinct from w.official_weight_lbs then 'confirmation'
       else 'correction' end as supersession_kind,
  p.official_weight_lbs as superseded_weight_lbs
from public.ufc_weigh_in_results w
join public.ufc_fighters f on f.id = w.fighter_id
left join public.ufc_weigh_in_results p on p.id = w.supersedes_id;

-- Grants survive CREATE OR REPLACE; restated so the file is self-describing.
revoke all on public.ufc_weigh_in_current from anon, authenticated;
revoke all on public.ufc_weigh_in_event_summary from anon, authenticated;
revoke all on public.ufc_weigh_in_history from anon, authenticated;
grant select on public.ufc_weigh_in_current to service_role;
grant select on public.ufc_weigh_in_event_summary to service_role;
grant select on public.ufc_weigh_in_history to service_role;

comment on column public.ufc_weigh_in_current.is_correction is
  'True only when this reading superseded an earlier one AND changed the weight. A same-weight supersession is is_confirmation.';
comment on column public.ufc_weigh_in_current.is_confirmation is
  'True when a higher-authority source (e.g. UFC.com) superseded an earlier reading at the same weight: the earlier number was verified, not changed.';
comment on column public.ufc_weigh_in_event_summary.corrections is
  'Current readings whose superseding source changed the stored weight.';
comment on column public.ufc_weigh_in_event_summary.confirmations is
  'Current readings an official/higher-authority source verified at the same weight.';

notify pgrst, 'reload schema';
