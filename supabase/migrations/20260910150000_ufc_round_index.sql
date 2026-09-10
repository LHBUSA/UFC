-- Round-by-round index read model
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive and non-destructive: one view, one function. No table is created,
-- altered or written. No already-applied migration is edited.
--
-- =========================================================================
-- WHY
-- =========================================================================
--
-- /round-by-round downloaded five whole tables on every regeneration
-- (ufc_bout_round_stats 41,542 rows, ufc_bouts 9,426, ufc_bout_results 9,344,
-- ufc_fighters 3,184, ufc_events 898): about 67 PostgREST pages at the
-- 1,000-row cap, joined in application memory. Its pager returned whatever
-- prefix it had when any page failed, so a mid-walk failure rendered a
-- smaller archive as if it were the whole one.
--
-- The page needs coverage totals and five shelves of twelve. That is one
-- query's worth of work for the database and one response for the page.
--
-- =========================================================================
-- SEMANTICS (kept separate on purpose)
-- =========================================================================
--
--   rounds_observed   distinct rounds with stored observations. How long the
--                     fight actually went, as far as the source recorded it.
--   scheduled_rounds  the contracted distance (ufc_bouts.scheduled_rounds).
--
-- The "five-round fights" shelf means scheduled_rounds = 5. A five-round
-- main event that ended in round 2 IS a five-round fight. The old shelf used
-- rounds_observed >= 5 and excluded it.
--
-- Eligibility is unchanged: at least one stored round observation, and the
-- bout's event and both fighters exist (the page cannot render a name
-- otherwise). Tournament = a fighter appears on more than one eligible bout on
-- the same event, computed over eligible bouts exactly as before.

create or replace view public.ufc_round_index
with (security_invoker = true) as
with per_round as (
  select bout_id, round, count(distinct fighter_id) as corners, max(captured_at) as captured_at
  from public.ufc_bout_round_stats
  group by bout_id, round
),
cov as (
  select bout_id,
         count(*)::int              as rounds_observed,
         bool_and(corners >= 2)     as both_corners,
         max(captured_at)           as last_captured_at
  from per_round
  group by bout_id
),
eligible as (
  select b.id as bout_id, b.event_id, b.fighter_a_id, b.fighter_b_id
  from public.ufc_bouts b
  join cov on cov.bout_id = b.id
  join public.ufc_events e on e.id = b.event_id
  join public.ufc_fighters fa on fa.id = b.fighter_a_id
  join public.ufc_fighters fb on fb.id = b.fighter_b_id
  where cov.rounds_observed >= 1
),
appearances as (
  select event_id, fighter_id, count(*) as n
  from eligible, lateral (values (fighter_a_id), (fighter_b_id)) v(fighter_id)
  group by event_id, fighter_id
)
select
  b.id                              as bout_id,
  b.event_id,
  e.name                            as event_name,
  e.event_date,
  b.fighter_a_id,
  fa.name                           as fighter_a_name,
  fa.espn_athlete_id                as fighter_a_espn_athlete_id,
  fa.ufcstats_id                    as fighter_a_ufcstats_id,
  b.fighter_b_id,
  fb.name                           as fighter_b_name,
  fb.espn_athlete_id                as fighter_b_espn_athlete_id,
  fb.ufcstats_id                    as fighter_b_ufcstats_id,
  b.weight_class,
  coalesce(b.is_womens, false)      as is_womens,
  coalesce(b.is_title, false)       as is_title,
  b.bout_order,
  b.scheduled_rounds,
  r.method,
  r.round                           as finish_round,
  r.winner_id,
  cov.rounds_observed,
  cov.both_corners,
  cov.last_captured_at,
  (coalesce(pa.n, 0) > 1 or coalesce(pb.n, 0) > 1) as is_tournament
from eligible el
join public.ufc_bouts b     on b.id = el.bout_id
join cov                    on cov.bout_id = b.id
join public.ufc_events e    on e.id = b.event_id
join public.ufc_fighters fa on fa.id = b.fighter_a_id
join public.ufc_fighters fb on fb.id = b.fighter_b_id
left join public.ufc_bout_results r on r.bout_id = b.id
left join appearances pa on pa.event_id = b.event_id and pa.fighter_id = b.fighter_a_id
left join appearances pb on pb.event_id = b.event_id and pb.fighter_id = b.fighter_b_id;

