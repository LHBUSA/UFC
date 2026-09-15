-- PBE Algo daily learning, shadow predictions and owner-approved promotion.
-- Design: docs/PBE_ALGO_LEARNING_DESIGN.md (owner-approved 2026-09-15).
--
-- Additive. Creates no model version, no prediction and no grade. The only
-- change to an existing object is a partial unique index guaranteeing exactly
-- one live champion per model family (pbe-fight-model-v1 is currently the only
-- live row).

begin;

-- ---------------------------------------------------------------------------
-- 1. Exactly one production champion per model family.
-- ---------------------------------------------------------------------------
create unique index if not exists ufc_model_versions_one_live_per_family
  on public.ufc_model_versions (model_family) where status = 'live';

-- ---------------------------------------------------------------------------
-- 2. Training runs: immutable provenance for every daily learning attempt.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_training_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  run_date date not null,
  trigger text not null check (trigger in ('cron', 'admin')),
  status text not null check (status in ('NO_NEW_TRAINING_DATA', 'WAITING_FOR_DATA', 'FAILED_AUDIT', 'DATA_REPAIR_DRIFT', 'CHALLENGER', 'FAILED')),
  parent_model_version text not null references public.ufc_model_versions(model_version) on delete restrict,
  parent_run_id uuid references public.ufc_model_training_runs(id) on delete restrict,
  training_cutoff_at timestamptz not null,
  training_window_start date,
  training_window_end date,
  training_bouts int check (training_bouts is null or training_bouts >= 0),
  newly_graded_bouts int check (newly_graded_bouts is null or newly_graded_bouts >= 0),
  dataset_sha256 text,
  dataset_uri text,
  feature_version text not null,
  eligibility_version text not null,
  code_sha text not null,
  worker_version text,
  coefficients jsonb,
  feature_scale jsonb,
  hyperparameters jsonb,
  spec_sha256 text,
  leakage_audit jsonb,
  walk_forward jsonb,
  calibration jsonb,
  sample_quality jsonb,
  coefficient_drift jsonb,
  benchmark_drift jsonb,
  upcoming_drift jsonb,
  gate jsonb not null default '{}'::jsonb,
  error text,
  superseded_at timestamptz,
  -- A challenger is only a challenger with its full provenance.
  check (status <> 'CHALLENGER' or (dataset_sha256 is not null and dataset_uri is not null and spec_sha256 is not null
    and coefficients is not null and feature_scale is not null and hyperparameters is not null
    and leakage_audit is not null and walk_forward is not null and training_bouts is not null)),
  -- Only a run that produced a dataset carries one; a no-data run carries none.
  check (status not in ('NO_NEW_TRAINING_DATA', 'WAITING_FOR_DATA') or (dataset_sha256 is null and coefficients is null))
);

comment on table public.ufc_model_training_runs is
  'Daily PBE Algo learning attempts. Append-only provenance. A CHALLENGER row is never a production model; only ufc_model_promote() can create one, after an owner-approved review.';

-- Identical parent + dataset + code = the same run; a re-run returns the existing row.
create unique index if not exists ufc_model_training_runs_identity
  on public.ufc_model_training_runs (parent_model_version, dataset_sha256, code_sha) where dataset_sha256 is not null;
-- At most one no-dataset outcome per parent per day (NO_NEW_TRAINING_DATA / WAITING_FOR_DATA / FAILED before a dataset).
create unique index if not exists ufc_model_training_runs_daily_nodata
  on public.ufc_model_training_runs (parent_model_version, run_date) where dataset_sha256 is null;
create index if not exists ufc_model_training_runs_created_idx on public.ufc_model_training_runs (created_at desc);

create or replace function public.ufc_model_training_runs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'training run % is permanent provenance and cannot be deleted', old.id using errcode = 'restrict_violation';
  end if;
  -- The only permitted change: a CHALLENGER is marked superseded, once.
  if old.superseded_at is null and new.superseded_at is not null and old.status = 'CHALLENGER'
     and (to_jsonb(new) - 'superseded_at') = (to_jsonb(old) - 'superseded_at') then
    return new;
  end if;
  raise exception 'training run % is immutable', old.id using errcode = 'restrict_violation';
