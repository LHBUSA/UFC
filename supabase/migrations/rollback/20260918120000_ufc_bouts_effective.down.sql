-- Rollback for 20260918120000_ufc_bouts_effective. The view stores nothing, so this loses no data:
-- ufc_bouts, ufc_event_card_observations and ufc_fighter_status_events are untouched.
-- ROLL BACK THE CONSUMERS FIRST: every reader of ufc_bouts_effective (web/lib/db.ts, workers/ufc-api,
-- workers/ufc-live-odds, ...) answers 404 from PostgREST once the view is gone.
begin;
drop view if exists public.ufc_bouts_effective;
notify pgrst, 'reload schema';
commit;
