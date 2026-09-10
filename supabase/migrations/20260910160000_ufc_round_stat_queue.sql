-- Round-stat resolution queue
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive: one table. No existing table is altered; no row outside this
-- table is written.
--
-- WHY
-- Eligibility for round stats used to be "a card on the UFC Stats
-- completed-events list we have not linked yet". That list omits Dana White's
-- Contender Series entirely, and a card linked in advance was never looked at
-- again. The authority for "this fight is over" is our own record: a stored
-- result. This table is the explicit queue between that fact and verified
-- round rows, owned by ufc-stats-ingest (docs/ufc_autopilot_ownership.md):
--
--   final bout without round rows -> enqueued
--     -> UFC Stats identity resolved (stored ids, event page, fighter history,
--        completed list only as a cross-check)
--     -> fetched only when source access is allowed
--     -> identities validated -> idempotent write -> state 'written'
--
-- Every state change is a row update with its reason, so "why does this fight
-- have no round data" has a stored answer.

create table if not exists public.ufc_round_stat_queue (
  bout_id                    uuid primary key references public.ufc_bouts(id) on delete cascade,
  event_id                   uuid not null references public.ufc_events(id) on delete cascade,
  state                      text not null default 'queued' check (state in (
                               'queued',               -- final, no round rows, not yet attempted
                               'awaiting_source',      -- identity work needs the source, which is disabled or challenged
                               'identity_review',      -- UFC Stats identity cannot be established safely
                               'not_yet_published',    -- fight page still a pre-result preview
                               'no_round_detail',      -- fight page exists with no stats tables (source answer)
                               'validation_failed',    -- parsed page disagrees with our identities/result
                               'written',              -- round rows written by this lane
                               'written_elsewhere')),  -- rows appeared by another path (backfill/repair)
  ufcstats_event_id          text,
  ufcstats_fight_id          text,
  identity_method            text,          -- stored_bout_id | event_page_pair | fighter_history | completed_list
  identity_evidence          jsonb not null default '{}'::jsonb,
  attempts                   integer not null default 0,
  last_reason                text,
  first_final_seen_at        timestamptz,   -- first run that saw ESPN call the bout final, when known
  enqueued_at                timestamptz not null default now(),
  last_attempt_at            timestamptz,
  next_attempt_at            timestamptz,
  last_unavailable_at        timestamptz,   -- last look that found no round detail (low edge of the latency window)
  source_first_available_at  timestamptz,   -- first look that found rows (high edge)
  written_at                 timestamptz,
  rows_written               integer,
  updated_at                 timestamptz not null default now()
);

create index if not exists ufc_round_stat_queue_due on public.ufc_round_stat_queue (state, next_attempt_at);
create index if not exists ufc_round_stat_queue_event on public.ufc_round_stat_queue (event_id);

comment on table public.ufc_round_stat_queue is
  'Explicit queue from "bout is final" to verified round rows. Sole writer: ufc-stats-ingest. States carry their reason; nothing here is ever a zero row.';

alter table public.ufc_round_stat_queue enable row level security;
revoke all on public.ufc_round_stat_queue from public, anon, authenticated;
grant select, insert, update on public.ufc_round_stat_queue to service_role;

notify pgrst, 'reload schema';
