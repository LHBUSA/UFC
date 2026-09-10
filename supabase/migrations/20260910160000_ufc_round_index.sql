-- /round-by-round read model
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive and non-destructive. One SQL function, no table, no trigger, no
-- data written. Nothing that already exists is altered.
--
-- =========================================================================
-- WHY
-- =========================================================================
--
-- The /round-by-round index page learned which bouts have round coverage by
-- downloading the whole archive through PostgREST and joining it in Node:
--
--   ufc_bout_round_stats  41,542 rows  -> 42 requests (1000-row pages)
--   ufc_bouts              9,426 rows  -> 10
--   ufc_bout_results       9,344 rows  -> 10
--   ufc_fighters           3,184 rows  ->  4
--   ufc_events               898 rows  ->  1
--                                          67 requests per render
--
-- Any page that failed mid-walk was returned as a shorter array, so a partial
-- archive rendered as a complete, smaller one with plausible totals. The page
-- needs twelve cards per shelf and a handful of counts; it never needed the
-- rows themselves.
--
-- =========================================================================
-- WHAT
-- =========================================================================
--
-- ufc_round_index(shelf_size) returns ONE jsonb document:
--
--   generated_at            now() at read time
--   freshness               newest round-row capture, round-row count
--   totals                  eligible bouts, both-corner bouts, observed-round
--                           distribution, coverage date range, scheduled
--                           five-round bouts, bouts with five recorded rounds
--   shelves                 recent, scheduled_five_round, title, tournament,
--                           historic; each at most shelf_size rows carrying only
--                           what a card renders and links
--
-- Definitions (unchanged from web/lib/roundIndex.ts unless stated):
--   eligible        a bout with at least one stored round row, a stored event
--                   and both fighter rows (ELIGIBLE_MIN_ROUNDS = 1)
--   rounds_covered  distinct rounds with any observation
--   both_corners    every observed round holds two distinct fighters
--   tournament      a fighter on more than one ELIGIBLE bout of the same event
--   scheduled_five_round   CHANGED: ufc_bouts.scheduled_rounds = 5. The old
--                   shelf used rounds_covered >= 5, which dropped every
--                   five-round fight that ended early and was therefore a
--                   list of fights that went long, not five-round fights.
--                   Observed length is reported separately as
--                   totals.five_rounds_recorded.
--
-- Ordering is total (ties broken by bout id), so the same archive always
-- produces the same document.
--
-- The CTEs are MATERIALIZED on purpose. Inlined, the tournament test became a
-- correlated re-aggregation per bout (~150M comparisons) and the first draft
-- hit the 2-minute statement timeout. Materialized, the whole document is one
-- pass over the round table plus hash joins, and the jsonb for a card is
-- built only for the rows a shelf actually returns.
--
-- SECURITY: invoker rights, and EXECUTE is revoked from PUBLIC, anon and
-- authenticated. The site reads it with the service role, exactly as it read
-- the underlying tables. A new function in public is executable by PUBLIC by
-- default; that default is removed here rather than inherited.

begin;

