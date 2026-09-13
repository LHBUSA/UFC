-- Live market capture: snapshot history, run attribution, and a first-seen-wins
-- fix that the previous migration got wrong.
--
-- =========================================================================
-- 1. THE BUG THIS FIXES FIRST
-- =========================================================================
--
-- 019 declared UNIQUE (espn_competition_id, kind, round) and relied on it for
-- first-seen-wins. For a round_end that works. For an in_progress it does not:
-- `round` is NULL there, and PostgreSQL treats NULLs as DISTINCT in a unique
-- constraint, so every poll inserted another "first" in-progress row.
--
-- Demonstrated against the live table before writing this: two in_progress rows
-- for one bout, six minutes apart, both accepted by an ON CONFLICT DO NOTHING
-- that silently matched nothing.
--
-- That is not a cosmetic duplicate. PRE-FIGHT CLOSE is defined as the last
-- quote strictly before the first in-progress transition, so a later duplicate
-- would drag the boundary forward and quietly admit post-bell prices as the
-- close -- corrupting the CLV benchmark in the one direction nobody would
-- notice. Replaced with a functional unique index over coalesce(round, 0),
-- which has no NULL to be distinct about.
--
-- =========================================================================
-- 2. WHY A SECOND MARKET TABLE
-- =========================================================================
--
-- ufc_market_observations is CHANGE history and must stay that way: its unique
-- constraint makes a re-read of an unchanged price a database no-op, which is
-- what keeps the archive compact and idempotent. That property is deliberate
-- and is not weakened here.
--
-- But it cannot answer the question the tape asks. "What was the market right
-- after round 2" needs to know we OBSERVED those prices at that moment. A
-- provider fetch returning 352 identical prices writes zero observation rows,
-- so from that table alone the snapshot is indistinguishable from never having
-- looked.
--
-- ufc_market_run_quotes is SNAPSHOT history: every quote in every fetch, once
-- per run, sharing that run's single observed_at. Complementary layers --
--
--   ufc_market_observations   distinct market facts  (compact, deduplicated)
--   ufc_market_run_quotes     what we saw, when      (complete, per fetch)
--
-- =========================================================================
-- Additive and non-destructive. No existing row is modified or deleted; the
-- observations table is not touched at all.
-- =========================================================================

begin;

-- ---- 1. first-seen-wins, actually ---------------------------------------
alter table public.ufc_market_state_transitions
  drop constraint if exists ufc_mst_unique;

-- coalesce(round, 0) gives in_progress a real value to collide on. A partial
-- index would not do: we need one row per (bout, kind) for kinds without a
-- round AND one per (bout, kind, round) for those with one.
create unique index if not exists ufc_mst_unique_idx
  on public.ufc_market_state_transitions (espn_competition_id, kind, (coalesce(round, 0)));

comment on index public.ufc_mst_unique_idx is
  'First-seen-wins. Functional over coalesce(round, 0) because a plain UNIQUE treats NULL rounds as distinct, which allowed a second "first" in_progress per bout and would have moved the pre-fight close past the bell.';

-- ---- 2. run attribution --------------------------------------------------
-- The existing ledger gains the two columns the live lane needs to answer
-- "how much has this card already cost" from persisted rows rather than from
-- isolate memory, which Cloudflare may discard between any two invocations.
alter table public.ufc_market_runs add column if not exists event_id uuid references public.ufc_events(id) on delete set null;
alter table public.ufc_market_runs add column if not exists capture_mode text;

-- Historical rows predate the distinction and are left alone; they are the
-- low-cadence descriptive ingest by definition.
update public.ufc_market_runs set capture_mode = 'descriptive' where capture_mode is null;

alter table public.ufc_market_runs
  add constraint ufc_market_runs_capture_mode_check
  check (capture_mode is null or capture_mode in ('descriptive', 'live'));

create index if not exists ufc_market_runs_event_started_idx on public.ufc_market_runs (event_id, started_at desc);
create index if not exists ufc_market_runs_mode_started_idx on public.ufc_market_runs (capture_mode, started_at desc);

comment on column public.ufc_market_runs.capture_mode is
  'descriptive = the low-cadence CLI ingest. live = the paid per-minute Worker lane. Card spend and call spacing are derived from these rows, never from Worker memory.';

-- ---- 3. snapshot history -------------------------------------------------
create table if not exists public.ufc_market_run_quotes (
  id bigserial primary key,
  run_id bigint not null references public.ufc_market_runs(id) on delete cascade,

  event_id uuid references public.ufc_events(id) on delete set null,
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_a_id uuid references public.ufc_fighters(id),
  fighter_b_id uuid references public.ufc_fighters(id),

  bookmaker_key text not null,
  bookmaker_name text,
  market_key text not null,

  -- The provider's own wording, kept beside the id we resolved it to, so a
  -- bad mapping is auditable after the fact.
  outcome_name text not null,
  outcome_fighter_id uuid references public.ufc_fighters(id),
  price integer not null,
  point numeric,

  source_event_id text,
  commence_time timestamptz,
  source_last_update timestamptz,

  -- ONE timestamp per provider fetch, shared by every row of that run. Taken
  -- once around the request, never per row: one request is one snapshot, and
  -- per-row clocks would split a single reading across timestamps and let a
  -- reader infer movement inside it.
  observed_at timestamptz not null,

  -- One quote per book per outcome per run. A provider payload that repeats a
  -- book is deduplicated within the snapshot; a DIFFERENT run holding the same
  -- price is a separate, wanted row -- that is the whole point of this table.
  constraint ufc_market_run_quotes_unique
    unique (run_id, bout_id, bookmaker_key, market_key, outcome_name)
);

create index if not exists ufc_mrq_bout_observed_idx on public.ufc_market_run_quotes (bout_id, observed_at desc);
create index if not exists ufc_mrq_run_idx on public.ufc_market_run_quotes (run_id);
create index if not exists ufc_mrq_event_observed_idx on public.ufc_market_run_quotes (event_id, observed_at desc);

comment on table public.ufc_market_run_quotes is
  'SNAPSHOT history: every quote in every provider fetch, one row per book/outcome per run, all sharing that run''s single observed_at. Complements ufc_market_observations (CHANGE history), which deduplicates unchanged prices by design. The market tape reads THIS table so "observed after round 2" is true even when nothing moved.';
comment on column public.ufc_market_run_quotes.observed_at is
  'One value per provider fetch, shared by every row of the run. Never per-row.';

alter table public.ufc_market_run_quotes enable row level security;

commit;
