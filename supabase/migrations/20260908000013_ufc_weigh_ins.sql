-- Official weigh-in results — a structured dataset, not a news feed.
--
-- NOT APPLIED. This file has never been run against any database.
-- Depends on 20260908000011_ufc_fighter_status.sql (also not applied).
-- Renumber both together if production moves before integration.
--
-- WHY ITS OWN TABLE. ufc_fighter_status_events already models weight_miss, and
-- that is the right home for "this fighter's availability changed". It is the
-- wrong home for "Jane Doe weighed 158.5 lb at 09:12 against a 156 lb limit,
-- corrected at 09:20 from an earlier 158.0 report". A weight is a measurement
-- with a scale reading, a contractual limit, an attempt number and a
-- correction history; a status event is a claim about availability. Storing
-- the measurement inside the claim would mean every numeric question had to be
-- answered by parsing prose out of a status row.
--
-- So: weights live here, the availability consequence is mirrored into
-- ufc_fighter_status_events as a weight_miss, and the link is by id.
--
-- THE RULE THIS SCHEMA ENFORCES: NEVER INFER A CONTRACTED LIMIT.
--
-- A weight class is not a limit. A lightweight title fight is 155; a
-- non-title lightweight bout is 156 because of the one-pound allowance; a
-- catchweight is whatever the two camps agreed and is frequently not published
-- at all. Deriving "over by 2.5" from a weight class alone produces a number
-- that is wrong exactly when it matters — a fighter shown as missing by a
-- pound they did not miss by, on a page people bet against.
--
-- Hence limit_basis. Every applicable limit records where it came from, and
-- over_by_lbs is only ever computed when the limit is supported. A source that
-- says "missed weight" without a number yields result='missed' with
-- official_weight_lbs, contracted_limit_lbs and over_by_lbs all NULL — the
-- miss is real, the arithmetic is not available, and the page says so.

create table if not exists public.ufc_weigh_in_results (
  id uuid primary key default gen_random_uuid(),

  -- WHO AND WHERE ---------------------------------------------------------
  event_id uuid not null references public.ufc_events(id) on delete cascade,
  bout_id uuid references public.ufc_bouts(id) on delete set null,
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,

  -- THE CONTRACT ----------------------------------------------------------
  -- contracted_limit_lbs is the DIVISION limit (155), allowance_lbs the
  -- non-title allowance (1), and the applicable limit is their sum. Both are
  -- nullable and both stay null unless limit_basis says they are supported.
  contracted_limit_lbs numeric(5,1),
  allowance_lbs numeric(3,1),
  -- Where the limit came from. 'unsupported' is a first-class answer, not a
  -- failure: a catchweight with no published figure is genuinely unknown.
  limit_basis text not null default 'unsupported' check (limit_basis in (
    'sourced',        -- the source stated the contracted limit in words
    'division_rule',  -- standard division + known title status, from the closed table
    'unsupported'     -- catchweight, open weight, unknown division: no limit is derivable
  )),

  -- THE MEASUREMENT -------------------------------------------------------
  -- Null while pending, and null forever for a fighter who withdrew before
  -- stepping on the scale. Never 0 — 0 lb is a reading, absence is not.
  official_weight_lbs numeric(5,1),
  -- 1 for the first trip to the scale, 2 for the second after a failed cut.
  attempt_number int not null default 1 check (attempt_number >= 1),

  result text not null default 'pending' check (result in (
    'pending',    -- expected to weigh in, has not yet
    'made',       -- on or under the applicable limit
    'missed',     -- over it, whether or not we can say by how much
    'cancelled',  -- the bout came off before the scale
    'withdrawn'   -- this fighter came off before the scale
  )),

  -- Computed ONLY when the applicable limit is supported and a weight exists.
  -- A generated column would be wrong here: the inputs can arrive in either
  -- order and a correction may supply the limit after the weight.
  over_by_lbs numeric(4,1),
  -- The agreed catchweight when a missed cut is renegotiated rather than
  -- cancelled. Distinct from contracted_limit_lbs: this is what the bout
  -- BECAME, not what it was.
  catchweight_lbs numeric(5,1),

  weighed_at timestamptz,

  -- PROVENANCE ------------------------------------------------------------
  source_url text not null,
  source_name text not null,
  source_kind text not null default 'news' check (source_kind in (
    'official',    -- ufc.com, the promotion's own live weigh-in page
    'commission',  -- the athletic commission running the event
    'news',        -- an established verified reporting source
    'manual'       -- desk-entered, with the URL the editor was reading
  )),
  source_published_at timestamptz,
  detected_at timestamptz not null default now(),
  -- first_seen_at never moves; last_seen_at advances every time a pass sees
  -- the same unchanged reading again. Together they say "we have been
  -- watching this since 09:12 and it was still true at 09:41", which is what a
  -- live page needs to show honest freshness.
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  -- The exact text the reading was parsed from, plus what the parser matched.
  -- A weight is a number somebody transcribed; the transcription must be
  -- reviewable without re-fetching a page that may have changed.
  raw_text text,
  provenance jsonb not null default '{}'::jsonb,

  -- IDEMPOTENCY -----------------------------------------------------------
  -- sha256 over (fighter, event, attempt, weight, result, source url).
  -- A live pass re-reads the same page every few minutes; an unchanged reading
  -- must be a no-op at the database rather than a judgement in the client.
  fingerprint text not null unique,

  -- CORRECTIONS -----------------------------------------------------------
  -- Corrections are new rows pointing back. Nothing is ever overwritten: a
  -- weight that was reported as 158.0 and corrected to 158.5 must remain
  -- answerable as "we said 158.0 at 09:12 and 158.5 at 09:20", because the
  -- first number was on the page and somebody read it.
  supersedes_id uuid references public.ufc_weigh_in_results(id) on delete set null,
  superseded_at timestamptz,
  correction_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A limit that claims to be supported must carry its number, and one that
  -- does not must not carry an allowance either.
  constraint weighin_limit_basis_consistent check (
    (limit_basis = 'unsupported' and contracted_limit_lbs is null and allowance_lbs is null)
    or (limit_basis <> 'unsupported' and contracted_limit_lbs is not null)
  ),
  -- over_by is arithmetic, so it may only exist when both its operands do.
  -- This is the "never fabricate a delta" rule, in the schema.
  constraint weighin_over_by_needs_inputs check (
    over_by_lbs is null
    or (official_weight_lbs is not null and contracted_limit_lbs is not null)
  ),
  -- A weight of zero is a parser accident, not a reading.
  constraint weighin_weight_is_plausible check (
    official_weight_lbs is null or (official_weight_lbs > 90 and official_weight_lbs < 400)
  ),
  -- made/missed require a scale reading; pending/cancelled/withdrawn must not
  -- have one, because a number beside "pending" reads as a result.
  constraint weighin_result_matches_measurement check (
    (result in ('made', 'missed') and official_weight_lbs is not null)
    or (result in ('pending', 'cancelled', 'withdrawn') and official_weight_lbs is null)
  )
);

