-- Rollback for 20260926120000_ufc_training_corner (migrations/032).
-- DESTROYS the training history ledger (observations + change events). Export it first:
--   select * from public.ufc_training_observations; select * from public.ufc_training_change_events;
-- ROLL BACK THE CONSUMERS FIRST: ufc-stats-ingest (association capture), workers/ufc-api (/training),
-- and the web fighter page read these objects; PostgREST answers 404 once they are gone
-- (the readers treat 404 as "no training facts", never as a failure).
begin;
drop view if exists public.ufc_fighter_training_current;
drop view if exists public.ufc_fighter_camp_stints;
drop function if exists public.ufc_training_add_manual(jsonb);
drop function if exists public.ufc_training_record_association(uuid, text, text, text, text, timestamptz);
drop function if exists public.ufc_training_slug(text, text);
drop table if exists public.ufc_training_change_events;
drop table if exists public.ufc_training_observations;
drop table if exists public.ufc_training_camp_aliases;
drop table if exists public.ufc_coaches;
drop table if exists public.ufc_training_camps;
drop function if exists public.ufc_training_events_guard();
drop function if exists public.ufc_training_observations_guard();
drop function if exists public.ufc_training_norm(text);
delete from public.combat_sources where source_key in ('espn_athlete_association', 'ufc_training_manual');
notify pgrst, 'reload schema';
commit;
