-- 036: PBE Fight Model V2 research SHADOW track (owner-approved 2026-10-07).
--
-- Additive only. The existing challenger shadow infrastructure is reused:
--   * ufc_model_training_runs accepts one more status, RESEARCH_SHADOW: the
--     registration row of a frozen research candidate. No learning, review or
--     promotion code selects it (they filter CHALLENGER / DATA_REPAIR_DRIFT), the
--     immutability trigger already makes the row permanent, and it carries full
--     provenance by constraint.
--   * ufc_model_shadow_predictions gains a nullable `policy` jsonb: the frozen
--     V1/V2 probability pair and the three publication-policy decisions recorded
--     on each V2 shadow row. Locked rows stay immutable through the existing guard.
-- No grant changes: both tables stay service-role only (RLS on, anon revoked).

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.ufc_model_training_runs'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%NO_NEW_TRAINING_DATA%' and pg_get_constraintdef(oid) like '%CHALLENGER%'
     and pg_get_constraintdef(oid) not like '%dataset_sha256%';
  if c is null then raise exception 'training run status constraint not found'; end if;
  execute format('alter table public.ufc_model_training_runs drop constraint %I', c);
end $$;

alter table public.ufc_model_training_runs
  add constraint ufc_model_training_runs_status_check
  check (status in ('NO_NEW_TRAINING_DATA', 'WAITING_FOR_DATA', 'FAILED_AUDIT', 'DATA_REPAIR_DRIFT', 'CHALLENGER', 'FAILED', 'RESEARCH_SHADOW'));

-- A research shadow is registered only with its full frozen provenance.
alter table public.ufc_model_training_runs
  add constraint ufc_model_training_runs_research_shadow_provenance
  check (status <> 'RESEARCH_SHADOW' or (dataset_sha256 is not null and dataset_uri is not null and spec_sha256 is not null
    and coefficients is not null and feature_scale is not null and hyperparameters is not null and training_bouts is not null));

alter table public.ufc_model_shadow_predictions add column if not exists policy jsonb;

comment on column public.ufc_model_shadow_predictions.policy is
  'Research shadow only (RESEARCH_SHADOW runs): frozen V1 and V2 probabilities and the V1 >=55%, V2 >=60% and tier-variant publication decisions, recorded at the same lock pass. Never public.';
