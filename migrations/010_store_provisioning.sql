-- Store provisioning state.
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
-- The failure that matters is not the request that fails. It is the request
-- whose outcome we never learn: a timeout, a dropped connection, a 502 from
-- an edge in front of the provider. The product may exist. Retrying blindly
-- is how a duplicate is made. Every one of those transitions to 'uncertain',
-- and 'uncertain' may not be retried — it must first be RECONCILED against
-- the provider's own listing, and only an outcome we actually observed moves
-- the row forward.
--
-- Costs and provider ids live here and nowhere near a page. This table is
-- read with the service role only.

create table if not exists store_provisioning (
  slug                  text primary key,
  provider              text        not null default 'printful',

  -- unclaimed : nothing has been attempted
  -- in_flight : a caller holds the claim and is mid-request
  -- created   : the provider confirmed the product; provider_product_id is set
  -- failed    : the provider refused, and we know it did not create anything
  -- uncertain : the outcome was never observed; reconcile before any retry
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

  -- Reconciliation history, so an operator can see what was decided and why.
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
alter table store_provisioning
  drop constraint if exists store_provisioning_created_has_id;
alter table store_provisioning
  add constraint store_provisioning_created_has_id
  check (state <> 'created' or provider_product_id is not null);

-- A claim is only meaningful with an identity and a time attached to it.
alter table store_provisioning
  drop constraint if exists store_provisioning_claim_complete;
alter table store_provisioning
  add constraint store_provisioning_claim_complete
  check (state <> 'in_flight' or (attempt_id is not null and claimed_at is not null));

-- One product may map to exactly one provider product. This is the guard that
-- does not depend on the provider's external_id semantics being what we hope
-- they are: even if the provider happily accepts a second product carrying the
-- same external_id, it cannot be recorded here twice.
create unique index if not exists store_provisioning_provider_product_uniq
  on store_provisioning (provider, provider_product_id)
  where provider_product_id is not null;

create index if not exists store_provisioning_state_idx
  on store_provisioning (state) where state <> 'created';

-- Rows are written by the provisioning job under the service role. No anon
-- policy exists, and none should: nothing a browser does may touch this.
alter table store_provisioning enable row level security;

comment on table store_provisioning is
  'Durable provisioning state for print-provider products. One row per catalog slug, claimed atomically; uncertain outcomes must be reconciled against the provider before any retry.';
comment on column store_provisioning.state is
  'unclaimed | in_flight | created | failed | uncertain. uncertain means the outcome was never observed and a retry could duplicate.';
comment on column store_provisioning.provider_costs is
  'Provider cost prices per variant. Operational; never projected to a storefront.';

-- Claim a slug for one caller, atomically.
--
-- Returns the row only to the caller that won it. Concurrency is settled by
-- the primary key on slug plus the WHERE clause on the update: two callers
-- racing to insert produce one insert and one conflict, and the conflict path
-- only updates a row that is genuinely takeable.
--
-- Takeable means: never attempted, previously failed (we know nothing was
-- created), or a claim that has gone stale because its holder died. It does
-- NOT include 'created' and it does NOT include 'uncertain'. Uncertain rows
-- are excluded on purpose — the caller must reconcile first and move the row
-- to 'failed' or 'created' with evidence before it can be claimed again.
create or replace function store_claim_slug(
  p_slug        text,
  p_attempt_id  uuid,
  p_claimed_by  text,
  p_stale_after interval default interval '10 minutes'
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
         updated_at = now()
   where store_provisioning.state in ('unclaimed', 'failed')
      or (store_provisioning.state = 'in_flight'
          and store_provisioning.claimed_at < now() - p_stale_after)
  returning * into row;

  -- Null means the row exists and was not takeable: created, uncertain, or a
  -- live claim held by someone else. The caller inspects it and decides.
  return row;
end;
$$;

comment on function store_claim_slug is
  'Atomically claim one slug for provisioning. Returns null when the row is created, uncertain, or claimed by a live caller.';