end;
$$;
drop trigger if exists ufc_model_training_runs_guard_trg on public.ufc_model_training_runs;
create trigger ufc_model_training_runs_guard_trg
  before update or delete on public.ufc_model_training_runs
  for each row execute function public.ufc_model_training_runs_guard();

-- ---------------------------------------------------------------------------
-- 3. Shadow predictions: a challenger scoring upcoming bouts, never public,
--    never joined to the official record.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_shadow_predictions (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid not null references public.ufc_model_training_runs(id) on delete restrict,
  challenger_spec_sha256 text not null,
  champion_model_version text not null references public.ufc_model_versions(model_version) on delete restrict,
  bout_id uuid not null references public.ufc_bouts(id) on delete restrict,
  event_id uuid references public.ufc_events(id) on delete restrict,
  fighter_a_id uuid not null references public.ufc_fighters(id) on delete restrict,
  fighter_b_id uuid not null references public.ufc_fighters(id) on delete restrict,
  eligibility_version text not null,
  decision text not null check (decision in ('ELIGIBLE', 'NO_MODEL_CALL')),
  reasons text[] not null default '{}',
  prob_a numeric(9, 8) check (prob_a is null or (prob_a > 0 and prob_a < 1)),
  pick_fighter_id uuid references public.ufc_fighters(id) on delete restrict,
  pick_probability numeric(9, 8) check (pick_probability is null or (pick_probability >= 0.5 and pick_probability < 1)),
  confidence text check (confidence in ('LEAN', 'MEDIUM', 'HIGH')),
  feature_vector jsonb,
  market jsonb,
  generated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  check (fighter_a_id <> fighter_b_id),
  check ((decision = 'ELIGIBLE' and pick_fighter_id is not null and pick_probability is not null and prob_a is not null)
      or (decision = 'NO_MODEL_CALL' and pick_fighter_id is null and pick_probability is null)),
  check (pick_fighter_id is null or pick_fighter_id in (fighter_a_id, fighter_b_id)),
  check (locked_at is null or locked_at >= generated_at),
  constraint ufc_model_shadow_one_per_bout unique (training_run_id, bout_id)
);

comment on table public.ufc_model_shadow_predictions is
  'Challenger shadow calls. Not public, not part of the official PBE Algo record, never alter a champion prediction. Locked through ufc_model_lock_shadow() on the database clock, in the same window as official calls.';

create or replace function public.ufc_model_shadow_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.locked_at is not null then
      raise exception 'shadow prediction % is locked and permanent', old.id using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.locked_at is not null then
      raise exception 'a shadow prediction cannot be inserted locked' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if old.locked_at is not null then
    raise exception 'shadow prediction % was locked at % and cannot change', old.id, old.locked_at using errcode = 'restrict_violation';
  end if;
  if new.locked_at is not null then
    if coalesce(current_setting('pbe.shadow_locking', true), 'off') <> 'on' then
      raise exception 'lock a shadow prediction only through ufc_model_lock_shadow()' using errcode = 'restrict_violation';
    end if;
    new.locked_at := clock_timestamp();
  end if;
  if new.training_run_id is distinct from old.training_run_id or new.bout_id is distinct from old.bout_id
     or new.challenger_spec_sha256 is distinct from old.challenger_spec_sha256 then
    raise exception 'shadow prediction identity cannot change' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists ufc_model_shadow_guard_trg on public.ufc_model_shadow_predictions;
create trigger ufc_model_shadow_guard_trg
  before insert or update or delete on public.ufc_model_shadow_predictions
  for each row execute function public.ufc_model_shadow_guard();

create or replace function public.ufc_model_lock_shadow(p_shadow_id uuid, p_min_lead interval default interval '6 hours')
returns public.ufc_model_shadow_predictions
language plpgsql as $$
declare
  rec public.ufc_model_shadow_predictions;
  cutoff timestamptz;
  now_ts timestamptz := clock_timestamp();
