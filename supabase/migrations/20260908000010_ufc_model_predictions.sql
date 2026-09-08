-- PropBetEdge UFC — 010: PBE Fight Model, immutable predictions and tracking
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. Nothing here alters an existing table and nothing here inserts
-- a row: a record starts empty and stays empty until real locked picks are
-- published. A seeded record would be a lie told once and repeated forever.
--
-- =========================================================================
-- THE TWO RULES THIS SCHEMA EXISTS TO ENFORCE
-- =========================================================================
--
-- 1. A LOCKED PREDICTION IS A HISTORICAL FACT.
--
--    The whole value of a public model record is that it was fixed before the
--    fight and could not be quietly improved afterwards. Application code is
--    the wrong place to guarantee that: an ORM upsert, a re-run of a cron job,
--    a well-meaning backfill, or a hand-written UPDATE in a SQL console are all
--    one keystroke away from rewriting history, and none of them would leave a
--    trace. So the guarantee is a database trigger. Once locked_at is set, the
--    probability, the pick, the model version, the feature version, the feature
--    vector and the market comparison are frozen at the storage layer. The only
--    permitted change is grading, once, from NULL to a value.
--
--    A prediction that is wrong stays wrong, in public, permanently. That is
--    the product.
--
-- 2. BACKTEST AND LIVE ARE DIFFERENT KINDS OF CLAIM AND NEVER MIX.
--
--    A backtest number is what a model would have done. A live number is what
--    it did do, with the future genuinely unknown at the time. Presenting them
--    together, or summing them, converts an honest research result into a
--    false track record. They are therefore in SEPARATE TABLES, not one table
--    with a flag - a flag is one forgotten WHERE clause away from a blended
--    number. Each table additionally carries a record_class column pinned by a
--    CHECK constraint to a single value, so that even a query that does manage
--    to union them cannot produce an unlabelled row.
--
--    There is deliberately no view in this migration that reads from both.
--
-- RLS is enabled with no public policies, matching the rest of the UFC schema.

begin;

-- =========================================================================
-- Model versions
-- =========================================================================
-- A stored prediction is meaningless without the exact model that produced it.
-- Coefficients and scaling live here rather than in application code so that a
-- prediction made in March can still be explained in November, after the code
-- has moved on.

create table if not exists public.ufc_model_versions (
  model_version text primary key,
  model_family text not null,
  feature_version text not null,
  algorithm text not null,
  -- Free-form but required: how the thing was validated, in one line.
  validation text not null,
  trained_at timestamptz not null,
  training_window_start date,
  training_window_end date,
  training_bouts int check (training_bouts is null or training_bouts >= 0),
  hyperparameters jsonb not null default '{}'::jsonb,
  -- {feature_key: coefficient} and {feature_key: scale}. Ordered by the feature
  -- spec, which is itself versioned by feature_version.
  coefficients jsonb not null,
  feature_scale jsonb not null,
  -- sha256 over the canonical serialisation of the feature spec, coefficients
  -- and scale. Two rows with the same hash are the same model; a hash that no
  -- longer matches a recomputation is a tampered row.
  spec_sha256 text not null,
  -- Recorded out-of-sample performance AT RELEASE. Never updated afterwards:
  -- this is the claim that was made when the version shipped, not a rolling
  -- number that could drift towards flattery.
  release_metrics jsonb not null default '{}'::jsonb,
  methodology_ref text,
  status text not null default 'candidate' check (status in ('candidate', 'live', 'retired')),
  notes text,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  check (retired_at is null or status = 'retired')
);

comment on table public.ufc_model_versions is
  'One row per released model. Coefficients are stored, not recomputed, so a prediction from any past version stays explainable after the code moves on.';
comment on column public.ufc_model_versions.release_metrics is
  'Out-of-sample performance as it stood at release. Frozen by trigger: a version''s published claim never improves retroactively.';

-- A released model is a fixed object. Only status and retired_at may move, and
-- only forwards.
create or replace function public.ufc_model_versions_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ufc_model_versions rows are permanent: % cannot be deleted', old.model_version
      using errcode = 'restrict_violation';
  end if;

  if new.model_version is distinct from old.model_version
     or new.feature_version is distinct from old.feature_version
     or new.algorithm is distinct from old.algorithm
     or new.coefficients is distinct from old.coefficients
     or new.feature_scale is distinct from old.feature_scale
     or new.spec_sha256 is distinct from old.spec_sha256
     or new.trained_at is distinct from old.trained_at
     or new.release_metrics is distinct from old.release_metrics then
    raise exception 'model version % is released and immutable; publish a new model_version instead', old.model_version
      using errcode = 'restrict_violation';
  end if;

  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'model version % is retired and cannot be un-retired', old.model_version
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ufc_model_versions_immutable_trg on public.ufc_model_versions;
create trigger ufc_model_versions_immutable_trg
  before update or delete on public.ufc_model_versions
  for each row execute function public.ufc_model_versions_immutable();

