-- Fighter status events — structured availability, not "injuries".
--
-- NOT APPLIED. This file has never been run against any database.
--
-- WHY A TABLE AND NOT A TAXONOMY LABEL. ufc_news_items already scores an
-- `injury` label, and that label answers "is this article about an injury?".
-- It cannot answer the questions the site needs to ask: is this fighter
-- available, for which bout, since when, replaced by whom, and is it still
-- true? Those are facts with a lifecycle, and a lifecycle needs rows.
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE: NEVER INFER A DIAGNOSIS.
--
-- "Out with an injury" means status_type='injury' and injury_type NULL. Not
-- 'unspecified', not a guess from the weight class, not the last injury this
-- fighter had. Every clinical column below is nullable and every one of them
-- stays NULL unless the cited source states it in words. A wrong body part
-- attributed to a real athlete is a fabricated medical claim about a named
-- person, which is worse than an empty column by a distance that no product
-- benefit closes. The CHECK constraints at the bottom make the unsourced
-- version unrepresentable rather than merely discouraged.

create table if not exists public.ufc_fighter_status_events (
  id uuid primary key default gen_random_uuid(),

  -- WHO ------------------------------------------------------------------
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,

  -- WHAT -----------------------------------------------------------------
  -- Deliberately broader than "injury": the product question is availability,
  -- and a visa denial removes a fighter from a card exactly as an ACL does.
  status_type text not null check (status_type in (
    'injury',            -- physical injury; the specific injury may be unknown
    'illness',           -- illness, infection, medical non-injury
    'withdrawal',        -- off the bout/card; the reason may be unknown
    'replacement',       -- this fighter is stepping IN for someone else
    'suspension',        -- commission, anti-doping, or promotional suspension
    'visa_travel',       -- visa refusal, travel ban, border or passport issue
    'weight_miss',       -- missed weight; bout may proceed at catchweight
    'return',            -- returning to competition after an absence
    'cleared',           -- explicitly medically cleared / resolved by a source
    'other'              -- explicitly sourced availability change, none of the above
  )),

  -- Free-text ONLY where a source said it. Never generated from a template.
  status_detail text,

  -- STATE ----------------------------------------------------------------
  -- 'active'    the condition is current as far as our sources say
  -- 'resolved'  a later sourced event ended it (see resolved_by_event_id)
  -- 'expired'   nothing resolved it, but the bout/event it concerned has passed
  --             — an unresolved withdrawal from a card fought last March is not
  --             a fighter who is still out today, and showing it as one would be
  --             the site inventing a present-tense claim out of stale data
  state text not null default 'active' check (state in ('active', 'resolved', 'expired')),

  -- WHERE IT BITES -------------------------------------------------------
  event_id uuid references public.ufc_events(id) on delete set null,
  bout_id uuid references public.ufc_bouts(id) on delete set null,

  -- For a withdrawal: who came in. For a replacement: who was replaced.
  -- Both nullable, because "X is out" is publishable long before "Y is in".
  replacement_fighter_id uuid references public.ufc_fighters(id) on delete set null,
  replaced_fighter_id uuid references public.ufc_fighters(id) on delete set null,

  -- THE CLINICAL COLUMNS, ALL NULL UNLESS QUOTED -------------------------
  -- injury_type: what the source calls it, lowercased and normalized against a
  --   closed vocabulary ('torn acl', 'broken hand', ...). NOT a diagnosis we
  --   derived, and NOT a category we chose for an unspecified injury.
  -- body_part:   likewise ('knee', 'hand', 'ribs').
  -- injury_side: 'left' | 'right' only when stated.
  -- These three are the fields most likely to be filled in by a well-meaning
  -- future change. The constraint status_requires_source_quote below makes any
  -- value here illegal without the sentence it came from.
  injury_type text,
  body_part text,
  injury_side text check (injury_side in ('left', 'right')),
  -- The exact substring of the source that licensed the clinical fields. If
  -- this is null they must all be null. It is the receipt.
  clinical_quote text,

  expected_return_at date,          -- only when a source gives a date/window
  expected_return_note text,        -- "expected back in the spring", verbatim

  -- PROVENANCE -----------------------------------------------------------
  source_url text not null,                    -- the specific article, never a homepage
  source_name text not null,                   -- 'UFC.com', 'MMA Fighting', ...
  source_kind text not null default 'news' check (source_kind in (
    'official',   -- ufc.com or a promotion-owned surface: preferred for card changes
    'commission', -- athletic commission or anti-doping body
    'news',       -- a verified RSS source in ufc_news_sources
    'manual'      -- entered by an editor, with the URL they were reading
  )),
  news_item_id uuid references public.ufc_news_items(id) on delete set null,
  source_published_at timestamptz,             -- when the SOURCE published it
  detected_at timestamptz not null default now(),  -- when WE first saw it
  effective_at timestamptz,                    -- when the change took effect, if stated

  -- How much of this we are willing to stand behind, 0..1. Set by the
  -- extractor from what it actually matched; never a vibe.
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),

  -- Everything the extractor used to reach its conclusion: the rule that
  -- fired, the matched spans, the title, the linker's decisions. This is what
  -- makes a false positive debuggable six months later without re-fetching a
  -- page that may have changed.
  provenance jsonb not null default '{}'::jsonb,

  -- IDEMPOTENCY ----------------------------------------------------------
  -- sha256 over (fighter, status_type, bout|event, source url, effective day).
  -- The collector is designed to run every 5-15 minutes over a feed window
  -- that overlaps heavily, so the same story arrives many times. This makes
  -- the re-arrival a no-op at the database rather than a judgement call in
  -- the client.
  fingerprint text not null unique,

  -- LIFECYCLE ------------------------------------------------------------
  -- A later event that ends this one ('cleared' resolves 'injury'), and a
  -- later event that corrects it (a follow-up story naming the injury the
  -- first one did not). Self-references, so the history is a chain and
  -- nothing is ever overwritten in place.
  resolved_by_event_id uuid references public.ufc_fighter_status_events(id) on delete set null,
  supersedes_event_id uuid references public.ufc_fighter_status_events(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A clinical claim without the sentence that licensed it is not a fact we
  -- hold. This is the "never infer a diagnosis" rule, in the schema.
  constraint status_clinical_requires_quote check (
    (injury_type is null and body_part is null and injury_side is null)
    or clinical_quote is not null
  ),
  -- A replacement event names who came in; a withdrawal need not.
  constraint status_replacement_needs_subject check (
    status_type <> 'replacement' or replaced_fighter_id is not null or bout_id is not null
  ),
  -- Resolution has to point at the thing that resolved it.
  constraint status_resolved_needs_resolver check (
    state <> 'resolved' or resolved_by_event_id is not null
  )
);

