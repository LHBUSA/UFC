-- ---------------------------------------------------------------------------
-- 016. Event broadcast & start-time layer ("How to Watch").
--
-- UFC.com is the authority for when a card starts and who carries it. Nothing
-- else in this schema holds a start TIME: ufc_events.event_date is a date, and
-- a date cannot answer "what time does the main card start in my timezone".
--
-- One row per UFC.com event, keyed by the promotion's own slug rather than by
-- our ufc_events.id, for two reasons:
--   1. UFC.com publishes cards before they reach our schedule source, so the
--      natural key must exist without a local event.
--   2. A mis-match must degrade to "unlinked broadcast row", never to a lost
--      or wrongly attached one. event_id is nullable and set only on a
--      confident match.
--
-- Canonical times are timestamptz, derived from the unix epoch seconds UFC.com
-- itself publishes in data-*-timestamp attributes. No ET/PT display string is
-- ever the stored truth; the browser localizes from the instant.
-- ---------------------------------------------------------------------------

create table if not exists public.ufc_event_broadcasts (
  id uuid primary key default gen_random_uuid(),

  -- Natural key: the UFC.com event slug, e.g. 'ufc-fight-night-september-12-2026'.
  ufc_slug text not null unique,
  -- Resolved link to our schedule. Null until a confident match exists.
  event_id uuid references public.ufc_events(id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('matched','unmatched','ambiguous')),

  -- Identity as UFC.com states it.
  event_name text not null,          -- branded full name, e.g. 'Noche UFC: Silva vs Delgado'
  event_headline text,               -- listing headline, e.g. 'Silva vs Delgado'
  event_date date,                   -- calendar date of the main card in US Eastern (UFC's own convention)

  venue text,
  city text,
  region text,                       -- state/province as published
  country text,
  location_raw text,                 -- verbatim "City, Region, Country"

  -- Canonical instants. Null means UFC.com has not published that segment.
  early_prelims_start_utc timestamptz,
  prelims_start_utc timestamptz,
  main_card_start_utc timestamptz,

  -- [{provider, region, type, watch_url, segments:[...]}]. Array, never a
  -- single 'network' string: a numbered card routinely has three carriers.
  broadcasts jsonb not null default '[]'::jsonb,

  ufc_event_url text not null,       -- https://www.ufc.com/event/<slug>
  tickets_url text,                  -- official ticketing link when published

  source text not null default 'UFC.com',
  source_url text not null,          -- the page actually fetched
  source_edition text not null default 'www.ufc.com (en-US)',
  parser text not null,              -- e.g. 'ufc-events-listing-v1'

  -- Hash over the comparable fields only (see scripts/broadcast/lib/normalize.mjs).
  content_hash text not null,

  first_seen_at timestamptz not null default now(),
  -- Bumped on EVERY successful authoritative verification, changed or not.
  verified_at timestamptz not null default now(),
  -- Bumped ONLY when content_hash moves. This is the "did the card actually
  -- move" signal the UI and any alerting hang off.
  last_changed_at timestamptz not null default now(),

  updated_at timestamptz not null default now()
);

create index if not exists ufc_event_broadcasts_date_idx on public.ufc_event_broadcasts (event_date);
create index if not exists ufc_event_broadcasts_event_idx on public.ufc_event_broadcasts (event_id);
create index if not exists ufc_event_broadcasts_verified_idx on public.ufc_event_broadcasts (verified_at desc);

-- ---------------------------------------------------------------------------
-- Change ledger. "The main card moved an hour" is a fact readers and we both
-- care about, and last_changed_at alone cannot say WHAT moved.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_event_broadcast_changes (
  id uuid primary key default gen_random_uuid(),
  ufc_slug text not null,
  changed_at timestamptz not null default now(),
  kind text not null check (kind in ('new','time','broadcast','venue','identity','other')),
  field text not null,
  before_value text,
  after_value text,
  run_id uuid
);
create index if not exists ufc_event_broadcast_changes_slug_idx
  on public.ufc_event_broadcast_changes (ufc_slug, changed_at desc);

alter table public.ufc_event_broadcasts          enable row level security;
alter table public.ufc_event_broadcast_changes   enable row level security;
