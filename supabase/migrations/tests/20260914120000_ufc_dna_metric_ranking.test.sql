-- Correctness proof for 20260914120000_ufc_dna_metric_ranking, for an ISOLATED
-- database only. Never run against production.
--
--   createdb dna27_test
--   psql dna27_test -v ON_ERROR_STOP=1 -f supabase/migrations/tests/20260914120000_ufc_dna_metric_ranking.test.sql
--   dropdb dna27_test
--
-- Run from the repository root (it \i-includes the migration itself).
--
-- WHAT IT PROVES
--   * Every numbered case from issue #27's acceptance list that lives in SQL, against
--     a generated population large enough (> 1,000 historical rows) that the old
--     first-1000-rows-by-UUID window genuinely leaves eligible fighters out.
--   * An independent oracle (window functions, a different construction) agrees with
--     the function row for row across a grid of parameter combinations.
--   * MUTATION: the same suite run against test_old_window_ranking, a faithful SQL
--     copy of the Worker algorithm before the fix (capped 1,000-row scan by fighter
--     UUID, latest resolution inside the window), FAILS. If someone reintroduces the
--     window, the suite goes red.
-- The Worker-level cases (malformed metric -> 400, meta keys, consumers) are in
-- workers/ufc-api/src/index.test.mjs.

\set ON_ERROR_STOP on
set client_min_messages = warning;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Minimal copies of the production columns the function reads.
create table public.ufc_fighters (id uuid primary key, name text, is_active boolean);
create table public.ufc_fighter_dna_snapshots (
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  as_of_date date not null, definition_version int not null default 1,
  sample_bouts int, sample_completed_bouts int, sample_stat_bouts int, sample_rounds int, sample_seconds int,
  coverage_status text, metrics jsonb not null default '{}',
  primary key (fighter_id, as_of_date, definition_version));
create index ufc_fighter_dna_snapshots_latest_idx on public.ufc_fighter_dna_snapshots (fighter_id, as_of_date desc, definition_version desc);
create table public.ufc_fighter_stance_splits (
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  as_of_date date not null, opponent_stance text not null, definition_version int not null default 1,
  appearances int, wins int, losses int, draws int, no_contests int, ko_tko_wins int, submission_wins int, decision_wins int,
  stat_bouts int, stat_rounds int, observed_seconds int, confidence text, metrics jsonb not null default '{}',
  primary key (fighter_id, as_of_date, opponent_stance, definition_version));

\i supabase/migrations/20260914120000_ufc_dna_metric_ranking.sql

-- ---------------------------------------------------------------- fixtures
create function t_uuid(tag text) returns uuid language sql immutable as $$ select md5(tag)::uuid $$;
create function t_mo(v numeric, conf text) returns jsonb language sql immutable as $$
  select jsonb_build_object('value', v, 'confidence', conf, 'unit', 'per_min', 'origin', 'pbe_derived') $$;

-- 1,200 ordinary fighters x 3 snapshots = 3,600 history rows; values 0..4.99.
insert into ufc_fighters select t_uuid('f' || i), 'Fighter ' || lpad(i::text, 4, '0'), (i % 5 <> 0) from generate_series(1, 1200) i;
insert into ufc_fighter_dna_snapshots (fighter_id, as_of_date, definition_version, sample_bouts, sample_seconds, coverage_status, metrics)
select t_uuid('f' || i), d, 1, 3, 2000, 'partial',
       jsonb_build_object('m1', t_mo(round(((abs(hashtext('v' || i || d)) % 500) / 100.0)::numeric, 4),
                                     (array['low','medium','high','insufficient'])[1 + abs(hashtext('c' || i)) % 4]))
from generate_series(1, 1200) i, unnest(array['2021-01-01','2022-01-01','2023-01-01']::date[]) d;