create index if not exists ufc_status_fighter_idx on public.ufc_fighter_status_events (fighter_id, detected_at desc);
create index if not exists ufc_status_event_idx on public.ufc_fighter_status_events (event_id) where event_id is not null;
create index if not exists ufc_status_bout_idx on public.ufc_fighter_status_events (bout_id) where bout_id is not null;
create index if not exists ufc_status_active_idx on public.ufc_fighter_status_events (state, status_type, detected_at desc);
create index if not exists ufc_status_detected_idx on public.ufc_fighter_status_events (detected_at desc);

-- Read path for the site and the API. Joins the names once so no page has to.
create or replace view public.ufc_fighter_status_feed
  with (security_invoker = true) as
select
  s.id,
  s.fighter_id,
  f.name as fighter_name,
  f.espn_athlete_id as fighter_espn_athlete_id,
  f.ufcstats_id as fighter_ufcstats_id,
  f.record_w, f.record_l, f.record_d,
  s.status_type,
  s.status_detail,
  s.state,
  s.event_id,
  e.name as event_name,
  e.event_date,
  s.bout_id,
  s.replacement_fighter_id,
  rf.name as replacement_fighter_name,
  s.replaced_fighter_id,
  pf.name as replaced_fighter_name,
  s.injury_type,
  s.body_part,
  s.injury_side,
  s.clinical_quote,
  s.expected_return_at,
  s.expected_return_note,
  s.source_url,
  s.source_name,
  s.source_kind,
  s.source_published_at,
  s.detected_at,
  s.effective_at,
  s.confidence,
  s.resolved_by_event_id,
  s.supersedes_event_id,
  -- The single timestamp a reader should sort by: when the change happened
  -- according to the source, falling back to when we saw it.
  coalesce(s.effective_at, s.source_published_at, s.detected_at) as occurred_at
from public.ufc_fighter_status_events s
join public.ufc_fighters f on f.id = s.fighter_id
left join public.ufc_events e on e.id = s.event_id
left join public.ufc_fighters rf on rf.id = s.replacement_fighter_id
left join public.ufc_fighters pf on pf.id = s.replaced_fighter_id;

-- One row per fighter: the current availability read, or nothing.
--
-- 'active' only — a resolved or expired event is history, and history must not
-- render as a present-tense claim that someone is unavailable.
--
-- AND a second, independent guard: a card-specific status whose event has
-- already happened is excluded HERE, in the view, regardless of its stored
-- state. The lifecycle pass (scripts/status/lifecycle.mjs) marks such rows
-- 'expired', but that pass is a scheduled job and a scheduled job can be late,
-- can fail, or can be switched off. If the only thing standing between a
-- withdrawal from a card fought last March and today's availability page is a
-- cron that ran, then one missed run publishes a false present-tense claim
-- about a named athlete. The view does not depend on the job having run.
--
-- Non-card statuses (an injury with no event_id, a suspension) are NOT expired
-- by time here: nothing in the passage of time tells us a fighter recovered,
-- and inferring that would be exactly the medical inference this system
-- refuses to make. Those end only when a source says so.
create or replace view public.ufc_fighter_current_status
  with (security_invoker = true) as
select distinct on (s.fighter_id)
  s.fighter_id,
  s.id as status_event_id,
  s.status_type,
  s.status_detail,
  s.injury_type,
  s.body_part,
  s.expected_return_at,
  s.event_id,
  s.bout_id,
  s.source_url,
  s.source_name,
  s.source_kind,
  s.confidence,
  coalesce(s.effective_at, s.source_published_at, s.detected_at) as occurred_at
