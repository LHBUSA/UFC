-- Issue #27: /v1/ufc/dna/query must rank the eligible fighter population.
--
-- THE DEFECT
-- The Worker read at most 1,000 rows of the whole snapshot history, ordered by
-- (fighter_id, as_of_date desc), then resolved each fighter's latest row and ranked
-- inside that window. On 2026-09-14 the default query (sig_landed_per_min, low)
-- matched 29,629 historical rows; the window held the first 1,000 by fighter UUID,
-- and 98 fighters were ranked out of the 2,782 whose latest snapshot qualifies. The
-- published "top 50" was the top of an arbitrary UUID prefix.
--
-- THE FIX
-- This function does the whole query in SQL, in this order:
--   1. eligible  one row per fighter: the latest snapshot (or, with p_stance, the
--                latest split against that stance) with as_of_date <= p_as_of and
--                the requested definition_version. The latest row is chosen WITHOUT
--                regard to the metric filters, so an older row that passes never
--                stands in for a newer row that fails. With p_stance the chosen split
--                must also have appearances >= p_min_appearances.
--   2. matched   the metric is a MetricObject (object with a "value" key), its
--                confidence is at or above p_min_confidence, it satisfies p_min /
--                p_max, and the fighter satisfies p_active.
--   3. ranked    ordered over the whole matched population.
--   4. limited   only now is p_limit applied.
--
-- SEMANTICS KEPT FROM THE WORKER
--   * as_of is exclusive by construction (see DNA_AS_OF_NOTE in the Worker): the
--     snapshot dated D excludes bouts fought on D, and ?as_of=D resolves to the latest
--     row with as_of_date <= D.
--   * Confidence ranks insufficient < low < medium < high; the default floor stays low.
--   * An explicit null value stays null: the MetricObject is returned untouched and
--     sorts after every number in both directions. Values that are not JSON numbers
--     (the distribution metrics carry objects) rank like null. Nothing is synthesized.
--   * Ties break on fighter name (en-US ICU collation, the Worker's localeCompare
--     order) and then fighter id.
--
-- ONE DELIBERATE CLARIFICATION
--   The Worker used PostgREST jsonb comparisons for min/max (`metrics->m->value=lte.X`).
--   jsonb orders null below every number, so `max=` used to admit rows whose value is
--   an explicit null. Here a bound compares the numeric value, and a null (or
--   non-numeric) value never satisfies a bound. Without min/max nothing changes.
--
-- COST
--   Step 1 walks ufc_fighter_dna_snapshots_latest_idx (fighter_id, as_of_date desc,
--   definition_version desc) and joins back to the ~3.2k chosen rows only, so the
--   metrics jsonb is read for one row per fighter rather than for the whole history.
--   No new index is needed for the snapshot path. The stance path sorts the
--   stance-filtered splits (about a sixth of 55k rows); measured in the release notes.
--
-- Read-only, security invoker (RLS on the tables still applies), execute granted to
-- service_role only. Idempotent: create or replace, and grants are re-stated.

begin;

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
with floor_rank as (
  select case lower(coalesce(p_min_confidence, 'low'))
           when 'insufficient' then 0 when 'low' then 1 when 'medium' then 2 when 'high' then 3
         end as r
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
    on s.fighter_id = l.fighter_id and s.as_of_date = l.as_of_date and s.definition_version = p_definition_version
  join public.ufc_fighters f on f.id = s.fighter_id
  union all
  select s.fighter_id, s.as_of_date, s.metrics -> p_metric as metric, f.name, f.is_active,
         jsonb_build_object(
           'opponent_stance', s.opponent_stance,
           'appearances', s.appearances,
           'wins', s.wins, 'losses', s.losses, 'draws', s.draws, 'no_contests', s.no_contests,
           'ko_tko_wins', s.ko_tko_wins, 'submission_wins', s.submission_wins, 'decision_wins', s.decision_wins,
           'stat_bouts', s.stat_bouts, 'stat_rounds', s.stat_rounds, 'observed_seconds', s.observed_seconds,
           'confidence', s.confidence
         ) as payload
  from latest_split l
  join public.ufc_fighter_stance_splits s
    on s.fighter_id = l.fighter_id and s.as_of_date = l.as_of_date
   and s.definition_version = p_definition_version and s.opponent_stance = p_stance
  join public.ufc_fighters f on f.id = s.fighter_id
  where s.appearances >= coalesce(p_min_appearances, 1)
),
scored as (
  select e.*,
         case when jsonb_typeof(e.metric -> 'value') = 'number' then (e.metric ->> 'value')::numeric end as value_num,
         case e.metric ->> 'confidence'
           when 'insufficient' then 0 when 'low' then 1 when 'medium' then 2 when 'high' then 3
         end as conf_rank
  from eligible e
),
matched as (
  select s.*
  from scored s, floor_rank fr
  where jsonb_typeof(s.metric) = 'object'
    and s.metric ? 'value'
    and s.conf_rank is not null and fr.r is not null and s.conf_rank >= fr.r
    and (p_min is null or s.value_num >= p_min)
    and (p_max is null or s.value_num <= p_max)
    and (p_active is null or s.is_active is not distinct from p_active)
),
ranked as (
  select m.*, row_number() over (
    order by
      case when m.value_num is null then 1 else 0 end,
      case when lower(coalesce(p_order, 'desc')) = 'asc' then m.value_num end asc,
      case when lower(coalesce(p_order, 'desc')) <> 'asc' then m.value_num end desc,
      coalesce(m.name, '') collate "en-US-x-icu",
      m.fighter_id::text
  ) as rank
  from matched m
)
select jsonb_build_object(
  'rows', coalesce((
    select jsonb_agg(r.payload || jsonb_build_object('fighter_id', r.fighter_id, 'as_of_date', r.as_of_date, 'metric', r.metric, 'rank', r.rank) order by r.rank)
    from ranked r
    where r.rank <= greatest(coalesce(p_limit, 50), 0)
  ), '[]'::jsonb),
  -- eligible: fighters evaluated (one latest row each). matched: passed the filters.
  'eligible', (select count(*) from eligible),
  'matched', (select count(*) from matched)
)
$fn$;

comment on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) is
  'Issue #27. Ranks one Fight DNA metric over the full eligible fighter population: latest snapshot (or stance split) per fighter at or before as_of, then MetricObject/confidence/min/max/active filtering, then ordering (nulls last, ties by name then id), then the limit. Returns {rows, eligible, matched}. Read-only, security invoker.';

revoke all on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) from public;
revoke all on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) from anon, authenticated;
grant execute on function public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int) to service_role;

commit;