-- Stars whose UUIDs sort AFTER every ordinary fighter's first rows: 'ffff…' prefixes.
insert into ufc_fighters values
  ('ffffffff-0000-4000-8000-000000000001', 'Star High', true),
  ('ffffffff-0000-4000-8000-000000000002', 'Star Medium', true),
  ('ffffffff-0000-4000-8000-000000000003', 'Star Low', false),
  ('ffffffff-0000-4000-8000-000000000004', 'Tie Bravo', true),
  ('ffffffff-0000-4000-8000-000000000005', 'Tie Alpha', true),
  ('ffffffff-0000-4000-8000-000000000006', 'Null Value', true),
  ('ffffffff-0000-4000-8000-000000000007', 'Many Snapshots', true),
  ('ffffffff-0000-4000-8000-000000000008', 'Stale Passer', true),
  ('00000000-0000-4000-8000-000000000009', 'Early Uuid Star', true);
insert into ufc_fighter_dna_snapshots (fighter_id, as_of_date, definition_version, sample_bouts, sample_seconds, coverage_status, metrics) values
  ('ffffffff-0000-4000-8000-000000000001', '2023-01-01', 1, 12, 9000, 'full', jsonb_build_object('m1', t_mo(9.9, 'high'))),
  ('ffffffff-0000-4000-8000-000000000001', '2019-06-01', 1, 6, 4000, 'partial', jsonb_build_object('m1', t_mo(3.0, 'medium'))),
  ('ffffffff-0000-4000-8000-000000000002', '2023-01-01', 1, 7, 5000, 'full', jsonb_build_object('m1', t_mo(9.5, 'medium'))),
  ('ffffffff-0000-4000-8000-000000000003', '2023-01-01', 1, 2, 1000, 'partial', jsonb_build_object('m1', t_mo(9.1, 'low'))),
  ('ffffffff-0000-4000-8000-000000000004', '2023-01-01', 1, 5, 3000, 'full', jsonb_build_object('m1', t_mo(8.0, 'medium'))),
  ('ffffffff-0000-4000-8000-000000000005', '2023-01-01', 1, 5, 3000, 'full', jsonb_build_object('m1', t_mo(8.0, 'medium'))),
  ('ffffffff-0000-4000-8000-000000000006', '2023-01-01', 1, 1, 300, 'partial', jsonb_build_object('m1', jsonb_build_object('value', null, 'confidence', 'low'))),
  ('ffffffff-0000-4000-8000-000000000008', '2023-01-01', 1, 4, 2000, 'partial', jsonb_build_object('m1', t_mo(1.0, 'insufficient'))),
  ('ffffffff-0000-4000-8000-000000000008', '2022-01-01', 1, 4, 2000, 'partial', jsonb_build_object('m1', t_mo(9.8, 'high'))),
  ('00000000-0000-4000-8000-000000000009', '2023-01-01', 1, 9, 6000, 'full', jsonb_build_object('m1', t_mo(9.7, 'high')));
-- Many snapshots: 40 rows; latest value 0.5, older values up to 9.99.
insert into ufc_fighter_dna_snapshots (fighter_id, as_of_date, definition_version, sample_bouts, sample_seconds, coverage_status, metrics)
select 'ffffffff-0000-4000-8000-000000000007', date '2019-01-01' + (g * 30), 1, g, 600 * g, 'partial',
       jsonb_build_object('m1', t_mo(case when g = 40 then 0.5 else 9.99 - g / 10.0 end, 'high'))
from generate_series(1, 40) g;
-- Definition version 2 exists for two fighters only.
insert into ufc_fighter_dna_snapshots (fighter_id, as_of_date, definition_version, sample_bouts, sample_seconds, coverage_status, metrics) values
  ('ffffffff-0000-4000-8000-000000000003', '2023-01-01', 2, 2, 1000, 'partial', jsonb_build_object('m1', t_mo(1.5, 'low'))),
  (t_uuid('f1'), '2023-01-01', 2, 2, 1000, 'partial', jsonb_build_object('m1', t_mo(2.5, 'low')));
-- Stance splits: 1,100 fighters x 1 SOUTHPAW split; two stars late in UUID order.
insert into ufc_fighter_stance_splits (fighter_id, as_of_date, opponent_stance, definition_version, appearances, wins, confidence, metrics)
select t_uuid('f' || i), '2023-01-01', 'SOUTHPAW', 1, 1 + i % 4, i % 3, 'low',
       jsonb_build_object('finish_rate', t_mo(round(((i % 50) / 100.0)::numeric, 4), 'low'))
