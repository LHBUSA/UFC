-- Identity reconciliation audit: record source-id attachments, not only merges
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive and relaxing only. ufc_identity_reconciliations was built for
-- merges (a canonical row and the duplicate it absorbed). Attaching a proven
-- source id to an existing canonical fighter — no merge, no deletion — is the
-- same kind of operator reconciliation and belongs in the same audit, with its
-- before-image. It has no duplicate row, so duplicate_id may be null for that
-- kind and only for that kind.
--
-- First user: scripts/reconcile/20260913_tuf1_espn_athlete_ids.sql (16 TUF 1
-- contestants' ESPN athlete ids, anchored to their exact finale bouts).

alter table public.ufc_identity_reconciliations drop constraint if exists ufc_identity_reconciliations_kind_check;
alter table public.ufc_identity_reconciliations
  add constraint ufc_identity_reconciliations_kind_check check (kind in ('bout_merge', 'fighter_merge', 'source_id_attach'));

alter table public.ufc_identity_reconciliations alter column duplicate_id drop not null;
alter table public.ufc_identity_reconciliations drop constraint if exists ufc_identity_reconciliations_duplicate_required;
alter table public.ufc_identity_reconciliations
  add constraint ufc_identity_reconciliations_duplicate_required check (duplicate_id is not null or kind = 'source_id_attach');

comment on table public.ufc_identity_reconciliations is
  'Append-only audit of identity reconciliations: merges (before-images of every row removed or rewritten) and source-id attachments (before-image of the canonical row), with the evidence and the reviewed plan hash.';

notify pgrst, 'reload schema';
