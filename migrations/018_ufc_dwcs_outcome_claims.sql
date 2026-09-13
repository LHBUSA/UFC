-- Contender Series outcome claims. SOURCED STATEMENTS ONLY.
--
-- =========================================================================
-- WHAT A ROW IS
-- =========================================================================
--
-- One row is one attributed source saying one thing about one fighter's
-- Contender Series appearance: "X was awarded a UFC contract", "X was given a
-- developmental deal", "X was invited to The Ultimate Fighter". It is a claim
-- with its source attached, not a fact about the fighter, and it lives beside
-- the canonical fight record rather than inside it.
--
-- A win on the Contender Series is NOT a contract. Winners have been passed
-- over, losers have been signed, and Diego Lopes lost on Season 5 and reached
-- the UFC anyway. So nothing in the database may infer a row here from
-- ufc_bout_results, and there is deliberately no "no_contract" claim type:
-- the absence of a sourced statement is absence, not a negative outcome.
--
-- =========================================================================
-- STATUS
-- =========================================================================
--
--   published       an official (ufc.com) sentence names the fighter, and it
--                   agrees with the stored result; the only rows a page shows
--   review          a sentence names the fighter but disagrees with the stored
--                   result, or needs a human reading; never shown
--   secondary_only  named only by a non-official source (espn.com); evidence,
--                   never shown
--   conflicted      two sources place the outcome differently; never shown for
--                   that fighter until a human resolves it
--
-- A fighter-named sentence outranks an aggregate ("44 contracts this season"),
-- and an aggregate alone never creates a row.
--
-- source_excerpt_short is evidentiary and capped: never an article body.
--
-- Additive and non-destructive. Nothing that already exists is altered.
-- =========================================================================

begin;

create table if not exists public.ufc_dwcs_outcome_claims (
  id uuid primary key,
  fighter_id uuid not null references public.ufc_fighters(id),
  event_id uuid not null references public.ufc_events(id),
  bout_id uuid references public.ufc_bouts(id),

  claim_type text not null check (claim_type in ('contract_awarded', 'developmental_deal', 'tuf_invite', 'other_opportunity')),
  claim_status text not null default 'review' check (claim_status in ('published', 'review', 'secondary_only', 'conflicted')),
  review_reason text,

  source_url text not null check (source_url ~ '^https://'),
  source_title text,
  source_date date,
  source_family text not null check (source_family in ('ufc.com', 'espn.com')),
  source_excerpt_short text check (source_excerpt_short is null or char_length(source_excerpt_short) <= 240),
  -- How the claim was resolved (match method, captured file, corroborating
  -- sources). Audit trail, not display.
  evidence jsonb not null default '{}'::jsonb,

  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A public claim must come from the official source.
  constraint ufc_dwcs_outcome_claims_published_official check (claim_status <> 'published' or source_family = 'ufc.com'),
  constraint ufc_dwcs_outcome_claims_one_per_source unique (fighter_id, event_id, claim_type, source_url)
);

create index if not exists ufc_dwcs_outcome_claims_fighter_idx on public.ufc_dwcs_outcome_claims (fighter_id);
create index if not exists ufc_dwcs_outcome_claims_event_idx on public.ufc_dwcs_outcome_claims (event_id);
create index if not exists ufc_dwcs_outcome_claims_published_idx on public.ufc_dwcs_outcome_claims (claim_status) where claim_status = 'published';

-- Same posture as every other ufc_* table: RLS on, no policies; server-side
-- reads and the operator loader use the service role.
alter table public.ufc_dwcs_outcome_claims enable row level security;

comment on table public.ufc_dwcs_outcome_claims is
  'Attributed Contender Series outcome claims (contract, developmental deal, TUF invite). Never inferred from results; only claim_status=published rows are displayed.';

commit;

notify pgrst, 'reload schema';