from generate_series(1, 1100) i;
insert into ufc_fighter_stance_splits (fighter_id, as_of_date, opponent_stance, definition_version, appearances, wins, confidence, metrics) values
  ('ffffffff-0000-4000-8000-000000000001', '2023-01-01', 'SOUTHPAW', 1, 5, 5, 'medium', jsonb_build_object('finish_rate', t_mo(1.0, 'medium'))),
  ('ffffffff-0000-4000-8000-000000000002', '2023-01-01', 'SOUTHPAW', 1, 1, 1, 'low', jsonb_build_object('finish_rate', t_mo(1.0, 'low')));
analyze;

-- ------------------------------------------ the old algorithm, for the mutation
-- Faithful to the Worker before the fix: PostgREST scan with the metric/confidence/
-- bound filters, ordered fighter_id asc, as_of_date desc, LIMIT 1000; then keep a
-- candidate only when it is the fighter's true latest row; then active; then order;
-- then limit. Same return shape as the real function.
create function test_old_window_ranking(p_metric text, p_definition_version int default 1, p_as_of date default null,
  p_min_confidence text default 'low', p_min numeric default null, p_max numeric default null, p_active boolean default null,
  p_order text default 'desc', p_limit int default 50, p_stance text default null, p_min_appearances int default 1)
returns jsonb language sql stable as $fn$
with conf as (select array(select k from (values ('insufficient',0),('low',1),('medium',2),('high',3)) t(k,r)
                where t.r >= case p_min_confidence when 'insufficient' then 0 when 'low' then 1 when 'medium' then 2 when 'high' then 3 end) a),
window_rows as (
  select s.fighter_id, s.as_of_date, s.metrics -> p_metric as metric
  from ufc_fighter_dna_snapshots s, conf
  where s.definition_version = p_definition_version and (p_as_of is null or s.as_of_date <= p_as_of)
    and s.metrics -> p_metric ->> 'confidence' = any (conf.a)
    and (p_min is null or (s.metrics -> p_metric -> 'value') >= to_jsonb(p_min))
    and (p_max is null or (s.metrics -> p_metric -> 'value') <= to_jsonb(p_max))
  order by s.fighter_id, s.as_of_date desc
  limit 1000
),
latest as (select fighter_id, max(as_of_date) d from ufc_fighter_dna_snapshots
           where definition_version = p_definition_version and (p_as_of is null or as_of_date <= p_as_of) group by fighter_id),
cur as (select distinct on (w.fighter_id) w.*, f.name, f.is_active,
               case when jsonb_typeof(w.metric->'value') = 'number' then (w.metric->>'value')::numeric end v
        from window_rows w join latest l on l.fighter_id = w.fighter_id and l.d = w.as_of_date join ufc_fighters f on f.id = w.fighter_id
        where jsonb_typeof(w.metric) = 'object' and w.metric ? 'value' and (p_active is null or f.is_active is not distinct from p_active)
        order by w.fighter_id),
ranked as (select c.*, row_number() over (order by case when v is null then 1 else 0 end,
             case when p_order = 'asc' then v end asc, case when p_order <> 'asc' then v end desc, coalesce(name,'') collate "en-US-x-icu", fighter_id::text) rank from cur c)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(jsonb_build_object('fighter_id', fighter_id, 'as_of_date', as_of_date, 'metric', metric, 'rank', rank) order by rank) from ranked where rank <= p_limit), '[]'),
  'eligible', (select count(*) from window_rows), 'matched', (select count(*) from ranked))
$fn$;

