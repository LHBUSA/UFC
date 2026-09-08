-- PropBetEdge UFC — 011: PBE Fight Model, unforgeable pre-fight locks and
-- append-only grading
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. Nothing here alters an existing table and nothing here inserts
-- a row: a record starts empty and stays empty until real locked picks are
-- published. A seeded record would be a lie told once and repeated forever.
--
-- Numbering: this was drafted as 010 and renumbered. `migrations/010` is
-- `010_store_provisioning.sql` on the store branches, and two different tenth
-- migrations is the kind of ambiguity that survives until the day someone
-- applies the wrong one. The Supabase mirror keeps version 20260908000010 by
-- instruction — note that `ufc-injuries-v1` currently carries the same Supabase
-- version for `20260908000010_ufc_fighter_status.sql`, so whichever of the two
-- branches merges second has to be renumbered there.
--
-- =========================================================================
-- THE THREE RULES THIS SCHEMA EXISTS TO ENFORCE
-- =========================================================================
--
-- 1. A LOCK IS A DATABASE EVENT, NOT A CLAIM MADE BY THE CALLER.
--
--    The value of a public model record is that the pick was fixed before the
--    fight. That is worth nothing if the caller supplies the timestamp that
--    proves it. Anyone who can write the row can write the time on the row, so
--    a backdated `locked_at` would forge exactly the property the record is
--    supposed to demonstrate — and it would forge it invisibly.
--
--    So `locked_at` is never accepted from a caller. It cannot be set on
--    INSERT at all. The only way a row becomes locked is the transition
--    NULL -> value on UPDATE, and on that transition the trigger OVERWRITES
--    whatever was supplied with `clock_timestamp()`. The database's own clock
--    is the only clock in the system.
--
--    `ufc_model_publish_prediction()` is the intended path and is additionally
--    required by a transaction-local guard, but the guarantee does not rest on
--    that: even a caller who reaches around the function gets a server-stamped
--    time or an exception.
--
-- 2. THE LOCK WINDOW CLOSES BEFORE THE EVENT'S UTC DAY BEGINS.
--
--    `ufc_events` has `event_date` and no start timestamp. A cutoff of
--    "event date plus one day" — the obvious reading of "before the fight" —
--    permits locking a pick at 23:00 on fight night for a bout that finished at
--    20:00. Same calendar date, three hours after the result.
--
--    Until an authoritative `event_start_at` exists, the cutoff is therefore
--    `event_date 00:00:00 UTC`: a pick must be locked before the event's UTC
--    date begins at all. That is conservative by up to a full day and it is
--    deliberately so. No UFC card in any timezone has begun before its own
--    event date starts in UTC, so a lock that clears this cutoff cannot be
--    post-fight, and the cost is that a genuine same-day publication is
--    refused. Refusing a real pick is recoverable. Accepting a forged one is
--    not.
--
--    When `ufc_events.event_start_at` lands, `ufc_model_lock_cutoff()` is the
--    single function to change, and the cutoff can be relaxed to the real bout
--    start minus a lead time without touching anything else.
--
-- 3. THE PREDICTION IS PERMANENT. THE GRADE IS CORRECTABLE AND AUDITABLE.
--
--    These are different kinds of fact and the first version of this schema
--    conflated them, making the first result unrevisable forever. That is wrong
--    for combat sports: results get overturned on appeal, changed to no-contest
--    after a failed test, and corrected when a commission mis-records them. A
--    schema that cannot represent an overturned result forces someone to either
--    publish a knowingly wrong record or break the immutability guarantee to
--    fix it, and they will choose the second.
--
--    So the prediction row carries no result at all. Once locked it is frozen
--    completely — there is no permitted UPDATE to it, ever. Grades live in
--    `ufc_model_prediction_grades`, which is append-only: a correction is a new
--    revision that supersedes the previous one and must carry a reason. The
--    tracker reads the current revision; every superseded grade stays readable.
--
-- 4. BACKTEST AND LIVE ARE DIFFERENT KINDS OF CLAIM AND NEVER MIX.
--
--    A backtest number is what a model would have done. A live number is what
--    it did do, with the future genuinely unknown at the time. They are in
--    SEPARATE TABLES, not one table with a flag — a flag is one forgotten WHERE
--    clause away from a blended number. Each table carries a record_class
--    pinned by a CHECK, so even a query that does union them cannot produce an
--    unlabelled row. There is deliberately no view here that reads from both.
--
-- RLS is enabled with no public policies, matching the rest of the UFC schema.

