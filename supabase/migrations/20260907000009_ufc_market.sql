-- UFC market data. Observations from The Odds API, stored as history.
--
-- The governing decision: this table is append-mostly. We keep every
-- observation rather than the latest price, because the questions worth
-- asking later are all about change - what a price was when we first saw it,
-- how it moved, where it closed - and none of them can be answered from a
-- table that overwrites itself. Storage is cheap; a price we did not keep is
-- gone permanently.
--
-- Nothing here is a prediction. No model output, no edge, no implied value.
-- Market pricing is an independent descriptive layer.

create table if not exists public.ufc_market_observations (
  id bigserial primary key,

  -- Canonical linkage. Resolved deterministically at ingest; a row is never
  -- written with a guessed fighter.
  event_id uuid references public.ufc_events(id) on delete cascade,
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_a_id uuid references public.ufc_fighters(id),
  fighter_b_id uuid references public.ufc_fighters(id),

  bookmaker_key text not null,
  bookmaker_name text,

  -- 'h2h' today. Totals only if the provider actually returns them for MMA.
  market_key text not null,

  -- The outcome exactly as the source named it, kept verbatim beside the id
  -- we resolved it to, so a bad mapping is auditable after the fact.
  outcome_name text not null,
  outcome_fighter_id uuid references public.ufc_fighters(id),

  -- American odds. Integer because that is what the source returns and
  -- rounding a price is a data loss we would never recover.
  price integer not null,
  point numeric,

  -- Provenance from the source.
  source_event_id text not null,
  commence_time timestamptz,
  source_last_update timestamptz,

  observed_at timestamptz not null default now(),

  -- One row per book, market, outcome and source update. A refresh that finds
  -- an unchanged price is therefore a no-op rather than a duplicate, while a
  -- changed price creates history. This is what makes ingest idempotent
  -- without any read-then-write.
  unique (bout_id, bookmaker_key, market_key, outcome_name, source_last_update, price)
);

create index if not exists ufc_market_obs_bout_idx on public.ufc_market_observations (bout_id, observed_at desc);
create index if not exists ufc_market_obs_event_idx on public.ufc_market_observations (event_id, observed_at desc);
create index if not exists ufc_market_obs_book_idx on public.ufc_market_observations (bookmaker_key, observed_at desc);

comment on table public.ufc_market_observations is
  'Append-mostly market observations from The Odds API. History is the product: never overwrite, never delete. Descriptive pricing only - no model output, no edge, no value claim.';
comment on column public.ufc_market_observations.outcome_name is
  'The source''s own wording, kept beside outcome_fighter_id so a mis-resolution can be found later.';
comment on constraint ufc_market_observations_bout_id_bookmaker_key_market_key_out_key on public.ufc_market_observations is
  'Idempotency: re-ingesting an unchanged price is rejected by the database, a changed price is new history.';

-- Source events we fetched but could not resolve to a canonical bout. Kept
-- rather than dropped, because a silently discarded event is indistinguishable
-- from an event the provider never listed, and the two need different fixes.
create table if not exists public.ufc_market_unmatched (
  id bigserial primary key,
  source_event_id text not null,
  sport_key text not null,
  commence_time timestamptz,
  home_team text,
  away_team text,
  reason text not null,
  detail jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved boolean not null default false,
  unique (source_event_id, reason)
);

comment on table public.ufc_market_unmatched is
  'Source events with no canonical bout, or with an ambiguous fighter. Fail-closed landing zone: a price is never attached on a guess.';

-- Run ledger, so quota consumption is measurable rather than estimated.
create table if not exists public.ufc_market_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'failed', 'skipped')),
  sport_key text,
  markets text,
  source_events integer default 0,
  matched_bouts integer default 0,
  unmatched_events integer default 0,
  observations_written integer default 0,
  books_seen integer default 0,
  -- Straight from the provider's response headers: what this actually cost.
  quota_used integer,
  quota_remaining integer,
  last_cost integer,
  notes jsonb,
  error text
);

comment on column public.ufc_market_runs.quota_remaining is
  'From x-requests-remaining. Measured, not estimated: the cadence is only defensible if the cost is observed.';

alter table public.ufc_market_observations enable row level security;
alter table public.ufc_market_unmatched enable row level security;
alter table public.ufc_market_runs enable row level security;