-- ------------------------------------------------------------ the oracle
-- Independent construction for snapshot mode: max(as_of_date) per fighter via a
-- grouped subquery, numeric filters, then ORDER BY with the documented tie-break.
create function test_oracle_ids(p_metric text, p_version int, p_as_of date, p_min_conf int, p_min numeric, p_max numeric,
  p_active boolean, p_asc boolean, p_limit int) returns uuid[] language sql stable as $$
  select coalesce(array_agg(fighter_id order by ord), '{}') from (
    select s.fighter_id, row_number() over (order by
        (case when jsonb_typeof(s.metrics->p_metric->'value') = 'number' then 0 else 1 end),
        (case when p_asc and jsonb_typeof(s.metrics->p_metric->'value') = 'number' then (s.metrics->p_metric->>'value')::numeric end) asc,
        (case when not p_asc and jsonb_typeof(s.metrics->p_metric->'value') = 'number' then (s.metrics->p_metric->>'value')::numeric end) desc,
        coalesce(f.name,'') collate "en-US-x-icu", s.fighter_id::text) ord
    from ufc_fighter_dna_snapshots s
    join (select fighter_id, max(as_of_date) d from ufc_fighter_dna_snapshots
          where definition_version = p_version and (p_as_of is null or as_of_date <= p_as_of) group by fighter_id) l
      on l.fighter_id = s.fighter_id and l.d = s.as_of_date and s.definition_version = p_version
    join ufc_fighters f on f.id = s.fighter_id
    where jsonb_typeof(s.metrics->p_metric) = 'object' and (s.metrics->p_metric) ? 'value'
      and array_position(array['insufficient','low','medium','high'], s.metrics->p_metric->>'confidence') - 1 >= p_min_conf
      and (p_min is null or (jsonb_typeof(s.metrics->p_metric->'value') = 'number' and (s.metrics->p_metric->>'value')::numeric >= p_min))
      and (p_max is null or (jsonb_typeof(s.metrics->p_metric->'value') = 'number' and (s.metrics->p_metric->>'value')::numeric <= p_max))
      and (p_active is null or f.is_active is not distinct from p_active)
  ) x where ord <= p_limit $$;

-- -------------------------------------------------------------- the suite
create function test_suite(fn text) returns table(case_name text, ok boolean, detail text) language plpgsql as $$
declare r jsonb; ids uuid[]; expect uuid[]; star1 uuid := 'ffffffff-0000-4000-8000-000000000001';
  call text; combo record; mismatches int := 0;
