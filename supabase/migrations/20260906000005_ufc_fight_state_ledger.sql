-- PropBetEdge UFC — 005: Fight State Ledger
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. An APPEND-ONLY ledger of immutable fight-week snapshots per
-- bout. Every checkpoint preserves the bout/event state, both fighters'
-- identity + stance + rankings, the Fight DNA snapshot in force, short-notice
-- and replacement state, weigh-in state, the news/wire state around the
-- bout, odds / market consensus / dispersion / line movement, model output,
-- and (after completion) the final result — each block with its own source
-- timestamps. Blocks whose source does not exist yet are stored as an
-- explicit {"status":"unavailable"} object, never as a guessed value.
--
-- Rows are never updated or deleted by application code: the trigger below
-- rejects UPDATE and DELETE. A correction is a new row with checkpoint
-- 'ad_hoc' and a provenance note.

begin;

create table if not exists public.ufc_fight_state_ledger (
  id uuid primary key default gen_random_uuid(),
  bout_id uuid not null references public.ufc_bouts(id) on delete restrict,
  event_id uuid not null references public.ufc_events(id) on delete restrict,
  checkpoint text not null check (checkpoint in (
    't_minus_7d','t_minus_72h','t_minus_24h','post_weigh_in','t_minus_3h','close','post_result','ad_hoc'
  )),
  ledger_version int not null default 1,
  captured_at timestamptz not null default now(),
  scheduled_start timestamptz,           -- ESPN event start when known
  event_date date,
  hours_to_start numeric,                -- (scheduled_start - captured_at) in hours at capture, null when start unknown
  bout_state jsonb not null default '{}'::jsonb,      -- status, card_position, bout_order, scheduled_rounds, is_title, is_main_event, weight_class, is_womens, short_notice_days, replaced_bout_id
  fighters jsonb not null default '{}'::jsonb,        -- {a:{id,name,stance,record,slug_id}, b:{...}}
  rankings jsonb not null default '{"status":"unavailable"}'::jsonb,
  dna jsonb not null default '{"status":"unavailable"}'::jsonb,           -- per fighter: as_of_date, definition_version, coverage, selected metric objects
  weigh_in jsonb not null default '{"status":"unavailable"}'::jsonb,
  wire jsonb not null default '{"status":"unavailable"}'::jsonb,          -- linked ufc_news_items ids/titles/published_at
  odds jsonb not null default '{"status":"unavailable"}'::jsonb,          -- opener/current per book when a provider exists
  market jsonb not null default '{"status":"unavailable"}'::jsonb,        -- consensus, dispersion, movement
  model jsonb not null default '{"status":"unavailable"}'::jsonb,         -- model_version + output once a real model exists
  result jsonb not null default '{"status":"pending"}'::jsonb,            -- winner/method/round/time after completion
  provenance jsonb not null default '{}'::jsonb,      -- per-block source + captured/updated timestamps, builder version
  unique (bout_id, checkpoint, captured_at)
);
create index if not exists ufc_fight_state_ledger_bout_idx
  on public.ufc_fight_state_ledger (bout_id, captured_at desc);
create index if not exists ufc_fight_state_ledger_event_idx
  on public.ufc_fight_state_ledger (event_id, checkpoint, captured_at desc);
create index if not exists ufc_fight_state_ledger_checkpoint_idx
  on public.ufc_fight_state_ledger (checkpoint, captured_at desc);

create or replace function public.ufc_fight_state_ledger_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'ufc_fight_state_ledger is append-only (% rejected)', tg_op;
end;
$$;
drop trigger if exists ufc_fight_state_ledger_no_update on public.ufc_fight_state_ledger;
create trigger ufc_fight_state_ledger_no_update
  before update or delete on public.ufc_fight_state_ledger
  for each row execute function public.ufc_fight_state_ledger_immutable();

comment on table public.ufc_fight_state_ledger is
  'Append-only fight-week snapshots per bout (T-7d, T-72h, T-24h, post-weigh-in, T-3h, close, post-result, ad hoc). Blocks without a source are explicit unavailable objects.';

alter table public.ufc_fight_state_ledger enable row level security;

commit;