create index if not exists ufc_weighin_event_idx on public.ufc_weigh_in_results (event_id, result);
create index if not exists ufc_weighin_bout_idx on public.ufc_weigh_in_results (bout_id) where bout_id is not null;
create index if not exists ufc_weighin_fighter_idx on public.ufc_weigh_in_results (fighter_id, detected_at desc);
create index if not exists ufc_weighin_detected_idx on public.ufc_weigh_in_results (detected_at desc);
-- The projection query: newest live row per fighter per event.
create index if not exists ufc_weighin_current_idx on public.ufc_weigh_in_results (event_id, fighter_id, detected_at desc)
  where superseded_at is null;

-- The link back to availability. A miss is both a measurement and a reason a
-- fighter may not compete; this column is how one weigh-in row owns exactly
-- one status event, so a replaying collector cannot mint a second.
alter table public.ufc_fighter_status_events
  add column if not exists weigh_in_result_id uuid references public.ufc_weigh_in_results(id) on delete set null;
create unique index if not exists ufc_status_weighin_unique
  on public.ufc_fighter_status_events (weigh_in_result_id)
  where weigh_in_result_id is not null;

-- ---------------------------------------------------------------------------
-- READ VIEWS
--
-- security_invoker for the same reason as the status views: a view runs as its
-- OWNER by default, which evaluates the base table's RLS as a role exempt from
-- it and hands every row to anyone holding SELECT. See the access-control
-- block at the foot of this file.

-- The current projection: one row per fighter per event, corrections applied.
create or replace view public.ufc_weigh_in_current
  with (security_invoker = true) as
select distinct on (w.event_id, w.fighter_id)
  w.id,
  w.event_id,
  e.name as event_name,
  e.event_date,
  w.bout_id,
  w.fighter_id,
  f.name as fighter_name,
  f.espn_athlete_id as fighter_espn_athlete_id,
  f.ufcstats_id as fighter_ufcstats_id,
  b.weight_class,
  b.weight_class_raw,
  b.is_womens,
  b.is_title,
  b.card_position,
  b.bout_order,
  b.status as bout_status,
  w.contracted_limit_lbs,
  w.allowance_lbs,
  w.limit_basis,
  -- The number the reader is actually judged against. Null when unsupported,
  -- and the page must render that as "limit not published", never as a blank.
  case when w.contracted_limit_lbs is null then null
       else w.contracted_limit_lbs + coalesce(w.allowance_lbs, 0) end as applicable_limit_lbs,
  w.official_weight_lbs,
  w.attempt_number,
  w.result,
  w.over_by_lbs,
  w.catchweight_lbs,
  w.weighed_at,
  w.source_url,
  w.source_name,
  w.source_kind,
  w.source_published_at,
  w.detected_at,
  w.first_seen_at,
  w.last_seen_at,
  w.raw_text,
  w.supersedes_id,
  -- Whether this reading replaced an earlier one. The page shows the latest
  -- and says a correction happened; it never silently swaps a number.
  (w.supersedes_id is not null) as is_correction
