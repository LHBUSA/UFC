-- Rollback for 20260909180000_ufc_news_pipeline.sql.
--
-- Kept as a file rather than as a paragraph in a runbook because a rollback
-- nobody has read is not a rollback. Prove it the same way the forward
-- migration was proven:
--
--   pwsh scripts/db/probe.ps1 -File supabase/migrations/rollback/20260909180000_ufc_news_pipeline.down.sql
--     -> executes inside BEGIN ... ROLLBACK, so it is a real parse-plan-execute
--        against the live schema with no side effects
--
--   pwsh scripts/db/apply_supabase_migration.ps1 -Mode apply
--     -Paths "supabase/migrations/rollback/20260909180000_ufc_news_pipeline.down.sql"
--
-- WHAT THIS RESTORES, AND WHAT IT CANNOT
--
-- The schema is fully reversible: every column, index, constraint and the one
-- table this migration created are dropped here, and nothing it created is
-- referenced by any deployed Worker, the API or the website.
--
-- Two backfilled values are NOT restorable and are deliberately not attempted:
--
--   ufc_news_items.detected_at  and  ufc_articles.first_published_at
--
-- Both were written into columns that did not exist before, so dropping the
-- column discards them completely and cleanly - there is no prior value to put
-- back. That is the whole reason the backfill was confined to new columns: the
-- forward migration never overwrote a value that existed beforehand, so
-- "undo" is "drop", with no data loss outside this migration's own footprint.
--
-- ufc_news_pipeline_events rows ARE lost. That is intended: they are telemetry
-- about a pipeline that, if this file is being run, is not shipping.

begin;

drop table if exists public.ufc_news_pipeline_events;

drop index if exists public.ufc_articles_news_item_uniq;
drop index if exists public.ufc_articles_topic_sig_idx;
drop index if exists public.ufc_articles_primary_fighter_idx;
drop index if exists public.ufc_articles_source_body_hash_idx;
drop index if exists public.ufc_news_items_pipeline_idx;
drop index if exists public.ufc_news_items_state_idx;
drop index if exists public.ufc_news_items_topic_sig_idx;
drop index if exists public.ufc_news_items_primary_fighter_idx;
drop index if exists public.ufc_news_items_source_body_hash_idx;

alter table public.ufc_news_items
  drop constraint if exists ufc_news_items_state_check,
  drop constraint if exists ufc_news_items_relevance_check,
  drop constraint if exists ufc_news_items_fetch_status_check;

alter table public.ufc_articles
  drop column if exists news_item_id,
  drop column if exists relevance_score,
  drop column if exists primary_fighter_id,
  drop column if exists topic_signature,
  drop column if exists source_body_hash,
  drop column if exists validation,
  drop column if exists hold_reason,
  drop column if exists canonical_article_id,
  drop column if exists superseded_by,
  drop column if exists update_count,
  drop column if exists first_published_at;

alter table public.ufc_news_items
  drop column if exists state,
  drop column if exists state_reason,
  drop column if exists state_changed_at,
  drop column if exists relevance_score,
  drop column if exists relevance_reason,
  drop column if exists story_kind,
  drop column if exists primary_fighter_id,
  drop column if exists secondary_fighter_ids,
  drop column if exists mentioned_fighter_ids,
  drop column if exists entity_confidence,
  drop column if exists source_fetch_status,
  drop column if exists source_body,
  drop column if exists source_body_hash,
  drop column if exists source_image_url,
  drop column if exists source_published_at,
  drop column if exists source_fetched_at,
  drop column if exists topic_signature,
  drop column if exists canonical_article_id,
  drop column if exists article_id,
  drop column if exists detected_at,
  drop column if exists first_published_at,
  drop column if exists attempts,
  drop column if exists last_attempt_at,
  drop column if exists lease_token,
  drop column if exists lease_expires_at;

commit;
