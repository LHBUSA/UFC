-- Store orders: physical goods, real money, one fulfilment each.
--
-- STATUS: applied and tested only against a disposable local Postgres. Not
-- applied to any hosted environment.
--
-- This table exists for the same reason store_provisioning does, one step
-- further along. Provisioning's irreversible act is creating a product;
-- ordering's is submitting a fulfilment, which prints a garment and ships it
-- to an address. Both are irreversible, both are performed by a process that
-- can die halfway, and in both cases the dangerous state is not failure — it
-- is NOT KNOWING.
--
-- ---------------------------------------------------------------------------
-- The three ways this goes wrong, and what stops each
--
-- 1. The same payment is processed twice.
--    Stripe retries a webhook whenever it does not get a prompt 2xx, and a
--    handler that is slow gets retried while still running. So payment is
--    recorded by a function that is idempotent on stripe_session_id and
--    returns the same row whether it is the first call or the fifth. Nothing
--    downstream keys off "the webhook fired"; it keys off the row's state.
--
-- 2. The same order is submitted to the printer twice.
--    A duplicate here is two parcels and a refund conversation. Submission is
--    therefore claim-guarded exactly like provisioning: a caller must hold a
--    matching attempt_id, only 'paid' and 'submit_failed' are claimable, and
--    a claim that ages out does NOT become claimable again. It expires to
--    'submit_uncertain', which is reconciled by listing the provider's orders
--    and matching on our external_id, never by trying again.
--
-- 3. An order is fulfilled that was never paid for.
--    state 'paid' is only ever written by store_order_mark_paid, which is
--    only ever called from a signature-verified Stripe webhook. The claim
--    function refuses any row that is not already paid, in SQL, so a bug in
--    the application cannot skip the step.
--
-- ---------------------------------------------------------------------------
-- What is deliberately NOT here
--
-- No card data, no payment method details, no Stripe customer object. Stripe
-- holds those. We keep the session id, what was bought, what it cost, and the
-- address the parcel must reach — because a fulfilment needs an address and
-- there is nowhere else to put it.
--
-- No prices from the browser. amount_total_cents is written from the Stripe
-- session, and unit_price_cents from the server-side catalog. Neither is ever
-- accepted from a request body.

create table if not exists store_orders (
  id                    uuid primary key default gen_random_uuid(),

  -- Public handle for the confirmation page. Unguessable, so a confirmation
  -- URL cannot be walked. The primary key stays internal.
  public_token          text        not null unique,

  -- pending          : session created, customer has not paid (or never will)
  -- paid             : Stripe confirmed payment. The only fulfillable state.
  -- submitting       : a caller holds the claim and is mid-request
  -- submitted        : the provider confirmed it has the order
  -- submit_failed    : an OBSERVED refusal. Retryable.
  -- submit_uncertain : the outcome was never observed. Reconcile; never retry.
  -- cancelled        : the session expired or was abandoned
  state                 text        not null default 'pending'
                        check (state in ('pending','paid','submitting','submitted',
                                         'submit_failed','submit_uncertain','cancelled')),

  -- Stripe. session id is the idempotency key for payment.
  stripe_session_id     text        not null unique,
  stripe_payment_intent text,
  currency              text        not null default 'usd',
  amount_total_cents    integer,
  amount_shipping_cents integer,
  amount_tax_cents      integer,

  -- Our identity for this order at the print provider. Generated before the
  -- first submission attempt, so an uncertain outcome can be reconciled by
  -- looking for it rather than by guessing which of the provider's orders was
  -- ours.
  external_id           text        not null unique,
  provider_order_id     bigint,

  -- The claim around submission.
  attempt_id            uuid,
  claimed_by            text,
  claimed_at            timestamptz,
  submit_attempts       integer     not null default 0,
  uncertain_since       timestamptz,
  last_error            text,

  -- Where it goes. Written from the Stripe session, never from a request body.
  email                 text,
  ship_name             text,
  ship_line1            text,
  ship_line2            text,
  ship_city             text,
  ship_state            text,
  ship_postal           text,
  ship_country          text,

  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  submitted_at          timestamptz,
  updated_at            timestamptz not null default now()
);

create table if not exists store_order_lines (
  id                    bigserial primary key,
  order_id              uuid        not null references store_orders(id) on delete cascade,

  -- What was bought, in our terms.
  slug                  text        not null,
  size                  text        not null,
  color                 text        not null,
  quantity              integer     not null check (quantity > 0 and quantity <= 10),

  -- Our price, from web/lib/store/catalog.ts, resolved server-side at the
  -- moment the session was created. Recorded so a later catalog edit cannot
  -- retroactively change what somebody was charged.
  unit_price_cents      integer     not null check (unit_price_cents > 0),

  -- The provider's handle for this exact size/colour, copied from
  -- store_provisioning at session time. Operational: it never leaves the
  -- server, and it is stored so fulfilment does not have to re-resolve it and
  -- risk resolving differently.
  provider_variant_id   bigint,

  created_at            timestamptz not null default now(),

  -- One line per (order, slug, size, colour). Two lines for the same variant
  -- would be a quantity, and letting both exist means one of them gets missed.
  unique (order_id, slug, size, color)
);