-- =========================================================================
-- LIVE predictions
-- =========================================================================
-- This table holds published picks and nothing else. It is not where backtests
-- go, it is not where experiments go, and it is not where a re-run of an old
-- card goes.

create table if not exists public.ufc_model_predictions (
  id uuid primary key default gen_random_uuid(),

  record_class text not null default 'LIVE' check (record_class = 'LIVE'),

  bout_id uuid not null references public.ufc_bouts(id) on delete restrict,
  event_id uuid references public.ufc_events(id) on delete restrict,
  -- Denormalised from the bout on purpose. A bout row can be corrected or
  -- replaced; the prediction must still say which two people it was about.
  fighter_a_id uuid not null references public.ufc_fighters(id) on delete restrict,
  fighter_b_id uuid not null references public.ufc_fighters(id) on delete restrict,

  model_version text not null references public.ufc_model_versions(model_version) on delete restrict,
  feature_version text not null,

  prob_a numeric(9, 8) not null check (prob_a > 0 and prob_a < 1),
  prob_b numeric(9, 8) not null check (prob_b > 0 and prob_b < 1),
  -- The model is antisymmetric by construction, so the two probabilities are
  -- complementary rather than normalised after the fact. Enforcing it here
  -- means a future model that quietly loses that property fails loudly.
  constraint ufc_model_predictions_complementary check (abs(prob_a + prob_b - 1) < 0.000001),

  pick_fighter_id uuid not null references public.ufc_fighters(id) on delete restrict,
  pick_probability numeric(9, 8) not null check (pick_probability >= 0.5 and pick_probability < 1),
  confidence_band text not null check (confidence_band in ('50-55', '55-60', '60-65', '65-70', '70-80', '80-100')),

  -- Exactly what the model saw. Without it, a past prediction cannot be
  -- re-derived, and an unre-derivable prediction is an assertion, not evidence.
  feature_vector jsonb not null,
  feature_availability jsonb not null default '{}'::jsonb,
  -- Sample context shown beside the probability: prior bouts, stat-covered
  -- bouts and coverage grade per corner.
  sample_context jsonb not null default '{}'::jsonb,

  generated_at timestamptz not null default now(),
  -- Null until published. Setting it is a one-way door.
  locked_at timestamptz,

  -- Market comparison. Populated only when a timestamp-compatible observation
  -- exists; never estimated, never back-filled from a later price.
  market_observation_id bigint references public.ufc_market_observations(id) on delete set null,
  market_snapshot_at timestamptz,
  market_implied_prob_pick numeric(9, 8) check (market_implied_prob_pick is null or (market_implied_prob_pick > 0 and market_implied_prob_pick < 1)),
  market_books int check (market_books is null or market_books >= 0),
  -- Percentage points, model minus market, on the picked side. Stored rather
  -- than computed at read time because both inputs are frozen anyway and a
  -- reader should not have to trust that the arithmetic has not changed.
  model_edge_pts numeric(6, 2),

  result text check (result is null or result in ('WIN', 'LOSS', 'DRAW', 'NC', 'VOID')),
  result_winner_id uuid references public.ufc_fighters(id) on delete restrict,
  graded_at timestamptz,
  graded_by text,

  created_at timestamptz not null default now(),

  check (fighter_a_id <> fighter_b_id),
  check (pick_fighter_id in (fighter_a_id, fighter_b_id)),
  check (locked_at is null or locked_at >= generated_at),
  check (graded_at is null or locked_at is not null),
  check (graded_at is null or graded_at >= locked_at),
  check ((result is null) = (graded_at is null)),
  check (market_snapshot_at is null or locked_at is null or market_snapshot_at <= locked_at),

  -- One published prediction per bout per model and feature version. A second
  -- opinion from the same model on the same fight is a rewrite wearing a hat.
  constraint ufc_model_predictions_one_per_bout unique (bout_id, model_version, feature_version)
);

create index if not exists ufc_model_predictions_locked_idx
  on public.ufc_model_predictions (model_version, locked_at desc) where locked_at is not null;
create index if not exists ufc_model_predictions_graded_idx
  on public.ufc_model_predictions (model_version, graded_at desc) where graded_at is not null;