begin
  select * into rec from public.ufc_model_shadow_predictions where id = p_shadow_id for update;
  if not found then raise exception 'shadow prediction % does not exist', p_shadow_id using errcode = 'no_data_found'; end if;
  if rec.locked_at is not null then raise exception 'shadow prediction % already locked', p_shadow_id using errcode = 'restrict_violation'; end if;
  if rec.decision <> 'ELIGIBLE' then raise exception 'only an ELIGIBLE shadow call can lock' using errcode = 'restrict_violation'; end if;
  cutoff := public.ufc_model_lock_cutoff(rec.bout_id);
  if cutoff is null or now_ts >= cutoff - greatest(p_min_lead, interval '0') then
    raise exception 'shadow lock window for bout % is closed', rec.bout_id using errcode = 'restrict_violation';
  end if;
  perform set_config('pbe.shadow_locking', 'on', true);
  update public.ufc_model_shadow_predictions set locked_at = now_ts where id = p_shadow_id returning * into rec;
  perform set_config('pbe.shadow_locking', 'off', true);
  return rec;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Shadow grades: append-only, bound to the stored result, same semantics
--    as the official grades.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_shadow_grades (
  id uuid primary key default gen_random_uuid(),
  shadow_prediction_id uuid not null references public.ufc_model_shadow_predictions(id) on delete restrict,
  revision int not null default 1,
  result text not null check (result in ('WIN', 'LOSS', 'DRAW', 'NC', 'VOID')),
  winner_id uuid references public.ufc_fighters(id) on delete restrict,
  revision_reason text,
  graded_at timestamptz not null default clock_timestamp(),
  unique (shadow_prediction_id, revision)
);

create or replace function public.ufc_model_shadow_grades_guard()
returns trigger language plpgsql as $$
declare
  sp public.ufc_model_shadow_predictions;
  res record;
  has_result boolean;
  bout_status text;
  event_complete boolean;
  prev_rev int;
begin
  if tg_op <> 'INSERT' then
    raise exception 'shadow grades are append-only' using errcode = 'restrict_violation';
  end if;
  select * into sp from public.ufc_model_shadow_predictions where id = new.shadow_prediction_id for update;
  if not found or sp.locked_at is null then
    raise exception 'only a locked shadow prediction can be graded' using errcode = 'restrict_violation';
  end if;
  select r.winner_id, r.method into res from public.ufc_bout_results r where r.bout_id = sp.bout_id;
  has_result := found;
  select b.status, coalesce(ev.card_status = 'complete', false) into bout_status, event_complete
    from public.ufc_bouts b left join public.ufc_events ev on ev.id = b.event_id where b.id = sp.bout_id;
  if not has_result then
    if coalesce(bout_status, '') not in ('cancelled', 'replaced') and not event_complete then
      raise exception 'bout % has no result yet' , sp.bout_id using errcode = 'restrict_violation';
    end if;
    if new.result <> 'VOID' then raise exception 'no stored result: only VOID' using errcode = 'check_violation'; end if;
  else
    if new.result = 'VOID' then raise exception 'a stored result exists: not VOID' using errcode = 'check_violation'; end if;
    if new.result = 'DRAW' and coalesce(res.method, '') <> 'DRAW' then raise exception 'result method is not DRAW' using errcode = 'check_violation'; end if;
    if new.result = 'NC' and coalesce(res.method, '') <> 'NC' then raise exception 'result method is not NC' using errcode = 'check_violation'; end if;
    if new.result in ('WIN', 'LOSS') then
      if res.winner_id is null or new.winner_id is distinct from res.winner_id then
        raise exception 'grade winner does not match the stored result' using errcode = 'check_violation';
      end if;
      if (new.result = 'WIN') <> (res.winner_id = sp.pick_fighter_id) then
        raise exception 'grade % contradicts the shadow pick', new.result using errcode = 'check_violation';
      end if;
    end if;
  end if;
  select max(revision) into prev_rev from public.ufc_model_shadow_grades where shadow_prediction_id = new.shadow_prediction_id;
  new.revision := coalesce(prev_rev, 0) + 1;
  new.graded_at := clock_timestamp();
  if new.revision > 1 and coalesce(btrim(new.revision_reason), '') = '' then
    raise exception 'a shadow grade revision must state why' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists ufc_model_shadow_grades_guard_trg on public.ufc_model_shadow_grades;
create trigger ufc_model_shadow_grades_guard_trg
  before insert or update or delete on public.ufc_model_shadow_grades
  for each row execute function public.ufc_model_shadow_grades_guard();

create or replace view public.ufc_model_shadow_current_grade
with (security_invoker = true) as
select distinct on (g.shadow_prediction_id) g.* from public.ufc_model_shadow_grades g
order by g.shadow_prediction_id, g.revision desc;