begin;

-- =========================================================================
-- Model versions
-- =========================================================================

create table if not exists public.ufc_model_versions (
  model_version text primary key,
  model_family text not null,
  feature_version text not null,
  algorithm text not null,
  validation text not null,
  trained_at timestamptz not null,
  training_window_start date,
  training_window_end date,
  training_bouts int check (training_bouts is null or training_bouts >= 0),
  hyperparameters jsonb not null default '{}'::jsonb,
  coefficients jsonb not null,
  feature_scale jsonb not null,
  -- sha256 over the canonical serialisation of the feature spec, coefficients
  -- and scale. Two rows with the same hash are the same model; a hash that no
  -- longer matches a recomputation is a tampered row.
  spec_sha256 text not null,
  -- Out-of-sample performance AT RELEASE. Frozen: this is the claim made when
  -- the version shipped, not a rolling number that could drift toward flattery.
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

  -- Exactly what the model saw. Without it a past prediction cannot be
  -- re-derived, and an unre-derivable prediction is an assertion, not evidence.
  feature_vector jsonb not null,
  feature_availability jsonb not null default '{}'::jsonb,
  sample_context jsonb not null default '{}'::jsonb,

  -- When the model produced the number. Caller-supplied, because it can
  -- legitimately precede the insert, but it may not be in the future.
  generated_at timestamptz not null default now(),
  -- Server-stamped on insert. Tamper evidence: a row whose created_at is far
  -- from its locked_at was drafted long before it was published, which is
  -- normal; a row that appears in the table after its event is visible here
  -- even though it could never have been locked.
  created_at timestamptz not null default now(),
  -- NULL until published. Never accepted from a caller: set only by the
  -- NULL -> value transition, and stamped from the server clock by trigger.
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

  check (fighter_a_id <> fighter_b_id),
  check (pick_fighter_id in (fighter_a_id, fighter_b_id)),
  check (locked_at is null or locked_at >= generated_at),
  check (market_snapshot_at is null or locked_at is null or market_snapshot_at <= locked_at),

  -- One published prediction per bout per model and feature version. A second
  -- opinion from the same model on the same fight is a rewrite wearing a hat.
  constraint ufc_model_predictions_one_per_bout unique (bout_id, model_version, feature_version)
);

create index if not exists ufc_model_predictions_locked_idx
  on public.ufc_model_predictions (model_version, locked_at desc) where locked_at is not null;
create index if not exists ufc_model_predictions_bout_idx
  on public.ufc_model_predictions (bout_id);
create index if not exists ufc_model_predictions_draft_idx
  on public.ufc_model_predictions (event_id) where locked_at is null;

comment on table public.ufc_model_predictions is
  'Published PBE Fight Model picks. LIVE ONLY. A row with locked_at set is completely frozen - there is no permitted update to it, including grading, which lives in ufc_model_prediction_grades.';
comment on column public.ufc_model_predictions.locked_at is
  'Server-stamped publication time. Never accepted from a caller: settable only via the NULL -> value transition, overwritten with clock_timestamp() by trigger, and refused once the lock window has closed. Use ufc_model_publish_prediction().';
comment on column public.ufc_model_predictions.model_edge_pts is
  'Model probability minus de-vigged market implied probability for the picked fighter, in percentage points. Computed after the model produced its number; the market is never a model input.';

-- ---- the lock cutoff -----------------------------------------------------
-- One function, so there is one place to change when an authoritative event
-- start timestamp exists. Returns the instant at which locking a prediction for
-- this bout stops being allowed.
create or replace function public.ufc_model_lock_cutoff(p_bout_id uuid)
returns timestamptz
language plpgsql
stable
as $$
declare
  ev date;
begin
  select e.event_date into ev
    from public.ufc_events e
    join public.ufc_bouts b on b.event_id = e.id
   where b.id = p_bout_id;
  if ev is null then
    return null;  -- caller decides; the trigger refuses to lock without a date
  end if;
  -- Start of the event's UTC day. See rule 2 in the header for why this is
  -- deliberately a full day earlier than "before the fight".
  return (ev::timestamp at time zone 'UTC');
