-- Rollback for 20260915010000_ufc_algo_learning. Only safe before any training
-- run, shadow prediction or promotion exists: provenance tables are permanent
-- by design, so a populated rollback must be refused rather than forced.
begin;
do $$ begin
  if exists (select 1 from public.ufc_model_training_runs) or exists (select 1 from public.ufc_model_promotion_reviews)
     or exists (select 1 from public.ufc_model_shadow_predictions) then
    raise exception 'refusing rollback: learning provenance rows exist';
  end if;
end $$;
drop function if exists public.ufc_model_promote(uuid, text, text);
drop function if exists public.ufc_model_lock_shadow(uuid, interval);
drop view if exists public.ufc_model_shadow_current_grade;
drop table if exists public.ufc_model_shadow_grades;
drop table if exists public.ufc_model_shadow_predictions;
drop table if exists public.ufc_model_promotion_reviews;
drop table if exists public.ufc_model_training_runs;
drop function if exists public.ufc_model_shadow_grades_guard();
drop function if exists public.ufc_model_shadow_guard();
drop function if exists public.ufc_model_promotion_reviews_guard();
drop function if exists public.ufc_model_training_runs_guard();
drop index if exists public.ufc_model_versions_one_live_per_family;
commit;
