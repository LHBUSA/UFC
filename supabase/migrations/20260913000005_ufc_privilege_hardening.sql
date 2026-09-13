-- Privilege hygiene: remove anon/authenticated write grants on the ufc_* tables.
--
-- NOT YET APPLIED. Proofed with BEGIN ... ROLLBACK; apply only after review.
--
-- =========================================================================
-- WHAT WAS FOUND
-- =========================================================================
--
--   51 ufc_* tables, RLS enabled on ALL of them, and ZERO policies anywhere.
--   35 of those tables carry INSERT / UPDATE / DELETE / TRUNCATE for BOTH
--   `anon` and `authenticated`.
--
-- RLS with no policies denies everything to those roles, so this is hygiene
-- rather than an open door: the grants are unreachable. They are still worth
-- removing, because the day someone adds a permissive policy for one read use
-- case, a latent TRUNCATE grant becomes reachable in the same motion. Defence
-- in depth means the privilege should not be sitting there waiting.
--
-- =========================================================================
-- WHY REVOKING THE TABLES ALONE WOULD NOT FIX IT
-- =========================================================================
--
-- The grants were never written by hand. Supabase ships ALTER DEFAULT
-- PRIVILEGES in `public` granting arwdDxtm -- every privilege, including
-- DELETE and TRUNCATE -- to anon and authenticated on every table created in
-- the schema.
--
-- This migration's own recent neighbours prove it: ufc_market_state_transitions
-- and ufc_market_run_quotes were created days ago with no GRANT statement
-- anywhere, and both arrived carrying the full set. Revoking today without
-- changing the default would leave the next migration to reintroduce it
-- silently, and the audit would have to be repeated forever.
--
-- So both halves are here: revoke what exists, and stop the default from
-- minting more.
--
-- =========================================================================
-- WHAT DEPENDS ON THESE GRANTS
-- =========================================================================
--
-- Nothing. Every reader and writer in the product uses the service role, which
-- bypasses RLS and holds its own grants: web/lib/db.ts, every Worker, and the
-- public API. The only anon-key consumers in the repository are the three
-- scripts/*/verify-view-security.mjs checks, which use anon deliberately to
-- PROVE that RLS denies access -- they read and expect refusal, and none of
-- them writes.
--
-- service_role is untouched here, so no production path changes.
--
-- Reversible: the grants can be restored with the mirror of these statements.
-- =========================================================================

begin;

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'ufc_%'
  loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t.relname);
  end loop;
end
$$;

-- Stop the schema default from minting the same grants on the next table.
-- SELECT and REFERENCES are left alone: read access is still governed by RLS,
-- and narrowing it here would be a different decision with different blast
-- radius than the one this migration is making.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;

commit;
