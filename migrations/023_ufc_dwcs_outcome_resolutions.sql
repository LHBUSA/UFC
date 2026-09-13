-- Contender Series outcome resolutions. SOURCE CLAIM != CANONICAL FACT != DISPLAY.
--
-- =========================================================================
-- WHY
-- =========================================================================
--
-- 20260913000001 created ufc_dwcs_outcome_claims and the website displayed
-- every row whose extractor triage said "published". That collapsed three
-- different things into one flag:
--
--   evidence    a UFC.com (or ESPN) sentence that names a fighter
--   fact        that the fighter was in fact awarded the outcome
--   display     that PropBetEdge shows it publicly
--
-- UFC.com is promotion material. It is valuable evidence; it is not
-- automatically display truth. This migration follows the provenance model
-- already specified for legacy event facts (claims / resolutions / display on
-- ufc-legacy-origins-v1): claims are immutable evidence, a resolution is a
-- separate, attributable operator act, and only a resolved claim is shown.
--
-- =========================================================================
-- WHAT IT DOES
-- =========================================================================
--
--   1. Claim triage 'published' is renamed 'eligible'. It never meant shown;
--      it meant "the extractor found nothing wrong". No row is added, removed
--      or re-sourced; only that label changes (126 rows).
--   2. ufc_dwcs_outcome_claims becomes append-only evidence: no DELETE, its
--      source columns are immutable, and `evidence` may only grow (ESPN
--      corroboration can be added, never removed). fighter_id may move only
--      along a recorded fighter_merge in ufc_identity_reconciliations.
--   3. ufc_dwcs_outcome_resolutions: one row per operator decision to display
--      a claim. resolution_rule is 'operator_decision' only — there is no
--      automatic rule for promotion material. A resolution cannot select an
--      ESPN claim, a claim in review / secondary_only / conflicted triage, a
--      claim for another fighter/event/type, or a fighter with a conflicted
--      claim of the same type. A claim naming a fighter the stored result does
--      not record as the winner needs review_notes. Resolutions are never
--      deleted: they are withdrawn, with a reason, and the evidence stays.
--   4. ufc_dwcs_outcome_display (security_invoker view): approved resolutions
--      joined to their claims. The only thing the website reads.
--
-- It creates NO resolution. Public outcomes are zero until an operator
-- approves claims one by one.
--
-- Additive except the triage rename; RLS on, no policies, nothing for
-- anon/authenticated, matching every other ufc_* table.
-- =========================================================================

begin;

-- ---- 1. triage label ------------------------------------------------------
alter table public.ufc_dwcs_outcome_claims drop constraint if exists ufc_dwcs_outcome_claims_claim_status_check;
alter table public.ufc_dwcs_outcome_claims drop constraint if exists ufc_dwcs_outcome_claims_published_official;
update public.ufc_dwcs_outcome_claims set claim_status = 'eligible', updated_at = now() where claim_status = 'published';
alter table public.ufc_dwcs_outcome_claims
  add constraint ufc_dwcs_outcome_claims_claim_status_check
    check (claim_status in ('eligible', 'review', 'secondary_only', 'conflicted')),
  -- Only the official source can even be eligible for display review.
  add constraint ufc_dwcs_outcome_claims_eligible_official
    check (claim_status <> 'eligible' or source_family = 'ufc.com');
alter table public.ufc_dwcs_outcome_claims alter column claim_status set default 'review';

comment on column public.ufc_dwcs_outcome_claims.claim_status is
  'Extractor/review TRIAGE of the evidence, not display: eligible | review | secondary_only | conflicted. Nothing is shown without an approved row in ufc_dwcs_outcome_resolutions.';

-- Target for the resolutions' composite foreign key.
alter table public.ufc_dwcs_outcome_claims
  add constraint ufc_dwcs_outcome_claims_identity_key unique (id, fighter_id, event_id, claim_type);

