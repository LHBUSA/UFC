-- Referee view security repair
-- Project: tkmlnhmylqnttmnsnief
--
-- Closes a live RLS bypass on the three referee views created by migration
-- 20260907000008. Additive and non-destructive: no referee data is read,
-- written, moved or recomputed, and migration 008 is not edited.
--
-- Provisional version 000014, chosen to sit clear of the candidate branches
-- currently holding 000010 (model), 000011 (injuries), 000012 (judges) and
-- 000013 (weigh-ins). Renumber before merge if that ordering changes.
--
-- =========================================================================
-- THE FINDING
-- =========================================================================
--
-- Measured on production before writing this file:
--
--   relation                anon      service_role
--   ufc_bout_results        0 rows    1 row
--   ufc_bouts               0 rows    1 row
--   ufc_events              0 rows    1 row
--   ufc_fighters            0 rows    1 row
--   ufc_referee_profiles    0 rows    1 row
--   ufc_referee_aliases     0 rows    1 row
--   ufc_referee_stats       1 ROW     1 row      <-- bypass
--   ufc_referee_directory   1 ROW     1 row      <-- bypass
--   ufc_referee_bouts       1 ROW     1 row      <-- bypass
--
-- Every base table denies anon. Every view over those same tables hands anon
-- rows anyway. The mechanism is not a missing policy; it is the default a view
-- is created with.
--
-- A Postgres view executes as its OWNER unless it declares
-- `security_invoker = true`. All three referee views are owned by `postgres`,
-- and on this project `postgres` holds BYPASSRLS (confirmed: rolbypassrls = t).
-- So each view evaluates the base tables' row security as a role exempt from
-- it, and returns everything. `reloptions` on all three is NULL: none of them
-- opted out of that default.
--
-- The result is a schema that looks correct from the dashboard - RLS enabled on
-- every base table, zero policies, nothing public - while three views quietly
-- re-export the whole archive to anyone holding the public anon key.
--
-- Separately, and worse than it first appears, anon and authenticated hold the
-- full Supabase default grant on all five referee relations:
--
--   DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- RLS covers the row-level ones. It does NOT cover TRUNCATE, REFERENCES or
-- TRIGGER, which are table privileges and are unaffected by row security. A
-- role holding TRUNCATE on an RLS-protected table can still empty it. Nothing
-- in the product exposes a TRUNCATE path today - PostgREST offers none - but a
-- privilege that only fails to be exploitable because of the client in front of
-- it is not a control, and it is removed here.
--
-- =========================================================================
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT
-- =========================================================================
--
-- 1. ALTER VIEW ... SET (security_invoker = true) on all three views.
--
--    ALTER rather than CREATE OR REPLACE, and the reason is exactness. The
--    requirement is that the SELECT definitions and columns do not change.
--    Re-typing three view bodies - one of them a 3,563-character CTE with two
--    aggregate layers and a cross join - and hoping the result is identical is
--    a worse way to guarantee that than not touching them at all. ALTER sets a
--    storage option and leaves pg_get_viewdef byte-identical by construction.
--
--    Verified before and after by md5 of pg_get_viewdef(oid, true):
--      ufc_referee_stats      e9285fb51559aa89e05e11569b1db99e  (3563 bytes)
--      ufc_referee_directory  2b8120be99e725e601a2106e32394728  ( 742 bytes)
--      ufc_referee_bouts      44ec864704faf24addcd799d3d185d96  (1225 bytes)
--
--    ufc_referee_directory selects from ufc_referee_stats, so both need the
--    flag: a security_invoker view reading a non-invoker view would still
--    resolve the inner one as its owner. The order below is inner-first for
--    readability only; ALTER takes no dependency on it.
--
-- 2. Revokes the six non-SELECT privileges from anon and authenticated on the
--    three views AND on the two referee base tables. The base tables are
--    included because TRUNCATE is the privilege RLS does not reach, and
--    revoking it on the views while leaving it on the tables would fix the
--    smaller half of the same mistake.
--
-- 3. Revokes SELECT from anon and authenticated, and grants it to service_role.
--
--    This is a decision, so here is the evidence behind it. Every read path to
--    these three views in the repository was checked:
--
--      web/lib/referees.ts            "server-only", SUPABASE_SERVICE_ROLE_KEY
--      workers/ufc-api/src/index.js   SUPABASE_SERVICE_ROLE_KEY (secret)
--      scripts/referees/*.mjs         SUPABASE_SERVICE_ROLE_KEY
--      scripts/backfill/window_summary.mjs   SUPABASE_SERVICE_ROLE_KEY
--
--    There is no browser-side Supabase client anywhere in web/, no
--    NEXT_PUBLIC_SUPABASE_* variable, and no anon-key read of a referee
--    relation outside the two security verifiers whose purpose is to prove anon
--    gets nothing. Public referee pages render server-side and are unaffected.
--
--    security_invoker alone would already reduce anon to zero rows. Revoking
--    SELECT means anon is refused at the door instead of being handed an empty
--    array, which is both cheaper and easier to reason about: a future policy
--    added to a base table for some unrelated reason cannot silently reopen a
--    read path nothing uses.
--
-- 4. Introduces no SECURITY DEFINER function. That would reintroduce the exact
--    escalation being closed, in a form that is harder to notice.
--
-- 5. Touches no referee row. No INSERT, UPDATE, DELETE, no recomputation. The
--    stats views are derived, so their numbers are a function of the base
--    tables alone and cannot move as a result of a privilege change. Measured
--    before, and asserted unchanged after, by the verifier:
--
--      246 referees, 9,318 refereed bouts, 4,934 stoppages, 4,221 decisions,
--      464 title bouts, archive stoppage rate 53.0%, decision rate 45.3%
--      stats fingerprint fe63694e4c6dbded2d7aea85ab2cabd4
--
-- A PREREQUISITE THIS CREATES, STATED BECAUSE IT IS EASY TO MISS
--
-- security_invoker changes who resolves the BASE tables, not just the view. The
-- reading role stops inheriting the owner's access and needs SELECT on
-- ufc_bout_results, ufc_bouts, ufc_events and ufc_fighters in its own right.
-- service_role holds the full default on all four (verified live before writing
-- this), so the server read path is unaffected. It is checked again by
-- scripts/referees/verify-view-security.mjs, because if that ever stopped being
-- true this migration would take the public referee pages down with it, and the
-- symptom would be an empty page rather than an error.
--
-- WHAT THIS DOES NOT FIX
--
-- The default grant is a property of the schema, not of these views: any view
-- created in `public` from now on gets the same seven privileges for anon and
-- authenticated, and the same owner-executes default. This migration does not
-- touch ALTER DEFAULT PRIVILEGES, because doing so would silently change the
-- behaviour of every other migration in flight. The durable fix is that each
-- new view declares security_invoker and revokes its own grants, which the
-- judge and injury migrations already do.

begin;

-- ---------------------------------------------------------------------------
-- 1. Execute as the caller, not as the owner.
-- ---------------------------------------------------------------------------
alter view public.ufc_referee_stats     set (security_invoker = true);
alter view public.ufc_referee_directory set (security_invoker = true);
alter view public.ufc_referee_bouts     set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 2. No write path for the public roles, on the views or the tables behind them.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_referee_stats     from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_referee_directory from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_referee_bouts     from anon, authenticated;

-- TRUNCATE is the one RLS never covered. These two tables were relying on row
-- security for protection it does not provide.
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_referee_profiles  from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_referee_aliases   from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reads are server-side. Say so in the grants.
-- ---------------------------------------------------------------------------
revoke select on public.ufc_referee_stats     from anon, authenticated;
revoke select on public.ufc_referee_directory from anon, authenticated;
revoke select on public.ufc_referee_bouts     from anon, authenticated;

revoke select on public.ufc_referee_profiles  from anon, authenticated;
revoke select on public.ufc_referee_aliases   from anon, authenticated;

-- Explicit rather than assumed. service_role already holds these by default;
-- stating them means the server read path survives a future tightening of the
-- defaults, and it documents that this layer is service-role-only on purpose.
grant select on public.ufc_referee_stats     to service_role;
grant select on public.ufc_referee_directory to service_role;
grant select on public.ufc_referee_bouts     to service_role;
grant select on public.ufc_referee_profiles  to service_role;
grant select on public.ufc_referee_aliases   to service_role;

-- ---------------------------------------------------------------------------
-- 4. Record the decision where the next reader of the schema will find it.
-- ---------------------------------------------------------------------------
comment on view public.ufc_referee_stats is
  'Historical referee sample from stored UFC results. Rates describe observed bouts and must not be presented as causal referee effects. security_invoker = true: executes as the caller, so base-table RLS applies. Server-read only (service_role).';
comment on view public.ufc_referee_directory is
  'Referee statistics joined to sourced profile enrichment. security_invoker = true: executes as the caller, so base-table RLS applies. Server-read only (service_role).';
comment on view public.ufc_referee_bouts is
  'Normalized referee-to-bout archive with event and fighter context for referee profile pages. security_invoker = true: executes as the caller, so base-table RLS applies. Server-read only (service_role).';

commit;
