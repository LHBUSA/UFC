-- Observed fight-state transitions, for timestamping market checkpoints.
--
-- =========================================================================
-- WHAT THIS TABLE IS, AND WHAT IT IS NOT
-- =========================================================================
--
-- It records the instant WE FIRST OBSERVED a bout enter a state. That is not
-- the instant the state occurred. ESPN publishes a status; we poll it; the gap
-- between the horn and our reading is real and unknown, and the whole point of
-- storing observed_at under that name is that nothing downstream can quietly
-- promote it into "the round ended at".
--
-- The market tape reads this table to place its checkpoints, and reports the
-- distance between the transition and the nearest real price -- "observed 23s
-- after round 1" -- rather than presenting a price as a round-close. A column
-- called round_end_at would have invited exactly the claim we refuse to make,
-- so there is no such column.
--
-- =========================================================================
-- FIRST-SEEN-WINS
-- =========================================================================
--
-- A state is recorded once. The Worker polls every minute during a card, so it
-- will see STATUS_END_OF_ROUND period 1 several times in a row; the first
-- reading is the closest to the truth and every later one is strictly worse.
-- The unique constraint plus an ignore-duplicates insert means a repeat is a
-- database no-op, not a newer timestamp overwriting the best evidence we have.
--
-- Append-only is enforced by trigger rather than by convention: no UPDATE and
-- no DELETE, at any time, for any row. A transition that could be edited after
-- the fact is not evidence of anything.
--
-- Additive and non-destructive. No existing table, column, constraint or row is
-- touched; ufc_market_observations is not modified in any way.
-- =========================================================================

begin;

create table if not exists public.ufc_market_state_transitions (
  id bigserial primary key,

  -- ESPN's competition id is the join key the live lane actually has in hand.
  -- bout_id is filled where the lane could resolve it deterministically and
  -- stays null otherwise: a transition is still worth keeping when our own
  -- bout row has not been matched yet, and guessing the bout would be the same
  -- failure this system refuses everywhere else.
  espn_competition_id text not null,
  bout_id uuid references public.ufc_bouts(id) on delete set null,
  event_id uuid references public.ufc_events(id) on delete set null,

  -- 'in_progress' once per bout; 'round_end' once per round.
  kind text not null check (kind in ('in_progress', 'round_end', 'final')),
  -- Present only for round_end, and only when the SOURCE reported a period.
  -- Never parsed out of a status suffix: STATUS_IN_PROGRESS_2 is a status
  -- name, not a round number.
  round int check (round is null or (round between 1 and 5)),
  constraint ufc_mst_round_shape check (
    (kind = 'round_end' and round is not null) or (kind <> 'round_end' and round is null)
  ),

  -- The status string verbatim, so a future change in ESPN's vocabulary is
  -- visible in the data rather than hidden behind our mapping.
  espn_status text not null,

  -- When WE FIRST SAW IT. Not a bell, not a broadcast clock.
  observed_at timestamptz not null default now(),
  -- Server-stamped, so the row's age is checkable independently of the value
  -- the writer supplied for observed_at.
  created_at timestamptz not null default now(),
  -- Says in words what observed_at means, and which worker said so.
  provenance text not null,

  -- First-seen-wins. One row per bout per state; for a round, one per round.
  constraint ufc_mst_unique unique (espn_competition_id, kind, round)
);

create index if not exists ufc_mst_bout_idx on public.ufc_market_state_transitions (bout_id, observed_at);
create index if not exists ufc_mst_event_idx on public.ufc_market_state_transitions (event_id, observed_at);
create index if not exists ufc_mst_observed_idx on public.ufc_market_state_transitions (observed_at desc);

comment on table public.ufc_market_state_transitions is
  'Fight-state transitions as FIRST OBSERVED by the live market lane. observed_at is when we saw the state, never when it occurred. Append-only, first-seen-wins. Read by the market tape to place checkpoints and to report the real distance to the nearest price.';
comment on column public.ufc_market_state_transitions.observed_at is
  'The instant this system first observed the state. NOT the round end. Any reader presenting this as a bell time is wrong.';
comment on column public.ufc_market_state_transitions.round is
  'Only ever the period the source reported. Never inferred from a status name.';

-- ---- append-only ---------------------------------------------------------
-- A transition that can be edited later is not evidence. Both statements are
-- refused outright rather than filtered, so there is no "allowed" update path
-- for a caller to find.
create or replace function public.ufc_market_state_transitions_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'ufc_market_state_transitions is append-only: an observed transition cannot be updated';
  end if;
  raise exception 'ufc_market_state_transitions is append-only: an observed transition cannot be deleted';
end;
$$;

drop trigger if exists ufc_market_state_transitions_append_only_trg on public.ufc_market_state_transitions;
create trigger ufc_market_state_transitions_append_only_trg
  before update or delete on public.ufc_market_state_transitions
  for each row execute function public.ufc_market_state_transitions_append_only();

-- Same posture as every other ufc_* table: RLS on, no policies. The Worker and
-- server-side readers use the service role; there is no anonymous read path.
alter table public.ufc_market_state_transitions enable row level security;

commit;