create index if not exists ufc_model_predictions_bout_idx
  on public.ufc_model_predictions (bout_id);
create index if not exists ufc_model_predictions_pending_idx
  on public.ufc_model_predictions (event_id) where graded_at is null;

comment on table public.ufc_model_predictions is
  'Published PBE Fight Model picks. LIVE ONLY - backtests live in ufc_model_backtest_predictions and the two are never combined. A row with locked_at set is immutable except for one-shot grading, enforced by trigger rather than by convention.';
comment on column public.ufc_model_predictions.locked_at is
  'When the prediction was published. Setting it is irreversible and freezes the row. Must fall on or before the event date: a lock recorded after the fight is not a prediction.';
comment on column public.ufc_model_predictions.model_edge_pts is
  'Model probability minus de-vigged market implied probability for the picked fighter, in percentage points. Computed after the model produced its number; the market is never a model input.';

-- The lock. Everything about this trigger is deliberately unhelpful to anyone
-- trying to tidy up a bad prediction.
create or replace function public.ufc_model_predictions_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.locked_at is not null then
      raise exception 'locked prediction % cannot be deleted', old.id
        using errcode = 'restrict_violation',
              hint = 'A published pick is a permanent record. Grade it; do not remove it.';
    end if;
    return old;
  end if;

  -- Locking is one-way, and it has to happen before the fight.
  if old.locked_at is not null and new.locked_at is distinct from old.locked_at then
    raise exception 'locked_at on prediction % is already set and cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.locked_at is not null then
    if new.bout_id is distinct from old.bout_id
       or new.event_id is distinct from old.event_id
       or new.fighter_a_id is distinct from old.fighter_a_id
       or new.fighter_b_id is distinct from old.fighter_b_id
       or new.model_version is distinct from old.model_version
       or new.feature_version is distinct from old.feature_version
       or new.prob_a is distinct from old.prob_a
       or new.prob_b is distinct from old.prob_b
       or new.pick_fighter_id is distinct from old.pick_fighter_id
       or new.pick_probability is distinct from old.pick_probability
       or new.confidence_band is distinct from old.confidence_band
       or new.feature_vector is distinct from old.feature_vector
       or new.feature_availability is distinct from old.feature_availability
       or new.sample_context is distinct from old.sample_context
       or new.generated_at is distinct from old.generated_at
       or new.market_observation_id is distinct from old.market_observation_id
       or new.market_snapshot_at is distinct from old.market_snapshot_at
       or new.market_implied_prob_pick is distinct from old.market_implied_prob_pick
       or new.market_books is distinct from old.market_books
       or new.model_edge_pts is distinct from old.model_edge_pts
       or new.created_at is distinct from old.created_at
       or new.record_class is distinct from old.record_class then
      raise exception 'prediction % is locked; only grading fields may change', old.id
        using errcode = 'restrict_violation',
              hint = 'Publish a new model_version if the model has changed. A locked pick is never edited.';
    end if;

    -- Grading happens once. A result that can be revised is not a result.
    if old.result is not null and (new.result is distinct from old.result or new.graded_at is distinct from old.graded_at) then
      raise exception 'prediction % has already been graded as % and cannot be regraded', old.id, old.result
        using errcode = 'restrict_violation';
    end if;
    if old.result_winner_id is not null and new.result_winner_id is distinct from old.result_winner_id then
      raise exception 'prediction % already records a winner and cannot be changed', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ufc_model_predictions_immutable_trg on public.ufc_model_predictions;
create trigger ufc_model_predictions_immutable_trg
  before update or delete on public.ufc_model_predictions
  for each row execute function public.ufc_model_predictions_immutable();

-- The write gate. Runs on INSERT as well as UPDATE, which is the whole point:
-- the normal publishing path inserts a row with locked_at ALREADY SET, so a
-- rule that only fires on the update transition would never see the row that
-- matters most. Two things are checked here.
--
--   A pick has to agree with its own probabilities. The pick is what gets
--   published, and a mismatch between it and the numbers beside it would be
--   invisible in the UI.
--
--   A lock has to land before the fight. A row claiming to be a pick, carrying
--   a lock timestamp dated after the card, is not a prediction; it is a result
--   with a probability attached. created_at is defaulted and frozen so that a
--   locked_at backdated to before the event still leaves the moment the row
--   actually appeared on the record.
create or replace function public.ufc_model_predictions_write_gate()
returns trigger
language plpgsql
as $$
declare
  expected numeric;
  event_day date;
