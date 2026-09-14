-- PBE Algo production runtime: run ledger, per-bout eligibility log, VOID for
-- vanished bouts, result-bound grading, and TRUNCATE hardening.
--
-- Additive, with one strictly tightening change to the grade trigger. Creates
-- no model version, no prediction and no grade.

begin;

-- ---------------------------------------------------------------------------
-- 1. Run ledger for the Cloudflare scheduler (ufc-algo). One row per cycle.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  trigger text not null check (trigger in ('cron', 'admin')),
  mode text not null check (mode in ('dry_run', 'armed')),
  worker_version text,
  model_version text,
  feature_version text,
  eligibility_version text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed', 'blocked')),
  counts jsonb not null default '{}'::jsonb,
  error text
);
create index if not exists ufc_model_runs_started_idx on public.ufc_model_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- 2. Eligibility log. Every bout on every evaluated card gets a row per run:
--    ELIGIBLE with the dry-run/draft score, or NO_MODEL_CALL with its exact
--    reason codes. Append-only, so "why was there no call" is auditable and the
--    regeneration drift behind the elite gate is measurable.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_bout_evaluations (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.ufc_model_runs(id) on delete restrict,
  evaluated_at timestamptz not null default clock_timestamp(),
  event_id uuid not null references public.ufc_events(id) on delete restrict,
  bout_id uuid not null references public.ufc_bouts(id) on delete restrict,
  fighter_a_id uuid references public.ufc_fighters(id) on delete restrict,
  fighter_b_id uuid references public.ufc_fighters(id) on delete restrict,
  model_version text not null,
  feature_version text not null,
  eligibility_version text not null,
  decision text not null check (decision in ('ELIGIBLE', 'NO_MODEL_CALL')),
  reasons text[] not null default '{}',
  confidence text check (confidence in ('LEAN', 'MEDIUM', 'HIGH')),
  elite_candidate boolean not null default false,
  pick_fighter_id uuid references public.ufc_fighters(id) on delete restrict,
  pick_probability numeric(9, 8) check (pick_probability is null or (pick_probability >= 0.5 and pick_probability < 1)),
  features_available int check (features_available between 0 and 64),
  sample jsonb not null default '{}'::jsonb,
  identity jsonb not null default '{}'::jsonb,
  market jsonb,
  -- An ineligible bout has no call, not a hidden one.
  check (
    (decision = 'ELIGIBLE' and pick_fighter_id is not null and pick_probability is not null and confidence is not null)
    or (decision = 'NO_MODEL_CALL' and pick_fighter_id is null and pick_probability is null and confidence is null and elite_candidate = false)
  ),
  check (decision = 'ELIGIBLE' or cardinality(reasons) > 0)
);
create index if not exists ufc_model_bout_evaluations_bout_idx on public.ufc_model_bout_evaluations (bout_id, evaluated_at desc);
create index if not exists ufc_model_bout_evaluations_event_idx on public.ufc_model_bout_evaluations (event_id, evaluated_at desc);

create or replace function public.ufc_model_bout_evaluations_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'ufc_model_bout_evaluations is append-only' using errcode = 'restrict_violation';
end;
$$;
drop trigger if exists ufc_model_bout_evaluations_append_only_trg on public.ufc_model_bout_evaluations;
create trigger ufc_model_bout_evaluations_append_only_trg
  before update or delete on public.ufc_model_bout_evaluations
  for each row execute function public.ufc_model_bout_evaluations_append_only();

-- The latest decision per bout.
create or replace view public.ufc_model_card_current
with (security_invoker = true) as
select distinct on (e.bout_id) e.*
  from public.ufc_model_bout_evaluations e
 order by e.bout_id, e.evaluated_at desc, e.id desc;

-- ---------------------------------------------------------------------------
-- 3. Grading: bound to the stored result, and VOID for a vanished bout.
--
-- Stricter than 011: a WIN/LOSS must name the winner the stored result names,
-- a DRAW/NC must match the stored method. VOID remains impossible when a
-- result exists. New: a bout with no result that silently left the card (the
-- ingest keeps it 'announced' and logs AnnouncedBoutVanished) may be graded
-- VOID once its event is complete, so a locked pick can never stay pending
-- forever. Nothing else about the append-only history changes.
-- ---------------------------------------------------------------------------
create or replace function public.ufc_model_grades_append_only()
returns trigger
language plpgsql
as $$
declare
  pred public.ufc_model_predictions;
  prev public.ufc_model_prediction_grades;
  res record;
  has_result boolean;
  bout_status text;
  event_complete boolean;
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

  select r.winner_id, r.method into res from public.ufc_bout_results r where r.bout_id = pred.bout_id;
  has_result := found;
  select b.status, coalesce(ev.card_status = 'complete', false)
    into bout_status, event_complete
    from public.ufc_bouts b left join public.ufc_events ev on ev.id = b.event_id
   where b.id = pred.bout_id;

  if not has_result then
    if coalesce(bout_status, '') not in ('cancelled', 'replaced') and not event_complete then
      raise exception 'bout % has no stored result, is not cancelled and its event is not complete; nothing to grade yet', pred.bout_id
        using errcode = 'restrict_violation';
    end if;
    if new.result <> 'VOID' then
      raise exception 'bout % has no stored result; only VOID can be recorded', pred.bout_id
        using errcode = 'check_violation';
    end if;
  else
    if new.result = 'VOID' then
      raise exception 'bout % has a stored result and cannot be graded VOID', pred.bout_id
        using errcode = 'check_violation';
    end if;
    if new.result in ('WIN', 'LOSS') and (res.winner_id is null or new.winner_id is distinct from res.winner_id) then
      raise exception 'grade names winner % but the stored result names %', new.winner_id, res.winner_id
        using errcode = 'check_violation';
    end if;
    if new.result = 'DRAW' and coalesce(res.method, '') <> 'DRAW' then
      raise exception 'grade says DRAW but the stored result method is %', res.method using errcode = 'check_violation';
    end if;
    if new.result = 'NC' and coalesce(res.method, '') <> 'NC' then
      raise exception 'grade says NC but the stored result method is %', res.method using errcode = 'check_violation';
    end if;
  end if;

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

-- ---------------------------------------------------------------------------
-- 4. Privileges. No role needs TRUNCATE on the record; row triggers do not
--    fire on TRUNCATE, so leaving it granted would bypass every guarantee.
-- ---------------------------------------------------------------------------
revoke truncate on table public.ufc_model_versions, public.ufc_model_predictions, public.ufc_model_prediction_grades,
  public.ufc_model_runs, public.ufc_model_bout_evaluations from service_role, anon, authenticated;
revoke all on table public.ufc_model_runs, public.ufc_model_bout_evaluations from anon, authenticated;
revoke all on public.ufc_model_card_current from anon, authenticated;
grant select, insert, update on table public.ufc_model_runs to service_role;
grant select, insert on table public.ufc_model_bout_evaluations to service_role;
grant usage, select on sequence public.ufc_model_bout_evaluations_id_seq to service_role;
grant select on public.ufc_model_card_current to service_role;
alter table public.ufc_model_runs enable row level security;
alter table public.ufc_model_bout_evaluations enable row level security;

commit;
