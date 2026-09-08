-- Store provisioning state.
--
-- STATUS: applied and tested against a disposable local Postgres 17 cluster
-- (initdb into a scratch directory, dropped afterwards). NOT applied to any
-- hosted environment.
--
-- What that establishes: the file applies cleanly, is idempotent under a
-- second application, and migrations/tests/010_store_provisioning.test.sql
-- passes against the result — so Postgres itself refuses the transitions
-- described below, rather than us merely believing it would. The JavaScript
-- tests in scripts/store/reconcile_rules.test.mjs exercise a mirror of these
-- rules and show the client asks for the right transition; this file is what
-- shows the database enforces it against a client that does not.
--
-- Why this table exists at all.
--
-- Product creation at the print provider is the one irreversible thing this
-- system does before an order exists: a duplicate sync product is not an
-- error message, it is a second listing in a real store that someone has to
-- go and delete by hand. A committed catalog.lock.json cannot prevent that.
-- A lock file is a snapshot of what one deployment believed at build time;
-- two deployments, or one deployment retried, read the same snapshot, see the
-- same absence, and both create.
--
-- So the authority is here, in a row that only one caller can hold at a time,
-- and the interesting state is not "created" — it is UNCERTAIN.
--
-- ---------------------------------------------------------------------------
-- Crash recovery, which is where the first draft of this file was wrong
--
-- Three failures have to be survived, and only the first is obvious.
--
-- 1. The process dies mid-request, before it can record anything.
--    The row is left 'in_flight' and nobody is coming back to it. The first
--    draft let a stale 'in_flight' row be re-claimed directly once its claim
--    aged out — which is precisely the duplicate-creating retry this table
--    exists to prevent, because the abandoned request may well have created
--    the product. A stale claim is therefore NOT claimable. It can only be
--    EXPIRED into 'uncertain' (store_expire_stale_claims), after which it
--    must be reconciled like any other unobserved outcome. Expiring a slug
--    whose request never actually left costs a delay; the alternative costs a
--    duplicate garment.
--
-- 2. An abandoned claim must reconcile before another create attempt.
--    Falls out of (1): the only claimable states are 'unclaimed' and 'failed',
--    and 'failed' is only ever written from an OBSERVED refusal, or by
--    reconciliation that has satisfied the rules below.
--
-- 3. Zero lookup matches straight after an uncertain request is not proof of
--    absence. The provider's product listing is not guaranteed to be
--    read-your-writes: a create that succeeded may not appear in
--    GET /store/products yet. Reconciling "0 matches" to 'failed' immediately
--    would hand the slug straight back for another create, which is the same
--    duplicate by a slower route. So absence has to be established over time:
--    a quarantine interval since the outcome, and several absent observations
--    spaced apart, before 'uncertain' may become retryable. Positive evidence
--    is different — exactly one match is conclusive immediately, because the
--    product demonstrably exists.
--
-- These rules live in SQL rather than only in the script, so a client that
-- gets them wrong is refused rather than believed.
--
-- Costs and provider ids live here and nowhere near a page. Read with the
-- service role only.