-- ---------------------------------------------------------------------------
-- 5. Weekly promotion reviews and the owner decision.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_model_promotion_reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  week_start date not null,
  champion_model_version text not null references public.ufc_model_versions(model_version) on delete restrict,
  challenger_run_id uuid references public.ufc_model_training_runs(id) on delete restrict,
  review_version text not null,
  criteria jsonb not null,
  verdict text not null check (verdict in ('NO_CHALLENGER', 'REJECT', 'HOLD', 'PROPOSE')),
  reasons text[] not null default '{}',
  owner_decision text check (owner_decision in ('APPROVED', 'DECLINED')),
  owner_decided_at timestamptz,
  owner_note text,
  promoted_model_version text references public.ufc_model_versions(model_version) on delete restrict,
  check (owner_decision is null or verdict = 'PROPOSE'),
  check (promoted_model_version is null or owner_decision = 'APPROVED')
);
create unique index if not exists ufc_model_promotion_reviews_weekly
  on public.ufc_model_promotion_reviews (week_start, champion_model_version, coalesce(challenger_run_id, '00000000-0000-0000-0000-000000000000'::uuid));

create or replace function public.ufc_model_promotion_reviews_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'promotion review % is permanent', old.id using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - array['owner_decision', 'owner_decided_at', 'owner_note', 'promoted_model_version'])
     <> (to_jsonb(old) - array['owner_decision', 'owner_decided_at', 'owner_note', 'promoted_model_version']) then
    raise exception 'promotion review % evidence is immutable', old.id using errcode = 'restrict_violation';
  end if;
  if old.owner_decision is not null and new.owner_decision is distinct from old.owner_decision then
    raise exception 'owner decision on review % is already recorded', old.id using errcode = 'restrict_violation';
  end if;
  if old.promoted_model_version is not null and new.promoted_model_version is distinct from old.promoted_model_version then
    raise exception 'review % already promoted %', old.id, old.promoted_model_version using errcode = 'restrict_violation';
  end if;
  if new.promoted_model_version is not null and old.promoted_model_version is null
     and coalesce(current_setting('pbe.model_promoting', true), 'off') <> 'on' then
    raise exception 'promotion only through ufc_model_promote()' using errcode = 'restrict_violation';
  end if;
  if new.owner_decision is not null and old.owner_decision is null then
    new.owner_decided_at := clock_timestamp();
  end if;
  return new;
end;
$$;
drop trigger if exists ufc_model_promotion_reviews_guard_trg on public.ufc_model_promotion_reviews;
create trigger ufc_model_promotion_reviews_guard_trg
  before update or delete on public.ufc_model_promotion_reviews
  for each row execute function public.ufc_model_promotion_reviews_guard();

-- ---------------------------------------------------------------------------
-- 6. Promotion. The ONLY path from challenger to champion. Requires a PROPOSE
--    review that the owner APPROVED, a CHALLENGER run that passed its leakage
--    audit and matches the review, and the champion still being the one the
--    review evaluated. Retires the old champion and inserts the new version in
--    one transaction. Never touches a prediction: locked calls keep their
--    original model_version for ever (011 trigger forbids any change to them).
-- ---------------------------------------------------------------------------
create or replace function public.ufc_model_promote(p_review_id uuid, p_model_version text, p_spec_sha256 text)
returns public.ufc_model_versions
language plpgsql as $$
declare
  rv public.ufc_model_promotion_reviews;
  tr public.ufc_model_training_runs;
  champ public.ufc_model_versions;
  newrow public.ufc_model_versions;