-- ---- 2. claims are evidence ------------------------------------------------
create or replace function public.ufc_dwcs_outcome_claims_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'ufc_dwcs_outcome_claims is evidence: claim % cannot be deleted', old.id;
  end if;
  if (new.id, new.event_id, new.bout_id, new.claim_type, new.source_url, new.source_title, new.source_date,
      new.source_family, new.source_excerpt_short, new.captured_at)
     is distinct from
     (old.id, old.event_id, old.bout_id, old.claim_type, old.source_url, old.source_title, old.source_date,
      old.source_family, old.source_excerpt_short, old.captured_at) then
    raise exception 'ufc_dwcs_outcome_claims: claim % is immutable evidence; only triage, review_reason and added evidence may change', old.id;
  end if;
  if new.fighter_id is distinct from old.fighter_id and not exists (
       select 1 from public.ufc_identity_reconciliations r
        where r.kind = 'fighter_merge' and r.duplicate_id = old.fighter_id and r.canonical_id = new.fighter_id) then
    raise exception 'ufc_dwcs_outcome_claims: claim % fighter may only move along a recorded fighter_merge', old.id;
  end if;
  if not (coalesce(new.evidence, '{}'::jsonb) @> coalesce(old.evidence, '{}'::jsonb)) then
    raise exception 'ufc_dwcs_outcome_claims: claim % evidence may be added to, never removed', old.id;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists ufc_dwcs_outcome_claims_guard on public.ufc_dwcs_outcome_claims;
create trigger ufc_dwcs_outcome_claims_guard
  before update or delete on public.ufc_dwcs_outcome_claims
  for each row execute function public.ufc_dwcs_outcome_claims_guard();

-- ---- 3. resolutions ---------------------------------------------------------
create table if not exists public.ufc_dwcs_outcome_resolutions (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id),
  event_id uuid not null references public.ufc_events(id),
  bout_id uuid references public.ufc_bouts(id),
  claim_type text not null check (claim_type in ('contract_awarded', 'developmental_deal', 'tuf_invite', 'other_opportunity')),
  selected_claim_id uuid not null,

  resolution_status text not null default 'approved' check (resolution_status in ('approved', 'withdrawn')),
  -- Promotion material is never resolved by rule. A person decides.
  resolution_rule text not null check (resolution_rule = 'operator_decision'),
  resolved_by text not null check (char_length(btrim(resolved_by)) > 0),
  reviewed_at timestamptz not null default now(),
  review_notes text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  withdrawn_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The selected claim must be a claim about this fighter, event and outcome.
  -- ON UPDATE CASCADE carries a recorded fighter merge through to the decision.
  constraint ufc_dwcs_outcome_resolutions_claim_fkey
    foreign key (selected_claim_id, fighter_id, event_id, claim_type)
    references public.ufc_dwcs_outcome_claims (id, fighter_id, event_id, claim_type)
    on update cascade on delete restrict,
  constraint ufc_dwcs_outcome_resolutions_withdrawal_complete check (
    (resolution_status = 'approved' and withdrawn_at is null and withdrawn_reason is null)
    or (resolution_status = 'withdrawn' and withdrawn_at is not null and char_length(btrim(coalesce(withdrawn_reason, ''))) > 0
        and char_length(btrim(coalesce(withdrawn_by, ''))) > 0))
);

create unique index if not exists ufc_dwcs_outcome_resolutions_one_approved
  on public.ufc_dwcs_outcome_resolutions (fighter_id, event_id, claim_type) where resolution_status = 'approved';
create index if not exists ufc_dwcs_outcome_resolutions_claim_idx on public.ufc_dwcs_outcome_resolutions (selected_claim_id);