create table if not exists store_provisioning (
  slug                  text primary key,
  provider              text        not null default 'printful',

  -- unclaimed : nothing has been attempted
  -- in_flight : a caller holds the claim and is mid-request
  -- created   : the provider confirmed the product; provider_product_id is set
  -- failed    : an OBSERVED refusal, or an absence established under the
  --             quarantine rules. This is the only retryable state.
  -- uncertain : the outcome was never observed. Reconcile; never retry.
  state                 text        not null default 'unclaimed'
                        check (state in ('unclaimed','in_flight','created','failed','uncertain')),

  -- The claim. A caller may only act while it holds a matching attempt_id.
  attempt_id            uuid,
  claimed_by            text,
  claimed_at            timestamptz,

  -- Observed provider facts. Null until the provider confirmed them.
  provider_store_id     bigint,
  provider_product_id   bigint,
  provider_variant_ids  jsonb       not null default '{}'::jsonb,
  provider_costs        jsonb       not null default '{}'::jsonb,
  print_areas           jsonb       not null default '{}'::jsonb,

  -- Uncertainty bookkeeping. absent_checks only counts observations that were
  -- far enough apart to be independent; two lookups a second apart are one
  -- observation of the same instant, not two.
  uncertain_since       timestamptz,
  absent_checks         integer     not null default 0,
  last_absent_check_at  timestamptz,

  reconciled_at         timestamptz,
  reconcile_note        text,
  last_error            text,
  attempts              integer     not null default 0,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- A product that reached 'created' must carry the id that proves it. Without
-- this a bug could mark a row created with nothing to point at, and the next
-- run would skip creation for a product that does not exist.
alter table store_provisioning drop constraint if exists store_provisioning_created_has_id;
alter table store_provisioning add constraint store_provisioning_created_has_id
  check (state <> 'created' or provider_product_id is not null);

-- A claim is only meaningful with an identity and a time attached to it.
alter table store_provisioning drop constraint if exists store_provisioning_claim_complete;
alter table store_provisioning add constraint store_provisioning_claim_complete
  check (state <> 'in_flight' or (attempt_id is not null and claimed_at is not null));

-- An uncertain row must know when it became uncertain, or the quarantine
-- window has no start and absence could be declared immediately.
alter table store_provisioning drop constraint if exists store_provisioning_uncertain_dated;
alter table store_provisioning add constraint store_provisioning_uncertain_dated
  check (state <> 'uncertain' or uncertain_since is not null);

-- One product maps to exactly one provider product. This is the guard that
-- does not depend on the provider's external_id semantics being what we hope:
-- even if it happily creates a second product under the same external_id,
-- that second id cannot be recorded here, and the run fails holding both.
create unique index if not exists store_provisioning_provider_product_uniq
  on store_provisioning (provider, provider_product_id)
  where provider_product_id is not null;

create index if not exists store_provisioning_open_idx
  on store_provisioning (state) where state <> 'created';

-- Written by the provisioning job under the service role. No anon policy
-- exists, and none should: nothing a browser does may touch this.
alter table store_provisioning enable row level security;

comment on table store_provisioning is
  'Durable provisioning state for print-provider products. One row per catalog slug, claimed atomically. Unobserved outcomes become uncertain and must be reconciled — never retried — and absence is only established after a quarantine window.';
comment on column store_provisioning.state is
  'unclaimed | in_flight | created | failed | uncertain. Only unclaimed and failed are claimable.';
comment on column store_provisioning.absent_checks is
  'Independent observations that found no matching product at the provider. Only counts observations spaced at least the recheck interval apart.';
comment on column store_provisioning.provider_costs is
  'Provider cost prices per variant. Operational; never projected to a storefront.';

-- ---------------------------------------------------------------------------
-- Claim one slug, atomically.
--
-- Two callers racing produce one insert and one conflict, and the conflict
-- path only updates a row that is genuinely takeable. Takeable is exactly two
-- states: never attempted, and an observed failure.
--
-- Deliberately NOT takeable:
--   created   — it exists
--   uncertain — reconcile first; retrying is how duplicates are made
--   in_flight — including a long-abandoned one. Age does not turn an
--               unobserved outcome into a known one. Expire it instead.
create or replace function store_claim_slug(
  p_slug        text,
  p_attempt_id  uuid,
  p_claimed_by  text
) returns store_provisioning
language plpgsql
as $$
declare
  row store_provisioning;
begin
  insert into store_provisioning (slug, state, attempt_id, claimed_by, claimed_at, attempts)
  values (p_slug, 'in_flight', p_attempt_id, p_claimed_by, now(), 1)
  on conflict (slug) do update
     set state      = 'in_flight',
         attempt_id = p_attempt_id,
         claimed_by = p_claimed_by,
         claimed_at = now(),
         attempts   = store_provisioning.attempts + 1,
         last_error = null,
         updated_at = now()
   where store_provisioning.state in ('unclaimed', 'failed')
  returning * into row;

  -- Null means the row exists and was not takeable. The caller inspects it.
  return row;
end;
$$;

comment on function store_claim_slug is
  'Atomically claim one slug. Returns null unless the row is unclaimed or failed. A stale in_flight row is never claimable — expire it to uncertain first.';

-- ---------------------------------------------------------------------------
-- Expire abandoned claims into uncertainty.
--
-- This is the crash-recovery entry point. A claim older than the stale window
-- whose holder never reported back is, by definition, an outcome nobody
-- observed. It becomes 'uncertain' — not 'failed', and not claimable — so the
-- next thing that touches it must reconcile.
--
-- uncertain_since is set from the claim time, not from now(), so a claim that
-- was abandoned an hour ago does not get a fresh hour of quarantine.
create or replace function store_expire_stale_claims(
  p_stale_after interval default interval '10 minutes'
) returns setof store_provisioning
language sql
as $$
  update store_provisioning
     set state           = 'uncertain',
         uncertain_since = coalesce(uncertain_since, claimed_at, now()),
         attempt_id      = null,
         reconcile_note  = 'claim abandoned by ' || coalesce(claimed_by, 'unknown') ||
                           '; outcome never observed, quarantined for reconciliation',
         updated_at      = now()
   where state = 'in_flight'
     and claimed_at < now() - p_stale_after
  returning *;
$$;

comment on function store_expire_stale_claims is
  'Move abandoned in_flight claims to uncertain. Crash recovery: an unreported outcome is unknown, not failed.';

-- ---------------------------------------------------------------------------
-- Record one absent observation against an uncertain row.
--
-- Only counts if the previous observation was at least p_recheck ago.
-- Hammering the provider in a loop must not accumulate evidence that time has
-- passed, because it has not.
create or replace function store_record_absent(
  p_slug    text,
  p_recheck interval default interval '2 minutes'
) returns store_provisioning
language sql
as $$
  update store_provisioning
     set absent_checks        = absent_checks + 1,
         last_absent_check_at = now(),
         updated_at           = now()
   where slug = p_slug
     and state = 'uncertain'
     and (last_absent_check_at is null or last_absent_check_at < now() - p_recheck)
  returning *;
$$;

comment on function store_record_absent is
  'Count one independent absent observation. No-ops if the previous check was too recent to be independent.';

-- ---------------------------------------------------------------------------
-- Declare an uncertain row genuinely absent, and therefore retryable.
--
-- Refuses unless BOTH hold:
--   - the quarantine window has elapsed since the outcome, and
--   - enough independent absent observations have accumulated.
--
-- Returns null when the conditions are not met, which is the caller's signal
-- to leave it alone and come back later. This is the function that stops
-- "zero matches, right now" from becoming permission to create again.
create or replace function store_settle_absent(
  p_slug       text,
  p_quarantine interval default interval '15 minutes',
  p_min_checks integer  default 3
) returns store_provisioning
language sql
as $$
  update store_provisioning
     set state          = 'failed',
         attempt_id     = null,
         reconciled_at  = now(),
         reconcile_note = 'absent at the provider across ' || absent_checks ||
                          ' independent checks over ' ||
                          date_trunc('second', now() - uncertain_since)::text ||
                          '; safe to retry',
         updated_at     = now()
   where slug = p_slug
     and state = 'uncertain'
     and uncertain_since < now() - p_quarantine
     and absent_checks >= p_min_checks
  returning *;
$$;

comment on function store_settle_absent is
  'Move uncertain -> failed only after the quarantine window AND enough independent absent observations. Returns null when it is too early to conclude absence.';

-- ---------------------------------------------------------------------------
-- Adopt a product the provider demonstrably has.
--
-- Positive evidence needs no quarantine: the product exists, we can see it,
-- and the only correct action is to record it and stop trying to create it.
create or replace function store_adopt_existing(
  p_slug        text,
  p_product_id  bigint,
  p_note        text default 'adopted existing product found at the provider'
) returns store_provisioning
language sql
as $$
  update store_provisioning
     set state               = 'created',
         provider_product_id = p_product_id,
         attempt_id          = null,
         uncertain_since     = null,
         absent_checks       = 0,
         reconciled_at       = now(),
         reconcile_note      = p_note,
         updated_at          = now()
   where slug = p_slug
     and state in ('uncertain', 'in_flight', 'failed', 'unclaimed')
  returning *;
$$;

comment on function store_adopt_existing is
  'Record a product observed at the provider. Positive evidence is conclusive immediately; no quarantine applies.';