begin
  call := format('select %I($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', fn);

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 50, null::text, 1;
  ids := array(select (e->>'fighter_id')::uuid from jsonb_array_elements(r->'rows') e);
  case_name := '01 broad default ranks the whole population'; ok := ids[1] = star1 and (r->>'matched')::int > 800;
  detail := format('top=%s matched=%s', ids[1], r->>'matched'); return next;

  case_name := '10 fighter whose UUID sorts outside the first-1000 window ranks by value';
  ok := ids[1:3] = array[star1, '00000000-0000-4000-8000-000000000009'::uuid, 'ffffffff-0000-4000-8000-000000000002'::uuid];
  detail := format('top3=%s', ids[1:3]); return next;

  case_name := '11 limit smaller than population'; ok := jsonb_array_length(r->'rows') = 50 and (r->>'matched')::int > 50;
  detail := format('rows=%s matched=%s', jsonb_array_length(r->'rows'), r->>'matched'); return next;

  execute call into r using 'm1', 1, null::date, 'medium', null::numeric, null::numeric, null::boolean, 'desc', 50, null::text, 1;
  ids := array(select (e->>'fighter_id')::uuid from jsonb_array_elements(r->'rows') e);
  case_name := '02 min_confidence=medium excludes low'; ok := ids[1] = star1 and not ('ffffffff-0000-4000-8000-000000000003'::uuid = any (ids))
    and not exists (select 1 from jsonb_array_elements(r->'rows') e where e->'metric'->>'confidence' in ('low','insufficient'));
  detail := format('top=%s', ids[1:3]); return next;

  execute call into r using 'm1', 1, null::date, 'high', null::numeric, null::numeric, null::boolean, 'desc', 200, null::text, 1;
  case_name := '03 min_confidence=high only high';
  ok := not exists (select 1 from jsonb_array_elements(r->'rows') e where e->'metric'->>'confidence' <> 'high')
    and (r->'rows'->0->>'fighter_id')::uuid = star1;
  detail := format('rows=%s', jsonb_array_length(r->'rows')); return next;

  execute call into r using 'm1', 1, date '2020-01-01', 'low', null::numeric, null::numeric, null::boolean, 'desc', 200, null::text, 1;
  case_name := '04 as_of resolves the latest row at or before as_of';
  ok := exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = star1 and e->>'as_of_date' = '2019-06-01' and (e->'metric'->>'value')::numeric = 3.0)
    and not exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'as_of_date')::date > date '2020-01-01');
  detail := 'star1 at 2019-06-01 value 3.0'; return next;

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'asc', 200, null::text, 1;
  case_name := '05 ascending: smallest numbers first, nulls last';
  ok := (r->'rows'->0->'metric'->>'value')::numeric <= (r->'rows'->1->'metric'->>'value')::numeric
    and (select bool_and(coalesce((a.e->'metric'->>'value')::numeric <= (b.e->'metric'->>'value')::numeric, true))
         from jsonb_array_elements(r->'rows') with ordinality a(e, i) join jsonb_array_elements(r->'rows') with ordinality b(e, j) on j = i + 1
         where jsonb_typeof(b.e->'metric'->'value') = 'number');
  detail := format('first=%s', r->'rows'->0->'metric'->>'value'); return next;

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 2000, null::text, 1;
  case_name := '06 descending order holds over the whole list';
  ok := (select bool_and((a.e->'metric'->>'value')::numeric >= (b.e->'metric'->>'value')::numeric)
         from jsonb_array_elements(r->'rows') with ordinality a(e, i) join jsonb_array_elements(r->'rows') with ordinality b(e, j) on j = i + 1
         where jsonb_typeof(b.e->'metric'->'value') = 'number' and jsonb_typeof(a.e->'metric'->'value') = 'number');
  detail := format('rows=%s', jsonb_array_length(r->'rows')); return next;

  case_name := '07 explicit null stays null, sorts last, never fabricated';
  ok := exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000006' and e->'metric'->'value' = 'null'::jsonb)
    and (select jsonb_typeof(r->'rows'->(jsonb_array_length(r->'rows') - 1)->'metric'->'value')) = 'null';
  detail := 'null row present and last'; return next;

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, 100::numeric, null::boolean, 'desc', 2000, null::text, 1;
  case_name := '07b a bound never admits an explicit null';
  ok := not exists (select 1 from jsonb_array_elements(r->'rows') e where e->'metric'->'value' = 'null'::jsonb);
  detail := 'max=100'; return next;

  execute call into r using 'm1', 1, null::date, 'medium', 8::numeric, 8::numeric, null::boolean, 'desc', 10, null::text, 1;
  case_name := '08 ties break on name then id';
  ok := (r->'rows'->0->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000005' and (r->'rows'->1->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000004';
  detail := format('%s, %s', r->'rows'->0->>'fighter_id', r->'rows'->1->>'fighter_id'); return next;

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 5000, null::text, 1;
  case_name := '09 many historical snapshots: latest value only, fighter once';
  ok := (select count(*) from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000007') = 1
    and exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000007' and (e->'metric'->>'value')::numeric = 0.5);
  detail := 'value 0.5 once'; return next;

  case_name := '09b an older passing row never stands in for a failing latest row';
  ok := not exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000008');
  detail := 'Stale Passer excluded at low'; return next;

  execute call into r using 'm1', 2, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 50, null::text, 1;
  case_name := '12 limit larger than eligible population returns all matched';
  ok := jsonb_array_length(r->'rows') = 2 and (r->>'matched')::int = 2;
  detail := format('rows=%s', jsonb_array_length(r->'rows')); return next;

  case_name := '13 definition_version isolates versions';
  ok := array(select (e->>'fighter_id')::uuid from jsonb_array_elements(r->'rows') e) = array[t_uuid('f1'), 'ffffffff-0000-4000-8000-000000000003'::uuid];
  detail := 'version 2 has exactly two fighters'; return next;

  execute call into r using 'no_such_metric', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 50, null::text, 1;
  case_name := '14 no eligible metric -> empty, not an error'; ok := r->'rows' = '[]'::jsonb and (r->>'matched')::int = 0; detail := r::text; return next;
  execute call into r using 'm1', 1, date '1990-01-01', 'low', null::numeric, null::numeric, null::boolean, 'desc', 50, null::text, 1;
  case_name := '14b as_of before any snapshot -> empty'; ok := r->'rows' = '[]'::jsonb; detail := r::text; return next;

  execute call into r using 'm1', 1, null::date, 'low', null::numeric, null::numeric, true, 'desc', 5000, null::text, 1;
  case_name := '16a active=true removes inactive fighters';
  ok := not exists (select 1 from jsonb_array_elements(r->'rows') e join ufc_fighters f on f.id = (e->>'fighter_id')::uuid where f.is_active is not true);
  detail := 'no inactive'; return next;

  if fn <> 'test_old_window_ranking' then
    execute call into r using 'finish_rate', 1, null::date, 'low', null::numeric, null::numeric, null::boolean, 'desc', 5, 'SOUTHPAW', 3;
    case_name := '16b stance split ranks the whole split population with appearances';
    ok := (r->'rows'->0->>'fighter_id')::uuid = star1 and not exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'appearances')::int < 3)
      and not exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'fighter_id')::uuid = 'ffffffff-0000-4000-8000-000000000002');
    detail := format('top=%s', r->'rows'->0->>'fighter_id'); return next;
  end if;

  for combo in select * from (values
      ('low', null::date, null::numeric, null::numeric, null::boolean, false, 50),
      ('medium', null, null, null, null, false, 50), ('high', null, null, null, null, true, 50),
      ('low', date '2022-06-01', null, null, null, false, 100), ('insufficient', null, null, null, null, true, 200),
      ('low', null, 1.0, 4.0, true, false, 200), ('medium', date '2021-06-01', null, 3.5, null, true, 25)) v(c, a, mn, mx, act, asc_, lim) loop
    execute call into r using 'm1', 1, combo.a, combo.c, combo.mn, combo.mx, combo.act, case when combo.asc_ then 'asc' else 'desc' end, combo.lim, null::text, 1;
    ids := array(select (e->>'fighter_id')::uuid from jsonb_array_elements(r->'rows') e);
    expect := test_oracle_ids('m1', 1, combo.a, array_position(array['insufficient','low','medium','high'], combo.c) - 1, combo.mn, combo.mx, combo.act, combo.asc_, combo.lim);
    if ids is distinct from expect then mismatches := mismatches + 1; end if;
  end loop;
  case_name := '17 oracle agreement across a parameter grid'; ok := mismatches = 0; detail := format('%s of 7 combinations differ', mismatches); return next;