from public.ufc_fighter_status_events s
left join public.ufc_events e on e.id = s.event_id
where s.state = 'active'
  and s.status_type in ('injury', 'illness', 'withdrawal', 'suspension', 'visa_travel')
  /* Card-specific and the card has passed -> not a current availability claim,
     whatever the stored state says. A null event_date is treated as not-passed:
     an unknown date is not evidence the event happened. */
  and (s.event_id is null or e.event_date is null or e.event_date >= current_date)
order by s.fighter_id,
         coalesce(s.effective_at, s.source_published_at, s.detected_at) desc,
         s.confidence desc,
         s.id;

-- Card changes for one event, in the order a reader wants them.
create or replace view public.ufc_event_card_changes
  with (security_invoker = true) as
select
  s.event_id,
  s.id,
  s.fighter_id,
  f.name as fighter_name,
  f.espn_athlete_id as fighter_espn_athlete_id,
  f.ufcstats_id as fighter_ufcstats_id,
  s.status_type,
  s.state,
  s.bout_id,
  s.replacement_fighter_id,
  rf.name as replacement_fighter_name,
  s.replaced_fighter_id,
  pf.name as replaced_fighter_name,
  s.status_detail,
  s.injury_type,
  s.body_part,
  s.source_url,
  s.source_name,
  s.source_kind,
  s.confidence,
  coalesce(s.effective_at, s.source_published_at, s.detected_at) as occurred_at
from public.ufc_fighter_status_events s
join public.ufc_fighters f on f.id = s.fighter_id
left join public.ufc_fighters rf on rf.id = s.replacement_fighter_id
left join public.ufc_fighters pf on pf.id = s.replaced_fighter_id
where s.event_id is not null
  and s.status_type in ('withdrawal', 'replacement', 'weight_miss', 'injury', 'illness', 'visa_travel', 'suspension');

-- ---------------------------------------------------------------------------
-- ACCESS CONTROL
--
-- RLS on the base table is only half of a guarantee. A view in PostgreSQL runs
-- with the privileges of its OWNER by default, so a view over an RLS-protected
-- table hands every row to anyone who can select from the view — the policies
-- are evaluated as the owner, who is exempt. Three read views over a table of
-- sourced medical and disciplinary claims about named people is exactly where
-- that must not happen.
--
-- security_invoker = true makes each view execute as the CALLER, so the base
-- table's RLS is evaluated against the role that actually asked. Requires
-- PostgreSQL 15+, which this project is on.
--
-- Belt and braces, because the two mechanisms fail differently:
--
--   security_invoker  ensures RLS is applied to the caller. With no policies
--                     defined, anon and authenticated therefore see zero rows
--                     even if they hold SELECT.
--   explicit revoke   removes SELECT from anon/authenticated outright, so the
--                     view is not merely empty for them but inaccessible. This
--                     survives a future policy being added to the table for a
--                     different purpose — a policy written for one reason must
--                     not silently open three views.
--
-- service_role keeps SELECT and bypasses RLS, which is how every server-side
-- read in this repo works (web/lib/status.ts and workers/ufc-api both use the
-- service-role key). Nothing about the server path changes.
alter table public.ufc_fighter_status_events enable row level security;

-- No policies are defined for anon or authenticated. Under RLS that is a
-- default deny, and it is deliberate: this data reaches the public only
-- through the server, which decides what to show and how to caveat it.
revoke all on public.ufc_fighter_status_events from anon, authenticated;
revoke all on public.ufc_fighter_status_feed from anon, authenticated;
revoke all on public.ufc_fighter_current_status from anon, authenticated;
revoke all on public.ufc_event_card_changes from anon, authenticated;

-- The collector inserts and the lifecycle pass updates; nothing deletes.
-- History is never removed, only superseded or expired.
grant select, insert, update on public.ufc_fighter_status_events to service_role;
grant select on public.ufc_fighter_status_feed to service_role;
grant select on public.ufc_fighter_current_status to service_role;
grant select on public.ufc_event_card_changes to service_role;

comment on table public.ufc_fighter_status_events is
  'Structured, individually sourced fighter availability events. Every clinical field is null unless the cited source states it in words: this table records what a source said, never what a condition probably was.';
comment on column public.ufc_fighter_status_events.injury_type is
  'NULL unless the source names the injury. "Out with an injury" is status_type=injury with injury_type NULL, and must stay that way.';
comment on column public.ufc_fighter_status_events.clinical_quote is
  'The source substring that licensed injury_type/body_part/injury_side. Enforced by status_clinical_requires_quote: no quote, no clinical claim.';
comment on column public.ufc_fighter_status_events.fingerprint is
  'Idempotency key for a collector that re-reads an overlapping feed window every few minutes.';
comment on column public.ufc_fighter_status_events.state is
  'expired means the event or bout it concerned has passed with nothing resolving it — history, not a current availability claim.';
comment on view public.ufc_fighter_current_status is
  'At most one active availability row per fighter. Excludes resolved and expired events so a stale withdrawal cannot render as present-tense unavailability.';