end;
$$;

comment on function public.ufc_model_lock_cutoff(uuid) is
  'Instant after which a prediction for this bout can no longer be locked. Currently the start of the event UTC day, because ufc_events has no start timestamp and a same-day cutoff would permit locking after an early bout finished. Relax this - and only this - when event_start_at exists.';

-- ---- the write gate ------------------------------------------------------
create or replace function public.ufc_model_predictions_write_gate()
returns trigger
language plpgsql
as $$
declare
  expected numeric;
  cutoff timestamptz;
  now_ts timestamptz := clock_timestamp();
begin
  -- The frozen-row rule comes FIRST. Checking coherence before it would answer
  -- an attempt to rewrite a locked pick with an arithmetic complaint, which
  -- tells the caller nothing about the actual reason and reads, in a log, like
  -- a bug rather than a refusal.
  if tg_op = 'UPDATE' and old.locked_at is not null then
    raise exception 'prediction % is locked and cannot be modified', old.id
      using errcode = 'restrict_violation',
            hint = 'A published pick is permanent. Record a result in ufc_model_prediction_grades; publish a new model_version if the model changed.';
  end if;

  -- The pick has to agree with its own probabilities. The pick is what gets
  -- published, and a mismatch would be invisible in the UI.
  expected := case when new.pick_fighter_id = new.fighter_a_id then new.prob_a else new.prob_b end;
  if abs(expected - new.pick_probability) > 0.000001 then
    raise exception 'pick_probability % does not match the probability of the picked fighter (%)', new.pick_probability, expected
      using errcode = 'check_violation';
  end if;
  if expected < 0.5 then
    raise exception 'pick_fighter_id names the corner the model made an underdog (p=%)', expected
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    -- A prediction is born unlocked. Accepting locked_at here would accept the
    -- caller's word for the one fact the record exists to prove.
    if new.locked_at is not null then
      raise exception 'locked_at cannot be set on insert'
        using errcode = 'check_violation',
              hint = 'Insert the prediction unlocked, then publish it with ufc_model_publish_prediction(id). The lock time comes from the database clock.';
    end if;
    -- created_at is the server's record of when the row appeared, so the
    -- server writes it regardless of what was supplied.
    new.created_at := now_ts;
    if new.generated_at > now_ts then
      raise exception 'generated_at % is in the future', new.generated_at
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ---- UPDATE on a still-unlocked row ----
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is server-controlled and cannot be changed'
      using errcode = 'restrict_violation';
  end if;
  if new.record_class is distinct from old.record_class then
    raise exception 'record_class cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  if new.locked_at is not null then
    -- This is the publishing transition. Two things happen and both matter.
    --
    -- First, the guard: locking is expected to go through
    -- ufc_model_publish_prediction(), which takes the row FOR UPDATE and sets a
    -- transaction-local flag. That serialises concurrent publishes and keeps
    -- the whole operation in one place.
    if coalesce(current_setting('pbe.model_publishing', true), '') <> 'on' then
      raise exception 'locked_at may only be set by ufc_model_publish_prediction()'
        using errcode = 'restrict_violation',
              hint = 'select ufc_model_publish_prediction(''<prediction id>'');';
    end if;

    -- Second, and this is the guarantee that does not depend on the guard: the
    -- supplied value is discarded and replaced with the server clock. A caller
    -- who sets the flag by hand still cannot choose the time.
    new.locked_at := now_ts;

    cutoff := public.ufc_model_lock_cutoff(new.bout_id);
    if cutoff is null then
      raise exception 'bout % has no dated event; refusing to lock a prediction that cannot be proven pre-fight', new.bout_id
        using errcode = 'restrict_violation';
    end if;
    if now_ts >= cutoff then
      raise exception 'lock window for bout % closed at % (now %)', new.bout_id, cutoff, now_ts
        using errcode = 'restrict_violation',
              hint = 'A pick must be locked before the event UTC date begins. Once that instant passes the pick cannot enter the live record at all.';
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

create or replace function public.ufc_model_predictions_no_delete()
returns trigger
language plpgsql
as $$
begin
  if old.locked_at is not null then
    raise exception 'locked prediction % cannot be deleted', old.id
      using errcode = 'restrict_violation',
            hint = 'A published pick is a permanent record. Grade it; do not remove it.';
  end if;
  return old;
