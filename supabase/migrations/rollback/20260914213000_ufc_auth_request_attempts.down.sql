-- Rollback for 20260914213000_ufc_auth_request_attempts.sql
-- Only after the UFC web auth routes no longer read or write this table.
begin;
drop table if exists public.ufc_auth_request_attempts;
commit;
