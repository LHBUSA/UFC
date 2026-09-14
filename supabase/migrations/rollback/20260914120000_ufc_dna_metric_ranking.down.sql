-- Rollback for 20260914120000_ufc_dna_metric_ranking.sql.
--
-- ORDER MATTERS: roll the ufc-api Worker back to the previous version FIRST. The
-- new Worker calls this function; if it is dropped while that Worker is live,
-- PostgREST answers 404 and the Worker returns 503 dna_not_available for every
-- /v1/ufc/dna/query. The previous Worker does not use the function, so dropping it
-- afterwards is safe (and optional).

begin;
drop function if exists public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int);
commit;