comment on view public.ufc_round_index is
  'One row per bout with stored round observations. rounds_observed = distinct rounds recorded; scheduled_rounds = contracted distance. Read model for /round-by-round and round-link eligibility.';

-- Everything /round-by-round renders, in one response. A single jsonb value
-- has no row cap to be truncated by, and the call either returns all of it or
-- fails: there is no partial archive to render.
--
-- Shelf order matches the page's previous in-memory sort (event date newest
-- first, then bout_order ascending, nulls as 0) with bout_id as the final
-- tie-break so the result is deterministic.
create or replace function public.ufc_round_index_page()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with idx as materialized (
    select * from public.ufc_round_index
  ),
  shelf_rows as (
    select 'recent' as shelf, x.*
    from (select * from idx order by event_date desc nulls last, coalesce(bout_order, 0), bout_id limit 12) x
    union all
    select 'five-round', x.*
    from (select * from idx where scheduled_rounds = 5 order by event_date desc nulls last, coalesce(bout_order, 0), bout_id limit 12) x
    union all
    select 'title', x.*
    from (select * from idx where is_title order by event_date desc nulls last, coalesce(bout_order, 0), bout_id limit 12) x
    union all
    select 'tournament', x.*
    from (select * from idx where is_tournament order by event_date desc nulls last, coalesce(bout_order, 0), bout_id limit 12) x
    union all
    select 'historic', x.*
    from (select * from idx order by event_date asc nulls first, coalesce(bout_order, 0), bout_id limit 12) x
  ),
  shelves as (
    select shelf, jsonb_agg(to_jsonb(s) - 'shelf'
             order by case when shelf = 'historic' then event_date end asc nulls first,
                      case when shelf <> 'historic' then event_date end desc nulls last,
                      coalesce(bout_order, 0), bout_id) as bouts
    from shelf_rows s
    group by shelf
  )
  select jsonb_build_object(
    'contract', 'ufc_round_index_page.v1',
    'generated_at', now(),
    'totals', jsonb_build_object(
      'eligible',            (select count(*) from idx),
      'both_corners',        (select count(*) from idx where both_corners),
      'by_rounds_observed',  coalesce((select jsonb_object_agg(rounds_observed::text, n) from (select rounds_observed, count(*) n from idx group by 1) t), '{}'::jsonb),
      'by_scheduled_rounds', coalesce((select jsonb_object_agg(coalesce(scheduled_rounds::text, 'unknown'), n) from (select scheduled_rounds, count(*) n from idx group by 1) t), '{}'::jsonb),
      'scheduled_five_round',(select count(*) from idx where scheduled_rounds = 5),
      'title',               (select count(*) from idx where is_title),
      'tournament',          (select count(*) from idx where is_tournament)
    ),
    'provenance', jsonb_build_object(
      'round_rows',        (select count(*) from public.ufc_bout_round_stats),
      'last_captured_at',  (select max(captured_at) from public.ufc_bout_round_stats),
      'source',            'ufc_bout_round_stats via ufc_round_index'
    ),
    'shelves', coalesce((select jsonb_object_agg(shelf, bouts) from shelves), '{}'::jsonb)
  );
$$;

comment on function public.ufc_round_index_page() is
  'Complete /round-by-round payload (totals, provenance, five shelves of <= 12) in one call. Contract ufc_round_index_page.v1.';

-- Server-side reads only (service_role), like every other view here. anon and
-- authenticated get nothing: the default public-schema grants would otherwise
-- hand them all seven privileges on the view and EXECUTE on the function.
revoke all on public.ufc_round_index from public, anon, authenticated;
grant select on public.ufc_round_index to service_role;
revoke all on function public.ufc_round_index_page() from public, anon, authenticated;
grant execute on function public.ufc_round_index_page() to service_role;

notify pgrst, 'reload schema';
