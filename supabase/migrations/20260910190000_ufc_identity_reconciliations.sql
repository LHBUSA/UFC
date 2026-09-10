-- Identity reconciliation audit
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive: one table. Written only by an operator-run reconciliation
-- (scripts/reconcile/), never by a scheduled Worker.
--
-- WHY
-- Merging a duplicate fighter/bout pair deletes the duplicate rows, because
-- the unique source-id constraints and the at-least-one-source-id check make
-- "empty it and keep it" impossible. Deleting evidence silently is not
-- acceptable, so every reconciliation first writes the full before-image of
-- every row it will delete or rewrite, the evidence that the two rows are the
-- same fighter/bout, and the hash of the reviewed plan it executed.

create table if not exists public.ufc_identity_reconciliations (
  id                  bigserial primary key,
  plan_sha256         text not null,
  kind                text not null check (kind in ('bout_merge', 'fighter_merge')),
  canonical_id        uuid not null,
  duplicate_id        uuid not null,
  evidence            jsonb not null,          -- checks that passed, identity evidence, DOB disagreement
  before_images       jsonb not null,          -- every row deleted or rewritten, as it was
  operator            text not null,
  applied_at          timestamptz not null default now()
);

create index if not exists ufc_identity_reconciliations_canonical on public.ufc_identity_reconciliations (canonical_id);
create index if not exists ufc_identity_reconciliations_duplicate on public.ufc_identity_reconciliations (duplicate_id);

comment on table public.ufc_identity_reconciliations is
  'Append-only audit of identity merges: before-images of every row removed or rewritten, the evidence, and the reviewed plan hash.';

alter table public.ufc_identity_reconciliations enable row level security;
revoke all on public.ufc_identity_reconciliations from public, anon, authenticated;
grant select, insert on public.ufc_identity_reconciliations to service_role;
grant usage on sequence public.ufc_identity_reconciliations_id_seq to service_role;

notify pgrst, 'reload schema';
