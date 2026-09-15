-- Rollback for 20260915200000_ufc_model_prediction_market_refresh. Drops the
-- presentation refresh function; the hourly cycle alone refreshes sample_context.market.
begin;
drop function if exists public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb);
commit;
