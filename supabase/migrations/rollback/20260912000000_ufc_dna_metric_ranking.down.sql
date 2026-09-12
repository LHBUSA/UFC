-- Rollback for 20260912000000_ufc_dna_metric_ranking.sql.
--
-- Kept as a file rather than as a paragraph in a runbook because a rollback
-- nobody has read is not a rollback. Prove it the same way the forward
-- migration was proven:
--
--   pwsh scripts/db/probe.ps1 -File supabase/migrations/rollback/20260912000000_ufc_dna_metric_ranking.down.sql
--     -> executes inside BEGIN ... ROLLBACK, so it is a real parse-plan-execute
--        against the live schema with no side effects
--
-- ORDER MATTERS. The Worker calls this function; dropping it while the new
-- Worker is live makes /v1/ufc/dna/query answer 503 dna_not_available, because
-- a missing PostgREST function is indistinguishable from a missing schema.
-- Roll the Worker back to the previous Cloudflare version FIRST, then drop.
--
-- The function reads. It creates nothing, owns no data and no other object
-- depends on it, so dropping it loses nothing but the correct ranking: the
-- previous Worker resumes ranking the first 1000 snapshot rows in fighter-UUID
-- order, which is the behaviour issue #27 was filed against.

begin;

drop function if exists public.ufc_dna_metric_ranking(text, int, date, text, numeric, numeric, boolean, text, int, text, int);

commit;

-- PostgREST caches the schema. After dropping, reload it so the route fails
-- predictably instead of intermittently:
--   notify pgrst, 'reload schema';