-- A paid order must know what it cost; an unpaid one has nothing to say yet.
alter table store_orders drop constraint if exists store_orders_paid_has_total;
alter table store_orders add constraint store_orders_paid_has_total
  check (state = 'pending' or state = 'cancelled' or amount_total_cents is not null);

-- A submitted order must point at something at the provider.
alter table store_orders drop constraint if exists store_orders_submitted_has_id;
alter table store_orders add constraint store_orders_submitted_has_id
  check (state <> 'submitted' or provider_order_id is not null);

-- A claim is all three fields or none of them.
alter table store_orders drop constraint if exists store_orders_claim_complete;
alter table store_orders add constraint store_orders_claim_complete
  check ((attempt_id is null and claimed_by is null and claimed_at is null)
      or (attempt_id is not null and claimed_by is not null and claimed_at is not null));

-- An unobserved outcome must be dated, or "how long has this been unknown"
-- has no answer and it can never be reconciled on a schedule.
alter table store_orders drop constraint if exists store_orders_uncertain_dated;
alter table store_orders add constraint store_orders_uncertain_dated
  check (state <> 'submit_uncertain' or uncertain_since is not null);

-- The provider must not hold two orders for one of ours.
create unique index if not exists store_orders_provider_order_uniq
  on store_orders (provider_order_id) where provider_order_id is not null;

create index if not exists store_orders_fulfillable_idx
  on store_orders (state, paid_at) where state in ('paid','submit_failed','submit_uncertain');

create index if not exists store_order_lines_order_idx on store_order_lines (order_id);

alter table store_orders enable row level security;
alter table store_order_lines enable row level security;

comment on table store_orders is
  'Physical-goods orders. Service role only: holds shipping addresses and provider handles. Payment is idempotent on stripe_session_id; fulfilment is claim-guarded and an unobserved submission becomes submit_uncertain rather than being retried.';
comment on column store_orders.public_token is
  'Unguessable handle for the confirmation page. The primary key is never exposed.';
comment on column store_orders.external_id is
  'Our id at the print provider, generated before the first submission so an unobserved outcome can be reconciled by lookup instead of by retry.';
comment on column store_order_lines.unit_price_cents is
  'Resolved server-side from the catalog at session time. Never accepted from a browser, and never re-derived later.';

-- ---------------------------------------------------------------------------
-- Recording payment. Idempotent by construction.
--
-- Stripe delivers a webhook at least once, which in practice means sometimes
-- more than once, sometimes concurrently, and occasionally after the handler
-- already succeeded but before Stripe saw the 200. All three collapse to the
-- same call here.
--
-- The update is guarded on state = 'pending' so a replay cannot move an order
-- that has since been submitted back to 'paid', which would hand it to the
-- fulfilment worker a second time. A replay against an already-paid row is
-- not an error: it returns the row unchanged, and the caller answers 200.
-- ---------------------------------------------------------------------------
create or replace function store_order_mark_paid(
  p_session_id  text,
  p_intent      text,
  p_total       integer,
  p_shipping    integer,
  p_tax         integer,
  p_email       text,
  p_ship        jsonb
) returns store_orders as $$
  update store_orders set
    state                 = 'paid',
    stripe_payment_intent = coalesce(p_intent, stripe_payment_intent),
    amount_total_cents    = coalesce(p_total, amount_total_cents),
    amount_shipping_cents = coalesce(p_shipping, amount_shipping_cents),
    amount_tax_cents      = coalesce(p_tax, amount_tax_cents),
    email                 = coalesce(p_email, email),
    ship_name             = coalesce(p_ship->>'name', ship_name),
    ship_line1            = coalesce(p_ship->>'line1', ship_line1),
    ship_line2            = coalesce(p_ship->>'line2', ship_line2),
    ship_city             = coalesce(p_ship->>'city', ship_city),
    ship_state            = coalesce(p_ship->>'state', ship_state),
    ship_postal           = coalesce(p_ship->>'postal_code', ship_postal),
    ship_country          = coalesce(p_ship->>'country', ship_country),
    paid_at               = now(),
    updated_at            = now()
  where stripe_session_id = p_session_id
    and state = 'pending'
  returning *;
$$ language sql;

comment on function store_order_mark_paid is
  'Idempotent. Moves pending -> paid for one Stripe session. A replay against a row already past pending updates nothing and returns no row, which the caller treats as success rather than as an error.';