from public.ufc_weigh_in_results w
join public.ufc_events e on e.id = w.event_id
join public.ufc_fighters f on f.id = w.fighter_id
left join public.ufc_bouts b on b.id = w.bout_id
where w.superseded_at is null
order by w.event_id, w.fighter_id, w.attempt_number desc, w.detected_at desc, w.id;

-- Per-event coverage. The page's header numbers come from here rather than
-- being counted in the client, so "X of Y weighed" cannot drift from the rows
-- underneath it.
create or replace view public.ufc_weigh_in_event_summary
  with (security_invoker = true) as
select
  c.event_id,
  c.event_name,
  c.event_date,
  count(*) as expected,
  count(*) filter (where c.result in ('made', 'missed')) as weighed,
  count(*) filter (where c.result = 'made') as made,
  count(*) filter (where c.result = 'missed') as missed,
  count(*) filter (where c.result = 'pending') as pending,
  count(*) filter (where c.result = 'withdrawn') as withdrawn,
  count(*) filter (where c.result = 'cancelled') as cancelled,
  count(*) filter (where c.catchweight_lbs is not null) as catchweights,
  count(*) filter (where c.is_correction) as corrections,
  count(*) filter (where c.limit_basis = 'unsupported') as limit_unsupported,
  max(c.last_seen_at) as last_source_update,
  max(c.source_published_at) as newest_source_published_at,
  min(c.first_seen_at) as first_seen_at
from public.ufc_weigh_in_current c
group by c.event_id, c.event_name, c.event_date;

-- Every reading ever taken, newest first, corrections included. This is the
-- audit trail and the live timeline: nothing is deleted, so the history of a
-- corrected weight is answerable.
create or replace view public.ufc_weigh_in_history
  with (security_invoker = true) as
select
  w.id,
  w.event_id,
  w.bout_id,
  w.fighter_id,
  f.name as fighter_name,
  w.official_weight_lbs,
  w.attempt_number,
  w.result,
  w.over_by_lbs,
  w.catchweight_lbs,
  w.limit_basis,
  w.contracted_limit_lbs,
  w.allowance_lbs,
  w.weighed_at,
  w.source_url,
  w.source_name,
  w.source_kind,
  w.source_published_at,
  w.detected_at,
  w.first_seen_at,
  w.last_seen_at,
  w.supersedes_id,
  w.superseded_at,
  w.correction_reason,
  w.raw_text,
  coalesce(w.weighed_at, w.source_published_at, w.detected_at) as occurred_at
from public.ufc_weigh_in_results w
join public.ufc_fighters f on f.id = w.fighter_id;

-- ---------------------------------------------------------------------------
-- ACCESS CONTROL
--
-- Identical posture to the fighter-status migration, and for the same reason:
-- RLS on the base table is only half a guarantee while a view runs as its
-- owner. security_invoker makes each view execute as the caller; the explicit
-- revokes mean a browser role cannot select at all rather than merely seeing
-- nothing, which survives a policy being added later for another purpose.
--
-- service_role keeps select everywhere and insert/update on the table — the
-- collector inserts, corrections supersede. No delete to anyone: a corrected
-- weight must remain answerable, so removing history must not be expressible.
alter table public.ufc_weigh_in_results enable row level security;

revoke all on public.ufc_weigh_in_results from anon, authenticated;
revoke all on public.ufc_weigh_in_current from anon, authenticated;
revoke all on public.ufc_weigh_in_event_summary from anon, authenticated;
revoke all on public.ufc_weigh_in_history from anon, authenticated;

grant select, insert, update on public.ufc_weigh_in_results to service_role;
grant select on public.ufc_weigh_in_current to service_role;
grant select on public.ufc_weigh_in_event_summary to service_role;
grant select on public.ufc_weigh_in_history to service_role;

comment on table public.ufc_weigh_in_results is
  'Official weigh-in readings with their contractual context and correction history. Corrections are new rows with supersedes_id; nothing is ever overwritten.';
comment on column public.ufc_weigh_in_results.limit_basis is
  'Where the applicable limit came from. A weight class is NOT a limit: title fights, the non-title one-pound allowance and catchweights differ, so unsupported is a first-class answer and over_by_lbs stays null.';
comment on column public.ufc_weigh_in_results.over_by_lbs is
  'Only ever computed when official_weight_lbs and a supported limit both exist. A source saying "missed weight" with no number yields result=missed and this null.';
comment on column public.ufc_weigh_in_results.last_seen_at is
  'Advances each time a pass re-reads the same unchanged value, so the page can show how fresh the confirmation is rather than only when it first arrived.';
comment on view public.ufc_weigh_in_current is
  'One row per fighter per event with corrections applied. Superseded readings are excluded here and preserved in ufc_weigh_in_history.';