create or replace function public.ufc_round_index(shelf_size integer default 12)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with per_round as (
  select bout_id, round, count(distinct fighter_id) as corners
  from ufc_bout_round_stats
  group by bout_id, round
),
cov as materialized (
  select bout_id,
         count(*)::int         as rounds_covered,
         bool_and(corners >= 2) as both_corners
  from per_round
  group by bout_id
),
elig as materialized (
  select b.id as bout_id, b.event_id, e.name as event_name, e.event_date,
         b.bout_order, b.weight_class, coalesce(b.is_womens, false) as is_womens,
         coalesce(b.is_title, false) as is_title, b.scheduled_rounds,
         r.method, r.round as finish_round, r.winner_id,
         c.rounds_covered, c.both_corners,
         fa.id as a_id, fa.name as a_name, fb.id as b_id, fb.name as b_name
  from cov c
  join ufc_bouts b     on b.id = c.bout_id
  join ufc_events e    on e.id = b.event_id
  join ufc_fighters fa on fa.id = b.fighter_a_id
  join ufc_fighters fb on fb.id = b.fighter_b_id
  left join ufc_bout_results r on r.bout_id = b.id
),
repeat_fighter as materialized (
  select event_id, fid
  from (select event_id, a_id as fid from elig union all select event_id, b_id from elig) x
  group by event_id, fid
  having count(*) > 1
),
card as materialized (
  select e.*,
         (ta.fid is not null or tb.fid is not null) as is_tournament
  from elig e
  left join repeat_fighter ta on ta.event_id = e.event_id and ta.fid = e.a_id
  left join repeat_fighter tb on tb.event_id = e.event_id and tb.fid = e.b_id
),
lim as (select greatest(1, least(coalesce(shelf_size, 12), 48)) as n)
select jsonb_build_object(
  'contract', 'ufc_round_index/v1',
  'generated_at', now(),
  'freshness', jsonb_build_object(
    'last_round_capture_at', (select max(captured_at) from ufc_bout_round_stats),
    'round_rows', (select count(*) from ufc_bout_round_stats)
  ),
  'totals', jsonb_build_object(
    'eligible', (select count(*) from elig),
    'both_corners', (select count(*) from elig where both_corners),
    'by_observed_rounds', coalesce((select jsonb_object_agg(rounds_covered::text, n order by rounds_covered)
                                    from (select rounds_covered, count(*) as n from elig group by rounds_covered) x), '{}'::jsonb),
    'first_event_date', (select min(event_date) from elig),
    'last_event_date', (select max(event_date) from elig),
    'scheduled_five_round', (select count(*) from elig where scheduled_rounds = 5),
    'five_rounds_recorded', (select count(*) from elig where rounds_covered >= 5)
  ),
  'shelves', jsonb_build_object(
    'recent', coalesce((select jsonb_agg(j order by event_date desc, coalesce(bout_order, 0), bout_id) from
      (select jsonb_build_object(
           'bout_id', bout_id, 'event_id', event_id, 'event_name', event_name, 'event_date', event_date,
           'bout_order', bout_order, 'weight_class', weight_class, 'is_womens', is_womens, 'is_title', is_title,
           'scheduled_rounds', scheduled_rounds, 'method', method, 'finish_round', finish_round,
           'winner_id', winner_id, 'rounds_covered', rounds_covered, 'both_corners', both_corners,
           'fighter_a', jsonb_build_object('id', a_id, 'name', a_name),
           'fighter_b', jsonb_build_object('id', b_id, 'name', b_name)) as j, event_date, bout_order, bout_id from card
       order by event_date desc, coalesce(bout_order, 0), bout_id limit (select n from lim)) s), '[]'::jsonb),
    'scheduled_five_round', coalesce((select jsonb_agg(j order by event_date desc, coalesce(bout_order, 0), bout_id) from
      (select jsonb_build_object(
           'bout_id', bout_id, 'event_id', event_id, 'event_name', event_name, 'event_date', event_date,
           'bout_order', bout_order, 'weight_class', weight_class, 'is_womens', is_womens, 'is_title', is_title,
           'scheduled_rounds', scheduled_rounds, 'method', method, 'finish_round', finish_round,
           'winner_id', winner_id, 'rounds_covered', rounds_covered, 'both_corners', both_corners,
           'fighter_a', jsonb_build_object('id', a_id, 'name', a_name),
           'fighter_b', jsonb_build_object('id', b_id, 'name', b_name)) as j, event_date, bout_order, bout_id from card where scheduled_rounds = 5
       order by event_date desc, coalesce(bout_order, 0), bout_id limit (select n from lim)) s), '[]'::jsonb),
    'title', coalesce((select jsonb_agg(j order by event_date desc, coalesce(bout_order, 0), bout_id) from
      (select jsonb_build_object(
           'bout_id', bout_id, 'event_id', event_id, 'event_name', event_name, 'event_date', event_date,
           'bout_order', bout_order, 'weight_class', weight_class, 'is_womens', is_womens, 'is_title', is_title,
           'scheduled_rounds', scheduled_rounds, 'method', method, 'finish_round', finish_round,
           'winner_id', winner_id, 'rounds_covered', rounds_covered, 'both_corners', both_corners,
           'fighter_a', jsonb_build_object('id', a_id, 'name', a_name),
           'fighter_b', jsonb_build_object('id', b_id, 'name', b_name)) as j, event_date, bout_order, bout_id from card where is_title
       order by event_date desc, coalesce(bout_order, 0), bout_id limit (select n from lim)) s), '[]'::jsonb),
    'tournament', coalesce((select jsonb_agg(j order by event_date desc, coalesce(bout_order, 0), bout_id) from
      (select jsonb_build_object(
           'bout_id', bout_id, 'event_id', event_id, 'event_name', event_name, 'event_date', event_date,
           'bout_order', bout_order, 'weight_class', weight_class, 'is_womens', is_womens, 'is_title', is_title,
           'scheduled_rounds', scheduled_rounds, 'method', method, 'finish_round', finish_round,
           'winner_id', winner_id, 'rounds_covered', rounds_covered, 'both_corners', both_corners,
           'fighter_a', jsonb_build_object('id', a_id, 'name', a_name),
           'fighter_b', jsonb_build_object('id', b_id, 'name', b_name)) as j, event_date, bout_order, bout_id from card where is_tournament
       order by event_date desc, coalesce(bout_order, 0), bout_id limit (select n from lim)) s), '[]'::jsonb),
    'historic', coalesce((select jsonb_agg(j order by event_date asc, coalesce(bout_order, 0), bout_id) from
      (select jsonb_build_object(
           'bout_id', bout_id, 'event_id', event_id, 'event_name', event_name, 'event_date', event_date,
           'bout_order', bout_order, 'weight_class', weight_class, 'is_womens', is_womens, 'is_title', is_title,
           'scheduled_rounds', scheduled_rounds, 'method', method, 'finish_round', finish_round,
           'winner_id', winner_id, 'rounds_covered', rounds_covered, 'both_corners', both_corners,
           'fighter_a', jsonb_build_object('id', a_id, 'name', a_name),
           'fighter_b', jsonb_build_object('id', b_id, 'name', b_name)) as j, event_date, bout_order, bout_id from card
       order by event_date asc, coalesce(bout_order, 0), bout_id limit (select n from lim)) s), '[]'::jsonb)
  )
);
$$;

comment on function public.ufc_round_index(integer) is
  '/round-by-round read model: one jsonb document of totals + five shelves. Contract ufc_round_index/v1. See supabase/migrations/20260910160000_ufc_round_index.sql.';

revoke all on function public.ufc_round_index(integer) from public;
revoke all on function public.ufc_round_index(integer) from anon, authenticated;
grant execute on function public.ufc_round_index(integer) to service_role;

commit;
