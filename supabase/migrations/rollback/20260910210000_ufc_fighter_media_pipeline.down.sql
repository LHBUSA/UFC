-- Rollback for 20260910210000_ufc_fighter_media_pipeline.sql
--
-- Drops only what that migration created. ufc_images and ufc_image_candidates
-- are untouched. Reviewed approvals, rejections and quarantine decisions are
-- lost with the tables: export them first if any review work has been done.
--
--   select * from public.ufc_fighter_media_assets;
--   select * from public.ufc_fighter_media_candidates where status <> 'pending';
--   select * from public.ufc_media_quarantine;
--
-- Deploy the web build that no longer reads ufc_fighter_portrait_eligible
-- BEFORE running this, or every public portrait falls back to the placeholder
-- (the resolver fails closed on a missing relation; it does not error).

begin;

drop view if exists public.ufc_fighter_portrait_eligible;

drop function if exists public.ufc_media_quarantine_asset(uuid, text, text);
drop function if exists public.ufc_media_review_candidate(uuid, text, text, text, boolean);
drop function if exists public.ufc_media_quarantine_image(text, text, uuid, text, text, uuid, uuid);

drop table if exists public.ufc_fighter_media_assets cascade;
drop table if exists public.ufc_fighter_media_candidates cascade;
drop table if exists public.ufc_media_quarantine cascade;

drop function if exists public.ufc_media_quarantine_cascade();
drop function if exists public.ufc_media_asset_quarantine_guard();
drop function if exists public.ufc_media_candidate_quarantine_guard();
drop function if exists public.ufc_media_touch_updated_at();
drop function if exists public.ufc_media_is_quarantined(text, text);

commit;

notify pgrst, 'reload schema';