end;
$$;

drop trigger if exists ufc_model_predictions_immutable_trg on public.ufc_model_predictions;
drop trigger if exists ufc_model_predictions_no_delete_trg on public.ufc_model_predictions;
create trigger ufc_model_predictions_no_delete_trg
  before delete on public.ufc_model_predictions
  for each row execute function public.ufc_model_predictions_no_delete();

-- ---- the publishing entry point -----------------------------------------
create or replace function public.ufc_model_publish_prediction(
  p_prediction_id uuid,
  p_min_lead interval default interval '0'
)
returns public.ufc_model_predictions
language plpgsql
as $$
declare
  rec public.ufc_model_predictions;
  cutoff timestamptz;
  now_ts timestamptz := clock_timestamp();
begin
  -- FOR UPDATE so two publishers cannot race the same prediction.
  select * into rec from public.ufc_model_predictions where id = p_prediction_id for update;
  if not found then
    raise exception 'prediction % does not exist', p_prediction_id using errcode = 'no_data_found';
  end if;
  if rec.locked_at is not null then
    raise exception 'prediction % was already locked at %', p_prediction_id, rec.locked_at
      using errcode = 'restrict_violation';
  end if;

  cutoff := public.ufc_model_lock_cutoff(rec.bout_id);
  if cutoff is null then
    raise exception 'bout % has no dated event; refusing to lock', rec.bout_id
      using errcode = 'restrict_violation';
  end if;
  -- p_min_lead lets a publisher demand more margin than the schema's floor,
  -- never less: the trigger re-checks the floor regardless of what is passed.
  if now_ts >= cutoff - greatest(p_min_lead, interval '0') then
    raise exception 'lock window for bout % closed at % with a % lead requirement (now %)',
      rec.bout_id, cutoff, greatest(p_min_lead, interval '0'), now_ts
      using errcode = 'restrict_violation';
  end if;

  perform set_config('pbe.model_publishing', 'on', true);
  update public.ufc_model_predictions
     set locked_at = now_ts   -- discarded and re-stamped by the trigger
   where id = p_prediction_id
  returning * into rec;
  perform set_config('pbe.model_publishing', 'off', true);

  return rec;
end;
$$;

comment on function public.ufc_model_publish_prediction(uuid, interval) is
  'The only supported way to lock a prediction. Serialises on the row, checks the lock window, and lets the trigger stamp the server clock. p_min_lead can demand more margin than the schema floor, never less.';

-- =========================================================================
-- Grades — append-only, revisable, auditable
-- =========================================================================
-- A result is not part of the prediction. It is an assertion about the world,
-- made by a source, at a time, and it can turn out to be wrong: overturned on
-- appeal, changed to a no-contest after a failed test, or simply mis-recorded.
-- Each of those is a new row here, never an edit to an old one.

create table if not exists public.ufc_model_prediction_grades (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.ufc_model_predictions(id) on delete restrict,

  -- Assigned by trigger, starting at 1. The highest revision for a prediction
  -- is the current grade; every earlier one stays readable.
  revision int not null,
  supersedes_grade_id uuid references public.ufc_model_prediction_grades(id),

  -- WIN/LOSS are relative to the prediction's pick. DRAW and NC are the bout's
  -- own outcome. VOID is for a bout that never happened.
  result text not null check (result in ('WIN', 'LOSS', 'DRAW', 'NC', 'VOID')),
  winner_id uuid references public.ufc_fighters(id),
  method text,

  -- Where this assertion came from. A grade with no provenance is a rumour.
  source text not null,
  source_ref text,
  source_captured_at timestamptz,

  revision_reason text,
  graded_by text,
  graded_at timestamptz not null default clock_timestamp(),

  constraint ufc_model_grade_revision_unique unique (prediction_id, revision),
  check (revision >= 1),
  -- A first grade needs no explanation. A correction does, and it has to say
  -- what it replaces.
  check (revision = 1 or revision_reason is not null),
  check (revision = 1 or supersedes_grade_id is not null),
  -- A decided bout names a winner; a draw, no-contest or void does not.
  check ((result in ('WIN', 'LOSS')) = (winner_id is not null))
);

