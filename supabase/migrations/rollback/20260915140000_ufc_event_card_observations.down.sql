-- Rollback for 20260915140000_ufc_event_card_observations. Drops the D1 card-truth
-- ledger; ufc-algo then evaluates every bout as 'unobserved' (pre-D1 behaviour).
begin;
drop trigger if exists ufc_event_card_observations_append_only_trg on public.ufc_event_card_observations;
drop table if exists public.ufc_event_card_observations;
drop function if exists public.ufc_event_card_observations_append_only();
commit;