-- ---------------------------------------------------------------------------
-- Claiming an order for submission to the print provider.
--
-- Only a paid order, or one whose submission was OBSERVED to fail, may be
-- claimed. 'submitting' is never claimable, not even when the claim is stale:
-- an abandoned submission may well have reached the provider, and handing it
-- to a second caller is precisely the duplicate parcel this is here to
-- prevent. Stale claims expire to 'submit_uncertain' instead.
-- ---------------------------------------------------------------------------
create or replace function store_order_claim(
  p_order_id   uuid,
  p_attempt_id uuid,
  p_claimed_by text
) returns store_orders as $$
  update store_orders set
    state           = 'submitting',
    attempt_id      = p_attempt_id,
    claimed_by      = p_claimed_by,
    claimed_at      = now(),
    submit_attempts = submit_attempts + 1,
    updated_at      = now()
  where id = p_order_id
    and state in ('paid', 'submit_failed')
  returning *;
$$ language sql;

comment on function store_order_claim is
  'Only paid and observed-failed orders are claimable. A stale submitting claim is never re-claimable; it must be expired to submit_uncertain and reconciled.';

create or replace function store_order_expire_stale_claims(
  p_older_than interval default interval '10 minutes'
) returns setof store_orders as $$
  update store_orders set
    state           = 'submit_uncertain',
    uncertain_since = coalesce(claimed_at, now()),
    attempt_id      = null,
    claimed_by      = null,
    claimed_at      = null,
    last_error      = coalesce(last_error, 'claim abandoned; submission outcome never observed'),
    updated_at      = now()
  where state = 'submitting'
    and claimed_at < now() - p_older_than
  returning *;
$$ language sql;

comment on function store_order_expire_stale_claims is
  'Crash recovery. An abandoned submission is an unknown outcome, not a failed one: uncertain_since is taken from the claim, not from the moment we noticed.';

-- Settling a submission we actually observed succeed.
create or replace function store_order_mark_submitted(
  p_order_id     uuid,
  p_attempt_id   uuid,
  p_provider_id  bigint
) returns store_orders as $$
  update store_orders set
    state             = 'submitted',
    provider_order_id = p_provider_id,
    attempt_id        = null,
    claimed_by        = null,
    claimed_at        = null,
    last_error        = null,
    submitted_at      = now(),
    updated_at        = now()
  where id = p_order_id
    and attempt_id = p_attempt_id
    and state = 'submitting'
  returning *;
$$ language sql;

comment on function store_order_mark_submitted is
  'Requires the matching attempt_id: a caller that lost its claim must not be able to settle the row a later caller now owns.';

-- Settling a refusal we actually observed.
create or replace function store_order_mark_failed(
  p_order_id   uuid,
  p_attempt_id uuid,
  p_error      text
) returns store_orders as $$
  update store_orders set
    state      = 'submit_failed',
    attempt_id = null,
    claimed_by = null,
    claimed_at = null,
    last_error = left(coalesce(p_error, 'unknown'), 500),
    updated_at = now()
  where id = p_order_id
    and attempt_id = p_attempt_id
    and state = 'submitting'
  returning *;
$$ language sql;

comment on function store_order_mark_failed is
  'For an OBSERVED refusal only. A timeout, a socket reset or an ambiguous 5xx is not observed and must go to submit_uncertain instead.';

create or replace function store_order_mark_uncertain(
  p_order_id   uuid,
  p_attempt_id uuid,
  p_error      text
) returns store_orders as $$
  update store_orders set
    state           = 'submit_uncertain',
    uncertain_since = coalesce(claimed_at, now()),
    attempt_id      = null,
    claimed_by      = null,
    claimed_at      = null,
    last_error      = left(coalesce(p_error, 'outcome not observed'), 500),
    updated_at      = now()
  where id = p_order_id
    and attempt_id = p_attempt_id
    and state = 'submitting'
  returning *;
$$ language sql;

comment on function store_order_mark_uncertain is
  'The state that must exist. A submission whose outcome we never saw may have reached the provider; it is reconciled by looking up external_id, never by submitting again.';

-- Adopting an order we find at the provider under our own external_id. This is
-- how an uncertain outcome resolves positively: one match is conclusive
-- immediately, because the order demonstrably exists.
create or replace function store_order_adopt_existing(
  p_order_id    uuid,
  p_provider_id bigint
) returns store_orders as $$
  update store_orders set
    state             = 'submitted',
    provider_order_id = p_provider_id,
    attempt_id        = null,
    claimed_by        = null,
    claimed_at        = null,
    uncertain_since   = null,
    last_error        = null,
    submitted_at      = coalesce(submitted_at, now()),
    updated_at        = now()
  where id = p_order_id
    and state in ('submit_uncertain', 'submitting')
  returning *;
$$ language sql;

comment on function store_order_adopt_existing is
  'Positive evidence settles immediately: exactly one provider order carrying our external_id means the order exists and must not be created again.';