create index if not exists ufc_model_prediction_grades_prediction_idx
  on public.ufc_model_prediction_grades (prediction_id, revision desc);
create index if not exists ufc_model_prediction_grades_graded_idx
  on public.ufc_model_prediction_grades (graded_at desc);

comment on table public.ufc_model_prediction_grades is
  'Append-only grading history. A corrected or overturned result is a new revision superseding the previous one, never an edit. The prediction it grades is untouched.';

create or replace function public.ufc_model_grades_append_only()
returns trigger
language plpgsql
as $$
declare
  pred public.ufc_model_predictions;
  prev public.ufc_model_prediction_grades;
  has_result boolean;
  bout_status text;
  expected_winner uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'grade % cannot be edited; append a new revision instead', old.id
      using errcode = 'restrict_violation',
            hint = 'insert a row with a revision_reason; it supersedes this one and this one stays readable.';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'grade % cannot be deleted; the grading history is the audit trail', old.id
      using errcode = 'restrict_violation';
  end if;

  select * into pred from public.ufc_model_predictions where id = new.prediction_id for update;
  if not found then
    raise exception 'prediction % does not exist', new.prediction_id using errcode = 'no_data_found';
  end if;
  if pred.locked_at is null then
    raise exception 'prediction % was never locked and cannot be graded', new.prediction_id
      using errcode = 'restrict_violation',
            hint = 'An unlocked draft is not part of the record. Publish it before the fight or discard it.';
  end if;

  -- Grading is gated on the fight having actually resolved, which is a fact
  -- about the data rather than about the clock: a stored result exists, or the
  -- bout was cancelled. Using elapsed time instead would let a grade be written
  -- while the fight was still in progress.
  select exists (select 1 from public.ufc_bout_results r where r.bout_id = pred.bout_id) into has_result;
  select b.status into bout_status from public.ufc_bouts b where b.id = pred.bout_id;
  if not has_result and coalesce(bout_status, '') not in ('cancelled', 'replaced') then
    raise exception 'bout % has no stored result and is not cancelled; nothing to grade yet', pred.bout_id
      using errcode = 'restrict_violation';
  end if;
  if new.result = 'VOID' and has_result then
    raise exception 'bout % has a stored result and cannot be graded VOID', pred.bout_id
      using errcode = 'check_violation';
  end if;

  -- A grade may not name the loser as the winner. Cheap to check, and it is
  -- the one inconsistency that would silently invert the whole record.
  if new.result in ('WIN', 'LOSS') then
    expected_winner := case when new.result = 'WIN'
      then pred.pick_fighter_id
      else case when pred.pick_fighter_id = pred.fighter_a_id then pred.fighter_b_id else pred.fighter_a_id end
    end;
    if new.winner_id <> expected_winner then
      raise exception 'grade says % but names % as the winner; the pick was %',
        new.result, new.winner_id, pred.pick_fighter_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Revision, lineage and time are all assigned here. Anything the caller
  -- supplied for them is discarded: a grading history that the grader can
  -- renumber is not a history.
  select * into prev
    from public.ufc_model_prediction_grades
   where prediction_id = new.prediction_id
   order by revision desc
   limit 1;

  new.revision := coalesce(prev.revision, 0) + 1;
  new.supersedes_grade_id := prev.id;
  new.graded_at := clock_timestamp();

  if new.revision > 1 and coalesce(btrim(new.revision_reason), '') = '' then
    raise exception 'revision % of prediction % must state why it supersedes revision %',
      new.revision, new.prediction_id, prev.revision
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ufc_model_grades_append_only_trg on public.ufc_model_prediction_grades;
create trigger ufc_model_grades_append_only_trg
  before insert or update or delete on public.ufc_model_prediction_grades
  for each row execute function public.ufc_model_grades_append_only();

-- The grade in force. Everything the tracker reads goes through this.
create or replace view public.ufc_model_prediction_current_grade as
select distinct on (g.prediction_id)
  g.prediction_id,
  g.id as grade_id,
  g.revision,
  g.result,
  g.winner_id,
  g.method,
  g.source,
  g.source_ref,
  g.revision_reason,
  g.graded_by,
  g.graded_at,
  g.supersedes_grade_id
from public.ufc_model_prediction_grades g
order by g.prediction_id, g.revision desc;

