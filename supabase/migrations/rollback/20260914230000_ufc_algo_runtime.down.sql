-- Rollback for 20260914230000_ufc_algo_runtime.sql (only while ufc_model_runs / ufc_model_bout_evaluations hold no rows
-- anyone relies on, and after the ufc-algo Worker is stopped). Restores the 011 grade trigger by re-running its definition.
begin;
drop view if exists public.ufc_model_card_current;
drop table if exists public.ufc_model_bout_evaluations;
drop table if exists public.ufc_model_runs;
-- then re-apply the ufc_model_grades_append_only() body from migrations/011_ufc_model_predictions.sql
commit;