begin
  expected := case when new.pick_fighter_id = new.fighter_a_id then new.prob_a else new.prob_b end;
  if abs(expected - new.pick_probability) > 0.000001 then
    raise exception 'pick_probability % does not match the probability of the picked fighter (%)', new.pick_probability, expected
      using errcode = 'check_violation';
  end if;
  if expected < 0.5 then
    raise exception 'pick_fighter_id names the corner the model made an underdog (p=%)', expected
      using errcode = 'check_violation';
  end if;

  if new.locked_at is not null and (tg_op = 'INSERT' or old.locked_at is null) then
    if new.locked_at > now() then
      raise exception 'locked_at % is in the future', new.locked_at
        using errcode = 'check_violation';
    end if;
    select e.event_date into event_day
      from public.ufc_events e
      join public.ufc_bouts b on b.event_id = e.id
     where b.id = new.bout_id;
    if event_day is not null and new.locked_at >= (event_day + 1)::timestamptz then
      raise exception 'prediction for bout % cannot be locked after its event date (%)', new.bout_id, event_day
        using errcode = 'restrict_violation',
              hint = 'A pick recorded once the card has happened is not a prediction. Publish it before the event or not at all.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ufc_model_predictions_coherent_trg on public.ufc_model_predictions;
drop trigger if exists ufc_model_predictions_write_gate_trg on public.ufc_model_predictions;
create trigger ufc_model_predictions_write_gate_trg
  before insert or update on public.ufc_model_predictions
  for each row execute function public.ufc_model_predictions_write_gate();

-- =========================================================================
-- BACKTEST records — separate tables, never joined to the live ones
-- =========================================================================

create table if not exists public.ufc_model_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  record_class text not null default 'BACKTEST' check (record_class = 'BACKTEST'),
  model_version text not null,
  feature_version text not null,
  -- Walk-forward protocol as executed: fold definition, training floor, penalty
  -- grid, selection rule. Stored so a result can be argued with.
  protocol jsonb not null,
  code_sha text,
  dataset_fingerprint text,
  first_scored_event date,
  last_scored_event date,
  scored_bouts int not null default 0 check (scored_bouts >= 0),
  summary jsonb not null default '{}'::jsonb,
  leakage_audit jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  status text not null default 'complete' check (status in ('running', 'complete', 'failed', 'superseded'))
);

comment on table public.ufc_model_backtest_runs is
  'Research results. What the model WOULD have done. Never a track record, never combined with ufc_model_predictions.';

create table if not exists public.ufc_model_backtest_predictions (
  run_id uuid not null references public.ufc_model_backtest_runs(id) on delete cascade,
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  record_class text not null default 'BACKTEST' check (record_class = 'BACKTEST'),
  fold_key text not null,
  fighter_1_id uuid not null references public.ufc_fighters(id),
  fighter_2_id uuid not null references public.ufc_fighters(id),
  event_date date not null,
  prob_1 numeric(9, 8) not null check (prob_1 > 0 and prob_1 < 1),
  prob_2 numeric(9, 8) not null check (prob_2 > 0 and prob_2 < 1),
  pick_fighter_id uuid not null references public.ufc_fighters(id),
  pick_probability numeric(9, 8) not null,
  confidence_band text not null,
  actual_winner_id uuid references public.ufc_fighters(id),
  result text check (result is null or result in ('WIN', 'LOSS', 'DRAW', 'NC', 'VOID')),
  market_implied_prob_pick numeric(9, 8),
  model_edge_pts numeric(6, 2),
  primary key (run_id, bout_id),
  constraint ufc_model_backtest_complementary check (abs(prob_1 + prob_2 - 1) < 0.000001)
);

create index if not exists ufc_model_backtest_predictions_run_idx
  on public.ufc_model_backtest_predictions (run_id, event_date);

-- =========================================================================
-- Reporting views
-- =========================================================================
-- Two views, two sources, no union anywhere. Both emit record_class so a
-- consumer that stitches them together downstream still has to show which is
-- which.