comment on view public.ufc_model_prediction_current_grade is
  'The current revision of each prediction grade. Superseded revisions remain in ufc_model_prediction_grades and are never deleted.';

-- =========================================================================
-- BACKTEST records — separate tables, never joined to the live ones
-- =========================================================================

create table if not exists public.ufc_model_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  record_class text not null default 'BACKTEST' check (record_class = 'BACKTEST'),
  model_version text not null,
  feature_version text not null,
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
-- Two sources, no union anywhere. Both emit record_class so a consumer that
-- stitches them together downstream still has to show which is which.

create or replace view public.ufc_model_live_record as
select
  p.model_version,
  p.feature_version,
  'LIVE'::text as record_class,
  count(*) filter (where p.locked_at is not null) as locked_predictions,
  count(*) filter (where p.locked_at is not null and g.result is null) as pending,
  count(*) filter (where g.result = 'WIN') as wins,
  count(*) filter (where g.result = 'LOSS') as losses,
  count(*) filter (where g.result in ('DRAW', 'NC', 'VOID')) as no_decision,
  count(*) filter (where g.result in ('WIN', 'LOSS')) as decided,
  -- NULL rather than zero when nothing has been graded. A hit rate of 0% and
  -- "no fights yet" are different statements and the UI must tell them apart.
  case when count(*) filter (where g.result in ('WIN', 'LOSS')) > 0
    then count(*) filter (where g.result = 'WIN')::numeric / count(*) filter (where g.result in ('WIN', 'LOSS'))
  end as hit_rate,
  count(*) filter (where g.result = 'WIN' and p.pick_probability >= 0.65) as high_conf_wins,
  count(*) filter (where g.result = 'LOSS' and p.pick_probability >= 0.65) as high_conf_losses,
  case when count(*) filter (where g.result in ('WIN', 'LOSS')) > 0
    then avg(power(p.pick_probability - (case when g.result = 'WIN' then 1 else 0 end), 2))
         filter (where g.result in ('WIN', 'LOSS'))
  end as brier,
  case when count(*) filter (where g.result in ('WIN', 'LOSS')) > 0
    then avg(p.pick_probability) filter (where g.result in ('WIN', 'LOSS'))
  end as mean_confidence,
  count(*) filter (where p.model_edge_pts is not null) as market_compared,
  avg(p.model_edge_pts) filter (where p.model_edge_pts is not null) as mean_edge_pts,
  -- Corrections are part of the record's integrity, so the tracker can say how
  -- many results have been revised rather than quietly restating them.
  count(*) filter (where g.revision > 1) as revised_grades,
  min(p.locked_at) as first_locked_at,
  max(p.locked_at) as last_locked_at
from public.ufc_model_predictions p
left join public.ufc_model_prediction_current_grade g on g.prediction_id = p.id
where p.locked_at is not null
group by p.model_version, p.feature_version;

comment on view public.ufc_model_live_record is
  'The published record: locked picks only, graded by the current revision of each grade. Empty until the first pick is locked, and it stays empty rather than showing a placeholder.';

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
  select p.model_version, p.feature_version, p.pick_probability, g.result,
         row_number() over (partition by p.model_version, p.feature_version order by g.graded_at desc, p.id) as rn
    from public.ufc_model_predictions p
    join public.ufc_model_prediction_current_grade g on g.prediction_id = p.id
   where p.locked_at is not null and g.result in ('WIN', 'LOSS')
) ranked
where rn <= 30
group by model_version, feature_version;

create or replace view public.ufc_model_live_calibration as
select
  p.model_version,
  p.feature_version,
  'LIVE'::text as record_class,
  p.confidence_band,
  count(*) as decided,
  count(*) filter (where g.result = 'WIN') as wins,
  count(*) filter (where g.result = 'WIN')::numeric / nullif(count(*), 0) as observed,
  avg(p.pick_probability) as predicted
from public.ufc_model_predictions p
join public.ufc_model_prediction_current_grade g on g.prediction_id = p.id
where p.locked_at is not null and g.result in ('WIN', 'LOSS')
group by p.model_version, p.feature_version, p.confidence_band;

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
alter table public.ufc_model_prediction_grades enable row level security;
alter table public.ufc_model_backtest_runs enable row level security;
alter table public.ufc_model_backtest_predictions enable row level security;

commit;