end $$;

-- ------------------------------------------------------------- assertions
create temp table results as select 'new' as impl, * from test_suite('ufc_dna_metric_ranking');
insert into results select 'old_window', * from test_suite('test_old_window_ranking');
select impl, case_name, ok, detail from results order by impl desc, case_name;

do $$
declare failed_new int; failed_old int;
begin
  select count(*) filter (where not ok) into failed_new from results where impl = 'new';
  select count(*) filter (where not ok) into failed_old from results where impl = 'old_window';
  if failed_new > 0 then raise exception 'ufc_dna_metric_ranking failed % case(s)', failed_new; end if;
  if failed_old = 0 then raise exception 'MUTATION NOT DETECTED: the old 1,000-row UUID window passed the suite'; end if;
  raise notice 'PASS: new implementation passes every case; the old window fails % case(s)', failed_old;
end $$;

-- Privileges: execute is service_role only.
do $$ begin
  if has_function_privilege('anon', 'public.ufc_dna_metric_ranking(text,int,date,text,numeric,numeric,boolean,text,int,text,int)', 'execute') then raise exception 'anon can execute'; end if;
  if not has_function_privilege('service_role', 'public.ufc_dna_metric_ranking(text,int,date,text,numeric,numeric,boolean,text,int,text,int)', 'execute') then raise exception 'service_role cannot execute'; end if;
  raise notice 'PASS: privileges';
end $$;