begin
  select * into rv from public.ufc_model_promotion_reviews where id = p_review_id for update;
  if not found then raise exception 'review % not found', p_review_id using errcode = 'no_data_found'; end if;
  if rv.verdict <> 'PROPOSE' then raise exception 'review % verdict is %, not PROPOSE', p_review_id, rv.verdict using errcode = 'restrict_violation'; end if;
  if rv.owner_decision is distinct from 'APPROVED' then raise exception 'review % has no owner approval', p_review_id using errcode = 'restrict_violation'; end if;
  if rv.promoted_model_version is not null then raise exception 'review % already promoted %', p_review_id, rv.promoted_model_version using errcode = 'restrict_violation'; end if;

  select * into tr from public.ufc_model_training_runs where id = rv.challenger_run_id;
  if not found or tr.status <> 'CHALLENGER' then raise exception 'review % does not reference a CHALLENGER run', p_review_id using errcode = 'restrict_violation'; end if;
  if coalesce((tr.leakage_audit->>'all_passed')::boolean, false) is not true then
    raise exception 'challenger % failed or lacks its leakage audit', tr.id using errcode = 'restrict_violation';
  end if;

  select * into champ from public.ufc_model_versions where model_version = rv.champion_model_version for update;
  if champ.status <> 'live' then raise exception 'champion % is no longer live; the review is stale', champ.model_version using errcode = 'restrict_violation'; end if;
  if tr.parent_model_version <> champ.model_version then raise exception 'challenger was trained against %, not the current champion', tr.parent_model_version using errcode = 'restrict_violation'; end if;
  if coalesce(p_model_version, '') = '' or p_model_version = champ.model_version then raise exception 'a new, distinct model_version is required' using errcode = 'check_violation'; end if;

  update public.ufc_model_versions set status = 'retired', retired_at = clock_timestamp() where model_version = champ.model_version;

  insert into public.ufc_model_versions (
    model_version, model_family, feature_version, algorithm, validation, trained_at,
    training_window_start, training_window_end, training_bouts, hyperparameters,
    coefficients, feature_scale, spec_sha256, release_metrics, methodology_ref, status, notes
  ) values (
    p_model_version, champ.model_family, tr.feature_version, champ.algorithm, champ.validation, tr.created_at,
    tr.training_window_start, tr.training_window_end, tr.training_bouts,
    coalesce(tr.hyperparameters, '{}'::jsonb) || jsonb_build_object('provenance', jsonb_build_object(
      'parent_model_version', champ.model_version, 'training_run_id', tr.id, 'dataset_sha256', tr.dataset_sha256,
      'dataset_uri', tr.dataset_uri, 'code_sha', tr.code_sha, 'promotion_review_id', rv.id)),
    tr.coefficients, tr.feature_scale, p_spec_sha256,
    jsonb_build_object('walk_forward', tr.walk_forward, 'calibration', tr.calibration, 'sample_quality', tr.sample_quality,
      'leakage_audit', tr.leakage_audit, 'coefficient_drift', tr.coefficient_drift, 'benchmark_drift', tr.benchmark_drift,
      'promotion_review', rv.criteria),
    champ.methodology_ref, 'live',
    format('Promoted from training run %s by owner-approved review %s; parent %s.', tr.id, rv.id, champ.model_version)
  ) returning * into newrow;

  perform set_config('pbe.model_promoting', 'on', true);
  update public.ufc_model_promotion_reviews set promoted_model_version = p_model_version where id = rv.id;
  perform set_config('pbe.model_promoting', 'off', true);
  return newrow;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges: service_role only; nothing public; no TRUNCATE.
-- ---------------------------------------------------------------------------
alter table public.ufc_model_training_runs enable row level security;
alter table public.ufc_model_shadow_predictions enable row level security;
alter table public.ufc_model_shadow_grades enable row level security;
alter table public.ufc_model_promotion_reviews enable row level security;
revoke all on table public.ufc_model_training_runs, public.ufc_model_shadow_predictions, public.ufc_model_shadow_grades,
  public.ufc_model_promotion_reviews from anon, authenticated;
revoke all on public.ufc_model_shadow_current_grade from anon, authenticated;
revoke truncate on table public.ufc_model_training_runs, public.ufc_model_shadow_predictions, public.ufc_model_shadow_grades,
  public.ufc_model_promotion_reviews from service_role, anon, authenticated;
grant select, insert, update on table public.ufc_model_training_runs to service_role;
grant select, insert, update, delete on table public.ufc_model_shadow_predictions to service_role;
grant select, insert on table public.ufc_model_shadow_grades to service_role;
grant select, insert, update on table public.ufc_model_promotion_reviews to service_role;
grant select on public.ufc_model_shadow_current_grade to service_role;
revoke all on function public.ufc_model_lock_shadow(uuid, interval) from public, anon, authenticated;
revoke all on function public.ufc_model_promote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ufc_model_lock_shadow(uuid, interval) to service_role;
grant execute on function public.ufc_model_promote(uuid, text, text) to service_role;

commit;