create or replace function public.ufc_dwcs_outcome_resolutions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
declare
  c public.ufc_dwcs_outcome_claims%rowtype;
  winner uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'ufc_dwcs_outcome_resolutions: resolution % is an audit record; withdraw it instead of deleting', old.id;
  end if;

  if tg_op = 'UPDATE' then
    /* A decision is not edited into a different decision. The only change is
       approved -> withdrawn (with who and why); a new decision is a new row. */
    if (new.id, new.fighter_id, new.event_id, new.bout_id, new.claim_type, new.selected_claim_id, new.resolution_rule,
        new.resolved_by, new.reviewed_at, new.review_notes, new.created_at)
       is distinct from
       (old.id, old.fighter_id, old.event_id, old.bout_id, old.claim_type, old.selected_claim_id, old.resolution_rule,
        old.resolved_by, old.reviewed_at, old.review_notes, old.created_at)
       and not (new.fighter_id is distinct from old.fighter_id
                and exists (select 1 from public.ufc_identity_reconciliations r
                             where r.kind = 'fighter_merge' and r.duplicate_id = old.fighter_id and r.canonical_id = new.fighter_id)) then
      raise exception 'ufc_dwcs_outcome_resolutions: resolution % is immutable except for withdrawal', old.id;
    end if;
    if old.resolution_status = 'withdrawn' and new.resolution_status <> 'withdrawn' then
      raise exception 'ufc_dwcs_outcome_resolutions: a withdrawn resolution is not re-approved; create a new one';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- INSERT: the selected claim must be displayable evidence.
  select * into c from public.ufc_dwcs_outcome_claims where id = new.selected_claim_id;
  if c.id is null then raise exception 'resolution selects missing claim %', new.selected_claim_id; end if;
  if c.bout_id is distinct from new.bout_id then
    raise exception 'resolution bout % does not match claim bout %', new.bout_id, c.bout_id;
  end if;
  if c.source_family <> 'ufc.com' then
    raise exception 'resolution cannot select % claim %: only the official source can be displayed', c.source_family, c.id;
  end if;
  if c.claim_status <> 'eligible' then
    raise exception 'resolution cannot select claim % in triage %', c.id, c.claim_status;
  end if;
  if exists (select 1 from public.ufc_dwcs_outcome_claims o
              where o.fighter_id = c.fighter_id and o.claim_type = c.claim_type and o.claim_status = 'conflicted') then
    raise exception 'resolution cannot display % for fighter %: a conflicting claim is unresolved', c.claim_type, c.fighter_id;
  end if;
  if c.bout_id is not null then
    select winner_id into winner from public.ufc_bout_results where bout_id = c.bout_id;
    if winner is distinct from c.fighter_id and char_length(btrim(coalesce(new.review_notes, ''))) = 0 then
      raise exception 'resolution for claim %: the stored result does not record fighter % as the winner; review_notes must say why it is still displayed', c.id, c.fighter_id;
    end if;
  end if;
  if new.resolution_status <> 'approved' then
    raise exception 'a resolution is created approved; withdrawal is a later act';
  end if;
  return new;
end
$fn$;

drop trigger if exists ufc_dwcs_outcome_resolutions_guard on public.ufc_dwcs_outcome_resolutions;
create trigger ufc_dwcs_outcome_resolutions_guard
  before insert or update or delete on public.ufc_dwcs_outcome_resolutions
  for each row execute function public.ufc_dwcs_outcome_resolutions_guard();

alter table public.ufc_dwcs_outcome_resolutions enable row level security;
revoke all on public.ufc_dwcs_outcome_resolutions from public, anon, authenticated;

-- ---- 4. display -------------------------------------------------------------
create or replace view public.ufc_dwcs_outcome_display
with (security_invoker = true) as
select r.id as resolution_id, r.fighter_id, r.event_id, r.bout_id, r.claim_type,
       c.id as claim_id, c.source_url, c.source_title, c.source_date, c.source_family, c.source_excerpt_short,
       r.resolution_rule, r.resolved_by, r.reviewed_at
from public.ufc_dwcs_outcome_resolutions r
join public.ufc_dwcs_outcome_claims c on c.id = r.selected_claim_id
where r.resolution_status = 'approved'
  and c.source_family = 'ufc.com'
  and c.claim_status = 'eligible';

revoke all on public.ufc_dwcs_outcome_display from public, anon, authenticated;

comment on table public.ufc_dwcs_outcome_resolutions is
  'Operator decisions to DISPLAY a Contender Series outcome claim. Never inferred, never automatic, never deleted (withdrawn instead). The website reads ufc_dwcs_outcome_display only.';
comment on view public.ufc_dwcs_outcome_display is
  'Approved resolutions joined to their official claims. Empty until an operator resolves a claim.';

commit;

notify pgrst, 'reload schema';
