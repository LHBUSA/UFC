-- Issue #27: /v1/ufc/dna/query must rank the eligible fighter population, not the
-- first 1000 historical rows in (fighter_id, as_of_date) order.
--
-- Before this migration the Worker scanned at most DNA_QUERY_CANDIDATE_LIMIT = 1000
-- rows of a 26,167-row history table ordered by fighter UUID, then resolved "latest
-- snapshot" and ranked inside that window. For the default broad query that window
-- covered 122 of the 3,161 fighters that have a snapshot, so the published "top 50"
-- was the top 50 of an arbitrary UUID prefix.
--
-- This function resolves each fighter's latest eligible snapshot in SQL first, then
-- filters, then ranks, then limits. Semantics that are deliberately UNCHANGED:
--   * as_of is exclusive-by-construction and resolves to the latest stored row with
--     as_of_date <= as_of (see DNA_AS_OF_NOTE in the Worker).
--   * The latest row is chosen WITHOUT regard to the metric filters, so an older row
--     that passes never stands in for a newer row that fails.
--   * Confidence gate: rank(metric->>'confidence') >= rank(p_min_confidence); the
--     default floor stays 'low'.
--   * min / max compare the stored numeric value; rows whose value is not a JSON
--     number never satisfy a bound.
--   * An explicit null stays null. A MetricObject with "value": null keeps its object
--     and sorts LAST in both directions. Nothing is synthesized or defaulted.
--   * Ties break on fighter name then fighter id, matching the Worker's previous
--     localeCompare ordering (ICU en-US).
create or replace function public.ufc_dna_metric_ranking(
  p_metric text,
  p_definition_version int default 1,
  p_as_of date default null,
  p_min_confidence text default 'low',
  p_min numeric default null,
  p_max numeric default null,
  p_active boolean default null,
  p_order text default 'desc',
  p_limit int default 50,
  p_stance text default null,
  p_min_appearances int default 1
) returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
with allowed as (
  select array(
    select k from (values ('insufficient', 0), ('low', 1), ('medium', 2), ('high', 3)) t(k, rank)
    where t.rank >= (case p_min_confidence
      when 'insufficient' then 0 when 'low' then 1 when 'medium' then 2 when 'high' then 3 end)
  ) as conf
),
latest_snapshot as (
  select distinct on (s.fighter_id) s.fighter_id, s.as_of_date
  from public.ufc_fighter_dna_snapshots s
  where p_stance is null
    and s.definition_version = p_definition_version
    and (p_as_of is null or s.as_of_date <= p_as_of)
  order by s.fighter_id, s.as_of_date desc
),
latest_split as (
  select distinct on (s.fighter_id) s.fighter_id, s.as_of_date
  from public.ufc_fighter_stance_splits s
  where p_stance is not null
    and s.definition_version = p_definition_version
    and s.opponent_stance = p_stance
    and (p_as_of is null or s.as_of_date <= p_as_of)
  order by s.fighter_id, s.as_of_date desc
),
-- One row per fighter: the eligible population the ranking evaluates. Both tables
-- carry a FK to ufc_fighters with on delete cascade, so the join drops nothing.
eligible as (
  select s.fighter_id, s.as_of_date, s.metrics -> p_metric as metric, f.name, f.is_active,
         jsonb_build_object(
           'sample_bouts', s.sample_bouts,
           'sample_completed_bouts', s.sample_completed_bouts,
           'sample_stat_bouts', s.sample_stat_bouts,
           'sample_rounds', s.sample_rounds,
           'sample_seconds', s.sample_seconds,
           'coverage_status', s.coverage_status
         ) as payload
  from latest_snapshot l
  join public.ufc_fighter_dna_snapshots s
    on s.fighter_id = l.fighter_id
   and s.as_of_date = l.as_of_date
   and s.definition_version = p_definition_version
  join public.ufc_fighters f on f.id = s.fighter_id
  union all
  select s.fighter_id, s.as_of_date, s.metrics -> p_metric as metric, f.name, f.is_active,
         jsonb_build_object(
           'opponent_stance', s.opponent_stance,
           'appearances', s.appearances,
           'wins', s.wins, 'losses', s.losses, 'draws', s.draws, 'no_contests', s.no_contests,
           'ko_tko_wins', s.ko_tko_wins,
           'submission_wins', s.submission_wins,
           'decision_wins', s.decision_wins,
           'stat_bouts', s.stat_bouts,
           'stat_rounds', s.stat_rounds,
           'observed_seconds', s.observed_seconds,
           'confidence', s.confidence
         ) as payload
  from latest_split l
  join public.ufc_fighter_stance_splits s
    on s.fighter_id = l.fighter_id
   and s.as_of_date = l.as_of_date
   and s.definition_version = p_definition_version
   and s.opponent_stance = p_stance
  join public.ufc_fighters f on f.id = s.fighter_id
  where s.appearances >= p_min_appearances
),
scored as (
  select e.*,
         case when jsonb_typeof(e.metric -> 'value') = 'number'
              then (e.metric ->> 'value')::numeric end as value_num,
         e.metric ->> 'confidence' as confidence
  from eligible e
),
matched as (
  select s.*
  from scored s, allowed a
  where jsonb_typeof(s.metric) = 'object'
    and s.metric ? 'value'
    and s.confidence = any (a.conf)
    and (p_min is null or s.value_num >= p_min)
    and (p_max is null or s.value_num <= p_max)
    and (p_active is null or s.is_active is not distinct from p_active)
),
-- Rank the whole matched population, then take p_limit. Never the other way round.
ranked as (
  select m.*, row_number() over (
    order by
      case when m.value_num is null then 1 else 0 end,
      case when lower(p_order) = 'asc' then m.value_num end asc,
      case when lower(p_order) <> 'asc' then m.value_num end desc,
      coalesce(m.name, '') collate "en-US-x-icu",
      m.fighter_id::text
  ) as rank
  from matched m
)
select jsonb_build_object(
  'rows', coalesce((
    select jsonb_agg(
      r.payload
      || jsonb_build_object('fighter_id', r.fighter_id, 'as_of_date', r.as_of_date, 'metric', r.metric)
      order by r.rank
    )
    from ranked r where r.rank <= greatest(p_limit, 0)
  ), '[]'::jsonb),
  -- candidates / candidates_total: the eligible population that was ranked, i.e. one
  -- latest snapshot (or stance split) per fighter. There is no scan cap any more, so
  -- the two are equal and truncated is always false.
  'candidates', (select count(*) from eligible),
  'matched', (select count(*) from matched)
)
$fn$;

comment on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) is
  'Issue #27. Ranks the full eligible fighter population for one Fight DNA metric: latest snapshot (or stance split) per fighter at or before as_of, then confidence/min/max/active filtering, then ordering, then the limit. Explicit nulls stay null and sort last. Read-only, security invoker, so RLS on the underlying tables still applies.';

-- Same posture as the underlying tables: RLS is enabled on them with no policies, so
-- only the service role (which bypasses RLS) can read Fight DNA. Keep execute off the
-- anonymous roles so an unauthenticated caller cannot spend CPU on a full ranking.
revoke all on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) from public;
revoke all on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) from anon, authenticated;
grant execute on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) to service_role;
