-- Model and store view/table security repair
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive and non-destructive. No model prediction, grade, backtest row,
-- provisioning row or order row is read, written, moved or recomputed. No
-- already-applied migration is edited.
--
-- =========================================================================
-- WHY THIS FILE EXISTS
-- =========================================================================
--
-- Migration 20260908000014 closed this same bypass on the three referee views
-- and ended with a warning about what it was NOT fixing:
--
--   "The default grant is a property of the schema, not of these views: any
--    view created in `public` from now on gets the same seven privileges for
--    anon and authenticated, and the same owner-executes default. ... The
--    durable fix is that each new view declares security_invoker and revokes
--    its own grants, which the judge and injury migrations already do."
--
-- The judge, injury and weigh-in migrations do. The model migration
-- (20260908000010) and the two store migrations (20260907000010,
-- 20260908000015) do not. This was found in the post-apply read-back, not by
-- re-reading the files, which is the point of doing a read-back at all.
--
-- MEASURED ON PRODUCTION AFTER THOSE MIGRATIONS APPLIED
--
--   relation                              reloptions   anon grant
--   ufc_model_prediction_current_grade    (none)       ALL SEVEN
--   ufc_model_live_record                 (none)       ALL SEVEN
--   ufc_model_live_recent                 (none)       ALL SEVEN
--   ufc_model_live_calibration            (none)       ALL SEVEN
--   ufc_model_backtest_record             (none)       ALL SEVEN
--   ufc_model_predictions        (table)  rls on       ALL SEVEN
--   ufc_model_prediction_grades  (table)  rls on       ALL SEVEN
--   ufc_model_versions           (table)  rls on       ALL SEVEN
--   ufc_model_backtest_runs      (table)  rls on       ALL SEVEN
--   ufc_model_backtest_predictions(table) rls on       ALL SEVEN
--   store_provisioning           (table)  rls on       ALL SEVEN
--   store_orders                 (table)  rls on       ALL SEVEN
--   store_order_lines            (table)  rls on       ALL SEVEN
--
-- ALL SEVEN = DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE.
--
-- Compare the relations whose migrations got it right: on
-- ufc_fighter_status_events and ufc_weigh_in_results, service_role is the only
-- grantee in role_table_grants at all.
--
-- WHAT IS AND IS NOT ALREADY CONTAINED
--
-- RLS is enabled on all eight tables and there are ZERO policies on any of
-- them, which denies anon every row-level operation. Two things escape that:
--
--   1. TRUNCATE, REFERENCES and TRIGGER are table privileges. Row security does
--      not apply to them. A role holding TRUNCATE on an RLS-protected table can
--      still empty it. On ufc_model_predictions that privilege is held by anon,
--      and emptying that table would destroy the immutable prediction ledger
--      the whole LIVE RECORD contract rests on - the append-only grade history,
--      the server-clock lock, the refusal to rewrite a locked row all assume
--      the row is still there. The same privilege on store_orders would erase
--      the record of what a real customer paid for.
--
--   2. The five views have no security_invoker, so they execute as their owner,
--      `postgres`, which holds BYPASSRLS on this project. Every one of them
--      reads ufc_model_predictions and its companions as a role exempt from the
--      row security that is the only thing protecting those tables. anon holds
--      SELECT on all five. The deny-all RLS on the base tables is therefore
--      decorative for any column those views expose.
--
-- The views are aggregates and joins, so information_schema reports
-- is_insertable_into = NO and is_updatable = NO on all five: the write half of
-- the grant does not propagate through them to the base tables. That is a
-- property of their shape, not a control, and it is not what is being relied on
-- here.
--
-- READ-PATH EVIDENCE FOR REVOKING SELECT
--
-- Every consumer of these relations in the repository was checked, the same way
-- the referee patch checked its own:
--
--   web/lib/model.ts               SUPABASE_SERVICE_ROLE_KEY   (the /model page)
--   web/lib/store/orders.ts        SUPABASE_SERVICE_ROLE_KEY
--   web/lib/store/provisioning.ts  SUPABASE_SERVICE_ROLE_KEY
--   web/app/api/store/checkout/route.ts   via the two libs above
--   scripts/store/provision.mjs    SUPABASE_SERVICE_ROLE_KEY
--   scripts/model/*.mjs            SUPABASE_SERVICE_ROLE_KEY
--
-- There is no browser-side Supabase client in web/ and no NEXT_PUBLIC_SUPABASE_*
-- variable. The /model tracker renders server-side. Nothing anon-keyed reads a
-- model or store relation. Revoking SELECT from anon changes no rendered page.
--
-- security_invoker alone would already reduce anon to zero rows through the
-- views. SELECT is revoked as well so that anon is refused at the door rather
-- than handed an empty array: when the model does begin publishing, a SELECT
-- policy added to ufc_model_predictions for some future purpose must not
-- silently reopen a public read path through a view nobody re-examined.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It adds no SECURITY DEFINER function, which would reintroduce the escalation
-- being closed in a form that is harder to see. It does not touch ALTER DEFAULT
-- PRIVILEGES, for the reason migration 000014 gave: that would change the
-- behaviour of every migration still in flight. It does not add a public SELECT
-- policy to ufc_model_predictions - whether locked predictions become publicly
-- readable is a product decision about the LIVE RECORD, not a security fix, and
-- it is not smuggled in here.
--
-- VIEW DEFINITIONS ARE NOT REWRITTEN
--
-- ALTER VIEW ... SET, not CREATE OR REPLACE, so pg_get_viewdef stays
-- byte-identical by construction. Measured immediately before this file was
-- written:
--
--   ufc_model_live_record               9a2ae9aeff0393a0c218105e2c5d36dc  (2229 bytes)
--   ufc_model_backtest_record           97288dd8dacf634f6b9b8f4a0c55d422  (1163 bytes)
--   ufc_model_live_recent               428b08ca4bacc21e91dee5831b7d6d6a  (1075 bytes)
--   ufc_model_live_calibration          d15155b8ff242a036f8d73728452a188  ( 593 bytes)
--   ufc_model_prediction_current_grade  943bda94fb1ce93b7f891631b9113e4b  ( 305 bytes)
--
-- ufc_model_live_record, ufc_model_live_recent and ufc_model_live_calibration
-- all read ufc_model_prediction_current_grade, so that view needs the flag too:
-- a security_invoker view reading a non-invoker view would still resolve the
-- inner one as its owner. It is set first below for readability only; ALTER
-- takes no dependency on the order.
--
-- THE PREREQUISITE THIS CREATES
--
-- security_invoker changes who resolves the BASE tables, not only the view. The
-- reading role stops inheriting the owner's access and needs SELECT on
-- ufc_model_predictions, ufc_model_prediction_grades, ufc_model_versions,
-- ufc_model_backtest_runs and ufc_model_backtest_predictions in its own right.
-- service_role holds the full default on all five, and the grants below restate
-- it explicitly so the server read path survives a future tightening of the
-- defaults. If that ever stopped being true the /model page would render its
-- pre-launch empty state rather than error, which is why it is asserted in the
-- test file rather than left to be noticed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Execute as the caller, not as the owner.
-- ---------------------------------------------------------------------------
alter view public.ufc_model_prediction_current_grade set (security_invoker = true);
alter view public.ufc_model_live_record              set (security_invoker = true);
alter view public.ufc_model_live_recent              set (security_invoker = true);
alter view public.ufc_model_live_calibration         set (security_invoker = true);
alter view public.ufc_model_backtest_record          set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 2. No write path for the public roles, on the views or the tables behind them.
--    TRUNCATE is the privilege RLS never covered; on the prediction ledger it is
--    the one that matters most.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_prediction_current_grade from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_live_record              from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_live_recent              from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_live_calibration         from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_backtest_record          from anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_predictions              from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_prediction_grades        from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_versions                 from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_backtest_runs            from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.ufc_model_backtest_predictions     from anon, authenticated;

-- The store tables hold provisioning identifiers and real customer orders.
-- Neither is reachable except through server routes holding the service role.
revoke insert, update, delete, truncate, references, trigger
  on public.store_provisioning                 from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.store_orders                       from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.store_order_lines                  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reads are server-side. Say so in the grants.
-- ---------------------------------------------------------------------------
revoke select on public.ufc_model_prediction_current_grade from anon, authenticated;
revoke select on public.ufc_model_live_record              from anon, authenticated;
revoke select on public.ufc_model_live_recent              from anon, authenticated;
revoke select on public.ufc_model_live_calibration         from anon, authenticated;
revoke select on public.ufc_model_backtest_record          from anon, authenticated;

revoke select on public.ufc_model_predictions              from anon, authenticated;
revoke select on public.ufc_model_prediction_grades        from anon, authenticated;
revoke select on public.ufc_model_versions                 from anon, authenticated;
revoke select on public.ufc_model_backtest_runs            from anon, authenticated;
revoke select on public.ufc_model_backtest_predictions     from anon, authenticated;

revoke select on public.store_provisioning                 from anon, authenticated;
revoke select on public.store_orders                       from anon, authenticated;
revoke select on public.store_order_lines                  from anon, authenticated;

-- Explicit rather than assumed, and required by security_invoker: the views now
-- resolve their base tables as the caller.
grant select on public.ufc_model_prediction_current_grade to service_role;
grant select on public.ufc_model_live_record              to service_role;
grant select on public.ufc_model_live_recent              to service_role;
grant select on public.ufc_model_live_calibration         to service_role;
grant select on public.ufc_model_backtest_record          to service_role;

grant select on public.ufc_model_predictions              to service_role;
grant select on public.ufc_model_prediction_grades        to service_role;
grant select on public.ufc_model_versions                 to service_role;
grant select on public.ufc_model_backtest_runs            to service_role;
grant select on public.ufc_model_backtest_predictions     to service_role;

grant select on public.store_provisioning                 to service_role;
grant select on public.store_orders                       to service_role;
grant select on public.store_order_lines                  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Record the decision where the next reader of the schema will find it.
-- ---------------------------------------------------------------------------
comment on view public.ufc_model_live_record is
  'LIVE RECORD: locked, published predictions with their current grade. Never blended with the backtest record. security_invoker = true: executes as the caller, so base-table RLS applies. Server-read only (service_role).';
comment on view public.ufc_model_backtest_record is
  'BACKTEST RECORD: walk-forward validation results. Historical evidence about the model, not a published trading record, and never blended with the live record. security_invoker = true. Server-read only (service_role).';
comment on view public.ufc_model_prediction_current_grade is
  'Latest grade per prediction from the append-only grade history. A later row supersedes an earlier one; nothing is overwritten, because official results can be overturned. security_invoker = true. Server-read only (service_role).';

commit;