-- LIVE. Counts only rows that were actually locked before their fight. An
-- unlocked draft is not part of the record.
create or replace view public.ufc_model_live_record as
select
  p.model_version,
  p.feature_version,
  'LIVE'::text as record_class,
  count(*) filter (where p.locked_at is not null) as locked_predictions,
  count(*) filter (where p.locked_at is not null and p.graded_at is null) as pending,
  count(*) filter (where p.result = 'WIN') as wins,
  count(*) filter (where p.result = 'LOSS') as losses,
  count(*) filter (where p.result in ('DRAW', 'NC', 'VOID')) as no_decision,
  count(*) filter (where p.result in ('WIN', 'LOSS')) as decided,
  -- Null rather than zero when nothing has been graded. A hit rate of 0% and
  -- "no fights yet" are different statements and the UI must be able to tell
  -- them apart.
  case when count(*) filter (where p.result in ('WIN', 'LOSS')) > 0
    then count(*) filter (where p.result = 'WIN')::numeric / count(*) filter (where p.result in ('WIN', 'LOSS'))
  end as hit_rate,
  count(*) filter (where p.result = 'WIN' and p.pick_probability >= 0.65) as high_conf_wins,
  count(*) filter (where p.result = 'LOSS' and p.pick_probability >= 0.65) as high_conf_losses,
  -- Brier over decided fights, scored on the picked side.
  case when count(*) filter (where p.result in ('WIN', 'LOSS')) > 0
    then avg(power(p.pick_probability - (case when p.result = 'WIN' then 1 else 0 end), 2))
         filter (where p.result in ('WIN', 'LOSS'))
  end as brier,
  case when count(*) filter (where p.result in ('WIN', 'LOSS')) > 0
    then avg(p.pick_probability) filter (where p.result in ('WIN', 'LOSS'))
  end as mean_confidence,
  count(*) filter (where p.model_edge_pts is not null) as market_compared,
  avg(p.model_edge_pts) filter (where p.model_edge_pts is not null) as mean_edge_pts,
  min(p.locked_at) as first_locked_at,
  max(p.locked_at) as last_locked_at
from public.ufc_model_predictions p
group by p.model_version, p.feature_version;

comment on view public.ufc_model_live_record is
  'The published record. Empty until the first locked pick is graded, and it stays empty rather than showing a placeholder.';

-- LIVE, most recent thirty decided picks.
create or replace view public.ufc_model_live_recent as
select
  model_version,
  feature_version,
  'LIVE'::text as record_class,
  count(*) as decided,
  count(*) filter (where result = 'WIN') as wins,
  count(*) filter (where result = 'LOSS') as losses,
  case when count(*) > 0 then count(*) filter (where result = 'WIN')::numeric / count(*) end as hit_rate,
  avg(power(pick_probability - (case when result = 'WIN' then 1 else 0 end), 2)) as brier
from (
  select p.*, row_number() over (partition by p.model_version, p.feature_version order by p.graded_at desc, p.id) as rn
  from public.ufc_model_predictions p
  where p.result in ('WIN', 'LOSS')
) ranked
where rn <= 30
group by model_version, feature_version;

-- LIVE calibration by confidence band.
create or replace view public.ufc_model_live_calibration as
select
  model_version,
  feature_version,
  'LIVE'::text as record_class,
  confidence_band,
  count(*) as decided,
  count(*) filter (where result = 'WIN') as wins,
  count(*) filter (where result = 'WIN')::numeric / nullif(count(*), 0) as observed,
  avg(pick_probability) as predicted
from public.ufc_model_predictions
where result in ('WIN', 'LOSS')
group by model_version, feature_version, confidence_band;

-- BACKTEST. Same shape, different source, different meaning.
create or replace view public.ufc_model_backtest_record as
select
  r.id as run_id,
  r.model_version,
  r.feature_version,
  'BACKTEST'::text as record_class,
  r.generated_at,
  r.first_scored_event,
  r.last_scored_event,
  count(*) as scored,
  count(*) filter (where b.result = 'WIN') as wins,
  count(*) filter (where b.result = 'LOSS') as losses,
  count(*) filter (where b.result in ('WIN', 'LOSS'))::int as decided,
  case when count(*) filter (where b.result in ('WIN', 'LOSS')) > 0
    then count(*) filter (where b.result = 'WIN')::numeric / count(*) filter (where b.result in ('WIN', 'LOSS'))
  end as hit_rate,
  avg(power(b.pick_probability - (case when b.result = 'WIN' then 1 else 0 end), 2))
    filter (where b.result in ('WIN', 'LOSS')) as brier
from public.ufc_model_backtest_runs r
join public.ufc_model_backtest_predictions b on b.run_id = r.id
group by r.id, r.model_version, r.feature_version, r.generated_at, r.first_scored_event, r.last_scored_event;

comment on view public.ufc_model_backtest_record is
  'Research result, not a track record. Deliberately has no view in common with ufc_model_live_record.';

alter table public.ufc_model_versions enable row level security;
alter table public.ufc_model_predictions enable row level security;
alter table public.ufc_model_backtest_runs enable row level security;
alter table public.ufc_model_backtest_predictions enable row level security;

commit;
