-- How a round boundary was evidenced, alongside when we first saw it.
--
-- =========================================================================
-- WHY
-- =========================================================================
--
-- A one-minute poll can miss a short-lived intermission. If we only ever
-- record STATUS_END_OF_ROUND, a round whose break we polled either side of
-- leaves no boundary at all, and the tape silently loses a checkpoint.
--
-- There is a second, weaker but still deterministic piece of ESPN evidence:
-- the bout was active in period N and is later active in period N+1, so round
-- N necessarily ended between those two observations. That is a real fact
-- about ESPN's state, not a second fight clock -- ESPN remains the authority
-- and we are only preserving two different shapes of its evidence.
--
-- The two are NOT equivalent and must never be presented as if they were, so
-- the basis is stored and carried through to the UI:
--
--   espn_end_of_round_status  we saw the end-of-round state itself
--   espn_period_transition    we saw N, then N+1, and inferred the completion
--
-- Neither is a horn time. observed_at still means "when we first saw it", and
-- for the fallback the surrounding sightings are stored too so the size of the
-- uncertainty window is visible rather than implied.
--
-- Additive and non-destructive: three nullable columns and a widened CHECK.
-- No existing row is modified; the first-seen-wins index is untouched.
-- =========================================================================

begin;

alter table public.ufc_market_state_transitions
  add column if not exists boundary_basis text;

-- The two sightings that bracket an inferred completion. Null for a direct
-- end-of-round observation, which needs no bracket.
alter table public.ufc_market_state_transitions
  add column if not exists previous_period_seen_at timestamptz;
alter table public.ufc_market_state_transitions
  add column if not exists next_period_seen_at timestamptz;

-- Existing rows were all written from the direct status path.
update public.ufc_market_state_transitions
  set boundary_basis = 'espn_end_of_round_status'
  where boundary_basis is null and kind = 'round_end';

alter table public.ufc_market_state_transitions
  add constraint ufc_mst_boundary_basis_check
  check (boundary_basis is null or boundary_basis in ('espn_end_of_round_status', 'espn_period_transition'));

-- A round_end must say how it was evidenced. in_progress and final carry no
-- basis: there is nothing inferred about seeing a state directly.
alter table public.ufc_market_state_transitions
  add constraint ufc_mst_basis_shape_check
  check (
    (kind = 'round_end' and boundary_basis is not null)
    or (kind <> 'round_end' and boundary_basis is null)
  );

-- The bracket belongs only to an inferred boundary.
alter table public.ufc_market_state_transitions
  add constraint ufc_mst_bracket_shape_check
  check (
    boundary_basis = 'espn_period_transition'
    or (previous_period_seen_at is null and next_period_seen_at is null)
  );

comment on column public.ufc_market_state_transitions.boundary_basis is
  'How this round completion was evidenced. espn_end_of_round_status = the end-of-round state was observed directly. espn_period_transition = the bout was seen in period N and later in period N+1, so round N ended between them. NEITHER is a horn time.';
comment on column public.ufc_market_state_transitions.previous_period_seen_at is
  'For an inferred boundary: when we last saw the bout in period N. With next_period_seen_at this is the uncertainty window, shown rather than hidden.';

commit;
