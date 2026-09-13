-- UFC Legacy / Origins data model. ADDITIVE AND NON-DESTRUCTIVE.
--
-- =========================================================================
-- THE RULE THIS MIGRATION EXISTS TO ENFORCE
-- =========================================================================
--
-- History is not fixed by overwriting what was imported. Every column that
-- already exists keeps its value and its meaning: ufc_bout_results.round is
-- still the round number the source printed, time_format is still verbatim,
-- weight_class_raw and is_title are still what the source said. The corrected
-- interpretation lives BESIDE the raw value, in new columns, so the system can
-- answer both "what did the source say?" and "how does PropBetEdge read it?".
--
-- The misreading being corrected: UFCStats (and ESPN, same lineage) stores an
-- untimed 1993 tournament bout as "Round 1" and the overtime period of a 1997
-- bout as "Round 2". Neither is a modern round. "No Time Limit" is not a round
-- structure, and this schema never translates it into one.
--
-- =========================================================================
-- WHAT IT ADDS
-- =========================================================================
--
--   1. public.ufc_time_format_structure(text)  parser for the verbatim format
--   2. ufc_bout_results  period semantics beside round/time_sec/time_format
--   3. ufc_bout_round_stats_periods (view)     each stat row labelled as the
--                                              period it really is
--   4. ufc_bouts         ruleset link (combat_rulesets) + historical division
--                        and title semantics beside weight_class/is_title
--   5. ufc_event_fact_keys / ufc_event_fact_claims / ufc_event_fact_resolutions
--                        provenance-first claims; display resolved separately
--   6. ufc_tournaments / ufc_tournament_entries / ufc_tournament_advancements
--   7. ufc_legacy_repair_ledger                before/after image of every
--                                              canonical row a repair touches
--   8. combat_sources    nsac, nj_sacb, pbe_legacy_curated (reference rows)
--   9. ufc_videos        video_type 'event_replay' (external Fight Pass refs)
--
-- Nothing is dropped. The only constraint replaced is ufc_videos'
-- video_type check, widened to a strict superset.
--
-- Privilege posture matches ufc_identity_reconciliations and the combat
-- hardening: RLS on, no policies, nothing for anon/authenticated, no DELETE or
-- TRUNCATE for service_role on claims, tournaments or the ledger. Views are
-- security_invoker (see 20260908000014 for why the default is a bypass).
-- =========================================================================

begin;

-- -------------------------------------------------------------------------
-- 1. Verbatim time format -> structure.
-- -------------------------------------------------------------------------
-- Formats seen in the archive: "No Time Limit", "1 Rnd (20)",
-- "1 Rnd + OT (12-3)", "1 Rnd + 2OT (15-3-3)", "3 Rnd (5-5-5)", "2 Rnd (5-5)".
-- Anything else returns structure 'unparsed' so it can never be guessed at.
--
--   untimed              no clock; the fight is one whole-fight period
--   single_period        one timed regulation period, no overtime
--   regulation_overtime  one regulation period plus 1..n overtime periods
--   rounds               two or more timed rounds
create or replace function public.ufc_time_format_structure(fmt text)
returns table (structure text, period_secs int[], overtime_count int)
language plpgsql immutable
set search_path = pg_catalog
as $fn$
declare
  m text[];
  mins int[];
  n_rounds int;
  n_ot int;
begin
  if fmt is null or btrim(fmt) = '' then
    return query select 'unparsed'::text, null::int[], null::int; return;
  end if;
  if btrim(fmt) ~* '^no time limit$' then
    return query select 'untimed'::text, null::int[], 0; return;
  end if;
  m := regexp_match(btrim(fmt), '^(\d+)\s*Rnds?\s*(?:\+\s*(\d*)\s*OT\s*)?\(([\d\s-]+)\)$', 'i');
  if m is null then
    return query select 'unparsed'::text, null::int[], null::int; return;
  end if;
  n_rounds := m[1]::int;
  n_ot := case when m[2] is null then 0 when m[2] = '' then 1 else m[2]::int end;
  select array_agg(x::int * 60 order by ord) into mins
    from unnest(string_to_array(regexp_replace(m[3], '\s', '', 'g'), '-')) with ordinality as t(x, ord);
  if mins is null or array_length(mins, 1) <> n_rounds + n_ot then
    return query select 'unparsed'::text, null::int[], null::int; return;
  end if;
  if n_ot > 0 then
    if n_rounds <> 1 then
      return query select 'unparsed'::text, null::int[], null::int; return;
    end if;
    return query select 'regulation_overtime'::text, mins, n_ot; return;
  end if;
  if n_rounds = 1 then
    return query select 'single_period'::text, mins, 0; return;
  end if;
  return query select 'rounds'::text, mins, 0;
end
$fn$;

comment on function public.ufc_time_format_structure(text) is
  'Parses a verbatim UFCStats/ESPN time format. untimed = No Time Limit (never a round). Returns unparsed rather than guessing.';

-- -------------------------------------------------------------------------
-- 2. Result period semantics. Raw round/time_sec/time_format are untouched.
-- -------------------------------------------------------------------------
alter table public.ufc_bout_results
  add column if not exists period_structure text,
  add column if not exists ending_period_kind text,
  add column if not exists ending_period_number smallint,
  add column if not exists elapsed_fight_sec int,
  add column if not exists period_semantics_basis text,
  add column if not exists period_semantics_version smallint;

alter table public.ufc_bout_results
  add constraint ufc_bout_results_period_structure_check
    check (period_structure is null or period_structure in ('untimed','single_period','regulation_overtime','rounds')),
  add constraint ufc_bout_results_ending_period_kind_check
    check (ending_period_kind is null or ending_period_kind in ('whole_fight','regulation_period','overtime','round')),
  add constraint ufc_bout_results_ending_period_number_check
    check (ending_period_number is null or ending_period_number between 1 and 10),
  add constraint ufc_bout_results_elapsed_check
    check (elapsed_fight_sec is null or elapsed_fight_sec >= 0),
  -- The interpretation must be internally coherent or absent. Every field is
  -- required explicitly: a CHECK that evaluates to NULL passes, so a bare
  -- "kind = 'whole_fight'" would let a half-filled interpretation through.
  add constraint ufc_bout_results_period_semantics_coherent check (
    (period_structure is null and ending_period_kind is null and ending_period_number is null and elapsed_fight_sec is null)
    or (period_structure is not null and ending_period_kind is not null and ending_period_number is not null and elapsed_fight_sec is not null
        and (   (period_structure = 'untimed'             and ending_period_kind = 'whole_fight'       and ending_period_number = 1)
             or (period_structure = 'single_period'       and ending_period_kind = 'regulation_period' and ending_period_number = 1)
             or (period_structure = 'regulation_overtime' and ending_period_kind = 'regulation_period' and ending_period_number = 1)
             or (period_structure = 'regulation_overtime' and ending_period_kind = 'overtime')
             or (period_structure = 'rounds'              and ending_period_kind = 'round')))
  );

comment on column public.ufc_bout_results.round is
  'RAW. The period number the source printed. For untimed or overtime-era bouts this is NOT a modern round; read ending_period_kind.';
comment on column public.ufc_bout_results.period_structure is
  'Interpretation of time_format: untimed | single_period | regulation_overtime | rounds. Null = not yet interpreted.';
comment on column public.ufc_bout_results.ending_period_kind is
  'Interpretation of raw round: whole_fight (untimed), regulation_period, overtime, round.';
comment on column public.ufc_bout_results.ending_period_number is
  '1 for whole_fight/regulation_period; overtime index for overtime; round number for rounds.';
comment on column public.ufc_bout_results.elapsed_fight_sec is
  'Total fight duration in seconds derived from the structure, raw round and time_sec.';

-- -------------------------------------------------------------------------
-- 3. Round-stat rows labelled as the period they really are. Derived, not
--    stored: a stored copy of the label is a second truth that can disagree.
-- -------------------------------------------------------------------------
create or replace view public.ufc_bout_round_stats_periods
with (security_invoker = true) as
select
  s.*,
  r.period_structure,
  case
    when r.period_structure = 'untimed'             and s.round = 1 then 'whole_fight'
    when r.period_structure = 'single_period'       and s.round = 1 then 'regulation_period'
    when r.period_structure = 'regulation_overtime' and s.round = 1 then 'regulation_period'
    when r.period_structure = 'regulation_overtime' and s.round > 1 then 'overtime'
    when r.period_structure = 'rounds'                              then 'round'
    else null
  end as period_kind,
  case
    when r.period_structure = 'regulation_overtime' and s.round > 1 then s.round - 1
    when r.period_structure in ('untimed','single_period','regulation_overtime','rounds') then s.round
    else null
  end as period_number,
  case
    when r.period_structure = 'untimed'             and s.round = 1 then 'Whole fight'
    when r.period_structure in ('single_period','regulation_overtime') and s.round = 1 then 'Regulation'
    when r.period_structure = 'regulation_overtime' and s.round = 2 then 'Overtime'
    when r.period_structure = 'regulation_overtime' and s.round > 2 then 'Overtime ' || (s.round - 1)::text
    when r.period_structure = 'rounds'                              then 'Round ' || s.round::text
    else null
  end as period_label
from public.ufc_bout_round_stats s
left join public.ufc_bout_results r on r.bout_id = s.bout_id;

comment on view public.ufc_bout_round_stats_periods is
  'ufc_bout_round_stats with the period each row really measures. period_kind null = the result has no interpretation yet; never display such a row as a modern round.';

-- -------------------------------------------------------------------------
-- 4. Bouts: ruleset link + historical division/title semantics.
-- -------------------------------------------------------------------------
alter table public.ufc_bouts
  add column if not exists ruleset_id uuid,
  add column if not exists ruleset_basis text,
  add column if not exists historical_weight_limit_text text,
  add column if not exists historical_weight_min_lbs numeric(6,2),
  add column if not exists historical_weight_max_lbs numeric(6,2),
  add column if not exists historical_limit_basis text,
  add column if not exists historical_division_label text,
  add column if not exists title_kind text,
  add column if not exists title_label_raw text,
  add column if not exists historical_semantics_evidence jsonb not null default '{}'::jsonb;

alter table public.ufc_bouts
  add constraint ufc_bouts_ruleset_id_fkey
    foreign key (ruleset_id) references public.combat_rulesets(id) on delete restrict,
  add constraint ufc_bouts_historical_limit_basis_check
    check (historical_limit_basis is null or historical_limit_basis in ('source_stated','rule_document','unknown')),
  add constraint ufc_bouts_historical_limit_range_check
    check (historical_weight_min_lbs is null or historical_weight_max_lbs is null or historical_weight_min_lbs <= historical_weight_max_lbs),
  -- A normalized limit is only stored when a source states it (coalesce: a
  -- NULL basis must fail, not pass).
  add constraint ufc_bouts_historical_limit_needs_basis
    check ((historical_weight_min_lbs is null and historical_weight_max_lbs is null) or coalesce(historical_limit_basis, '') in ('source_stated','rule_document')),
  add constraint ufc_bouts_title_kind_check
    check (title_kind is null or title_kind in ('none','tournament','superfight','championship','interim'));

create index if not exists ufc_bouts_ruleset_idx on public.ufc_bouts (ruleset_id) where ruleset_id is not null;
create index if not exists ufc_bouts_title_kind_idx on public.ufc_bouts (title_kind) where title_kind is not null and title_kind <> 'none';

comment on column public.ufc_bouts.weight_class is
  'MODERN normalized division. For bouts before the division names settled (UFC 12-era "Lightweight" = 199 lb and under) read historical_division_label / historical_weight_*.';
comment on column public.ufc_bouts.is_title is
  'RAW source title flag. A tournament final and a belt fight both set it; read title_kind for what the title was.';
comment on column public.ufc_bouts.title_kind is
  'none | tournament | superfight | championship | interim. Null = not yet interpreted.';
comment on column public.ufc_bouts.historical_weight_limit_text is
  'The weight limit as the period source worded it, e.g. "199 and under". Verbatim.';

-- -------------------------------------------------------------------------
-- 5. Event fact claims. Provenance first; display resolved separately.
-- -------------------------------------------------------------------------
create table if not exists public.ufc_event_fact_keys (
  fact_key text primary key check (fact_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  value_type text not null check (value_type in ('integer','money_usd','text','person','date','boolean','json')),
  scope text not null check (scope in ('event','bout')),
  description text not null
);

insert into public.ufc_event_fact_keys (fact_key, value_type, scope, description) values
  ('attendance',          'integer',   'event', 'Total attendance as the source states it'),
  ('paid_attendance',     'integer',   'event', 'Paid attendance'),
  ('gate_usd',            'money_usd', 'event', 'Gate receipts in USD as reported'),
  ('buy_rate',            'integer',   'event', 'Pay-per-view buys'),
  ('venue_name',          'text',      'event', 'Venue name as the source names it (sources may use a later name)'),
  ('venue_city',          'text',      'event', 'Venue city as the source states it'),
  ('promotional_name',    'text',      'event', 'Promotional / alternate event name'),
  ('promoter_entity',     'text',      'event', 'Licensed promoter entity (e.g. on a commission sheet)'),
  ('ownership_era',       'text',      'event', 'Promotion owner at the time (e.g. SEG, Zuffa)'),
  ('sanctioning_body',    'text',      'event', 'Commission or authority that sanctioned the event'),
  ('broadcast_carrier',   'text',      'event', 'Broadcast / pay-per-view carrier'),
  ('commentator',         'person',    'event', 'On-air commentator'),
  ('ring_announcer',      'person',    'event', 'Octagon announcer'),
  ('referee',             'person',    'bout',  'Referee of a bout'),
  ('judge',               'person',    'bout',  'Judge of a bout (only where the source names one)'),
  ('judge_score',         'json',      'bout',  'One judge''s score for a bout: {"judge":..,"fighter_a":..,"fighter_b":..}'),
  ('timekeeper',          'person',    'bout',  'Timekeeper'),
  ('official_weight_lbs', 'json',      'bout',  'Official weight: {"fighter_id":..,"lbs":..}'),
  ('medical_suspension',  'json',      'bout',  'Medical suspension: {"fighter_id":..,"days":..,"note":..}'),
  ('result_summary',      'json',      'bout',  'Official result as a commission sheet records it'),
  ('historical_label',    'text',      'event', 'A historical label a source attaches to the event')
on conflict (fact_key) do nothing;

create table if not exists public.ufc_event_fact_claims (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.ufc_events(id) on delete restrict,
  bout_id uuid references public.ufc_bouts(id) on delete restrict,
  fact_key text not null references public.ufc_event_fact_keys(fact_key) on delete restrict,

  raw_value text not null,                -- exactly as the source rendered it
  normalized_value jsonb,                 -- typed reading, when one is safe

  source_id uuid references public.combat_sources(id) on delete restrict,
  source_type text not null check (source_type in (
    'commission_record','public_record','espn','ufcstats','promotion_official',
    'archive_capture','curated_secondary','reference_lead','internal_derivation')),
  -- 1 commission/public record · 2 structured provider (ESPN, UFCStats)
  -- 3 official promotion material · 4 secondary reference · 5 discovery lead
  source_tier smallint not null check (source_tier between 1 and 5),
  source_name text not null,
  source_url text,
  source_locator text,                    -- page/line/file + sha256 of the captured document
  captured_at timestamptz not null,

  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','corroborated','verified','disputed','rejected')),
  conflict_group text,
  conflict_state text not null default 'none' check (conflict_state in ('none','open','resolved')),
  notes text,

  claim_hash text not null unique,        -- sha256 of (event, bout, key, raw_value, source_type, source_url, locator)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ufc_event_fact_claims_has_reference check (source_url is not null or source_locator is not null),
  constraint ufc_event_fact_claims_conflict_group_needed check (conflict_state = 'none' or conflict_group is not null),
  -- Promotion material is never tier 1 or 2 evidence.
  constraint ufc_event_fact_claims_promotion_tier check (source_type <> 'promotion_official' or source_tier >= 3),
  constraint ufc_event_fact_claims_commission_tier check (source_type not in ('commission_record','public_record') or source_tier = 1),
  unique (id, event_id, fact_key)
);

create index if not exists ufc_event_fact_claims_event_idx on public.ufc_event_fact_claims (event_id, fact_key);
create index if not exists ufc_event_fact_claims_bout_idx on public.ufc_event_fact_claims (bout_id) where bout_id is not null;
create index if not exists ufc_event_fact_claims_conflict_idx on public.ufc_event_fact_claims (conflict_group) where conflict_group is not null;

-- A claim is evidence. It is never deleted and what it says never changes;
-- only its review state may move.
create or replace function public.ufc_event_fact_claims_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'ufc_event_fact_claims is append-only: claim % cannot be deleted (reject it instead)', old.id;
  end if;
  if (new.event_id, new.bout_id, new.fact_key, new.raw_value, new.normalized_value, new.source_id, new.source_type,
      new.source_tier, new.source_name, new.source_url, new.source_locator, new.captured_at, new.claim_hash)
     is distinct from
     (old.event_id, old.bout_id, old.fact_key, old.raw_value, old.normalized_value, old.source_id, old.source_type,
      old.source_tier, old.source_name, old.source_url, old.source_locator, old.captured_at, old.claim_hash) then
    raise exception 'ufc_event_fact_claims: claim % is immutable evidence; only verification_status, conflict_*, notes may change', old.id;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists ufc_event_fact_claims_guard on public.ufc_event_fact_claims;
create trigger ufc_event_fact_claims_guard
  before update or delete on public.ufc_event_fact_claims
  for each row execute function public.ufc_event_fact_claims_guard();

create table if not exists public.ufc_event_fact_resolutions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.ufc_events(id) on delete restrict,
  bout_id uuid references public.ufc_bouts(id) on delete restrict,
  fact_key text not null references public.ufc_event_fact_keys(fact_key) on delete restrict,
  selected_claim_id uuid not null,
  resolution_rule text not null check (resolution_rule in ('sole_claim','highest_tier','commission_authority','corroborated_majority','operator_decision')),
  resolved_by text not null,
  resolved_at timestamptz not null default now(),
  notes text,
  -- The selected claim must be a claim about this event and this fact.
  constraint ufc_event_fact_resolutions_claim_fkey
    foreign key (selected_claim_id, event_id, fact_key)
    references public.ufc_event_fact_claims (id, event_id, fact_key) on delete restrict
);

create unique index if not exists ufc_event_fact_resolutions_one_per_fact
  on public.ufc_event_fact_resolutions (event_id, coalesce(bout_id, '00000000-0000-0000-0000-000000000000'::uuid), fact_key);

-- Display may not silently side with promotion material against a
-- disagreeing claim from any other source, and never with a rejected claim.
create or replace function public.ufc_event_fact_resolutions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
declare
  c public.ufc_event_fact_claims%rowtype;
  rival int;
begin
  select * into c from public.ufc_event_fact_claims where id = new.selected_claim_id;
  if c.bout_id is distinct from new.bout_id then
    raise exception 'resolution bout_id % does not match claim bout_id %', new.bout_id, c.bout_id;
  end if;
  if c.verification_status = 'rejected' then
    raise exception 'cannot resolve % to rejected claim %', new.fact_key, c.id;
  end if;
  if c.source_type = 'promotion_official' and new.resolution_rule <> 'operator_decision' then
    select count(*) into rival from public.ufc_event_fact_claims o
     where o.event_id = c.event_id and o.bout_id is not distinct from c.bout_id and o.fact_key = c.fact_key
       and o.id <> c.id and o.source_type <> 'promotion_official' and o.verification_status <> 'rejected'
       and o.raw_value is distinct from c.raw_value;
    if rival > 0 then
      raise exception 'promotion_official claim % conflicts with % other claim(s); only an operator_decision may select it', c.id, rival;
    end if;
  end if;
  return new;
end
$fn$;

drop trigger if exists ufc_event_fact_resolutions_guard on public.ufc_event_fact_resolutions;
create trigger ufc_event_fact_resolutions_guard
  before insert or update on public.ufc_event_fact_resolutions
  for each row execute function public.ufc_event_fact_resolutions_guard();

create or replace view public.ufc_event_fact_display
with (security_invoker = true) as
select r.event_id, r.bout_id, r.fact_key, c.raw_value, c.normalized_value,
       c.source_type, c.source_tier, c.source_name, c.source_url, c.verification_status,
       r.resolution_rule, r.resolved_at,
       (select count(*) from public.ufc_event_fact_claims o
         where o.event_id = r.event_id and o.bout_id is not distinct from r.bout_id and o.fact_key = r.fact_key
           and o.id <> c.id and o.verification_status <> 'rejected') as other_claims
from public.ufc_event_fact_resolutions r
join public.ufc_event_fact_claims c on c.id = r.selected_claim_id;

comment on table public.ufc_event_fact_claims is
  'Provenance-first, append-only claims about legacy event/bout facts. Competing claims coexist; nothing is overwritten by a stronger source.';
comment on table public.ufc_event_fact_resolutions is
  'Which claim is displayed for an event fact, and by what rule. Separate from the claims so a resolution can change without touching evidence.';

-- -------------------------------------------------------------------------
-- 6. Tournaments. Advancement is not always a bout.
-- -------------------------------------------------------------------------
create table if not exists public.ufc_tournaments (
  id uuid primary key default gen_random_uuid(),
  tournament_key text not null unique check (tournament_key ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  event_id uuid not null references public.ufc_events(id) on delete restrict,
  name text not null,
  division_label_raw text,                 -- as the period source named it
  historical_weight_limit_text text,
  bracket_size smallint not null check (bracket_size in (4, 8, 16)),
  winner_fighter_id uuid references public.ufc_fighters(id) on delete restrict,
  completeness text not null check (completeness in ('full','structure_complete','partial')),
  status text not null default 'review' check (status in ('verified','sourced','review','retracted')),
  source_tier smallint not null check (source_tier between 1 and 5),
  sources jsonb not null default '[]'::jsonb,   -- [{url, tier, locator, captured_at}]
  conflict_notes text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ufc_tournaments_event_idx on public.ufc_tournaments (event_id);

create table if not exists public.ufc_tournament_entries (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.ufc_tournaments(id) on delete restrict,
  fighter_id uuid references public.ufc_fighters(id) on delete restrict,
  -- An entrant whose identity is still in review is held by the queue row,
  -- never by an invented fighter id.
  identity_review_id uuid references public.ufc_alias_review_queue(id) on delete restrict,
  raw_name text not null,
  entry_role text not null check (entry_role in ('entrant','alternate')),
  bracket_slot smallint check (bracket_slot between 1 and 16),
  exit_stage text check (exit_stage in ('round_of_16','quarterfinal','semifinal','final','alternate_bout','did_not_compete')),
  exit_reason text check (exit_reason in ('won_tournament','lost_bout','withdrew','injured','unable_to_continue','not_called_upon','disqualified','unknown')),
  status text not null default 'review' check (status in ('verified','sourced','review','retracted')),
  sources jsonb not null default '[]'::jsonb,
  conflict_notes text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ufc_tournament_entries_identity check (fighter_id is not null or identity_review_id is not null)
);

create unique index if not exists ufc_tournament_entries_fighter_uniq
  on public.ufc_tournament_entries (tournament_id, fighter_id) where fighter_id is not null;
create index if not exists ufc_tournament_entries_tournament_idx on public.ufc_tournament_entries (tournament_id);

create table if not exists public.ufc_tournament_advancements (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.ufc_tournaments(id) on delete restrict,
  stage text not null check (stage in ('round_of_16','quarterfinal','semifinal','final','alternate_bout')),
  sequence smallint not null default 1 check (sequence between 1 and 16),
  entry_id uuid not null references public.ufc_tournament_entries(id) on delete restrict,
  opponent_entry_id uuid references public.ufc_tournament_entries(id) on delete restrict,
  advancement_kind text not null check (advancement_kind in (
    'bout_win','bout_loss','bye','walkover','withdrawal_replacement','alternate_insertion','default_win','no_contest','other')),
  bout_id uuid references public.ufc_bouts(id) on delete restrict,   -- NULL for every non-bout advancement
  advances_to_stage text check (advances_to_stage in ('quarterfinal','semifinal','final','champion')),
  replaces_entry_id uuid references public.ufc_tournament_entries(id) on delete restrict,
  reason_raw text,
  status text not null default 'review' check (status in ('verified','sourced','review','retracted')),
  source_tier smallint not null check (source_tier between 1 and 5),
  sources jsonb not null default '[]'::jsonb,
  conflict_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A fought advancement names its bout; a non-bout advancement may not
  -- borrow one, so a bye can never be dressed up as a fight.
  constraint ufc_tournament_advancements_bout_rule check (
    (advancement_kind in ('bout_win','bout_loss','no_contest') and bout_id is not null)
    or (advancement_kind in ('bye','walkover','withdrawal_replacement','alternate_insertion','default_win') and bout_id is null)
    or advancement_kind = 'other'),
  constraint ufc_tournament_advancements_replacement_rule check (
    advancement_kind <> 'withdrawal_replacement' or replaces_entry_id is not null),
  constraint ufc_tournament_advancements_not_self check (opponent_entry_id is null or opponent_entry_id <> entry_id)
);

create unique index if not exists ufc_tournament_advancements_uniq
  on public.ufc_tournament_advancements (tournament_id, stage, sequence, entry_id);
create index if not exists ufc_tournament_advancements_bout_idx
  on public.ufc_tournament_advancements (bout_id) where bout_id is not null;

-- Entries and bouts must belong to the tournament's own event.
create or replace function public.ufc_tournament_advancements_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
declare
  t_event uuid;
  b_event uuid;
  bad int;
begin
  select event_id into t_event from public.ufc_tournaments where id = new.tournament_id;
  select count(*) into bad from public.ufc_tournament_entries e
   where e.id in (new.entry_id, new.opponent_entry_id, new.replaces_entry_id) and e.tournament_id <> new.tournament_id;
  if bad > 0 then
    raise exception 'advancement % references an entry from another tournament', new.id;
  end if;
  if new.bout_id is not null then
    select event_id into b_event from public.ufc_bouts where id = new.bout_id;
    if b_event is distinct from t_event then
      raise exception 'advancement bout % is not on the tournament event', new.bout_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists ufc_tournament_advancements_guard on public.ufc_tournament_advancements;
create trigger ufc_tournament_advancements_guard
  before insert or update on public.ufc_tournament_advancements
  for each row execute function public.ufc_tournament_advancements_guard();

comment on table public.ufc_tournaments is 'One-night UFC tournaments (UFC 1-17, Ultimate Ultimate, Ultimate Japan, UFC 23). Bracket graph source of truth; not derived from bout_order.';
comment on table public.ufc_tournament_advancements is 'How an entrant moved through a bracket. bout_id is NULL for byes, walkovers, replacements and defaults: those are never fabricated as bouts.';

-- -------------------------------------------------------------------------
-- 7. Repair ledger: before/after of every canonical row a legacy repair
--    inserts or changes. Append-only.
-- -------------------------------------------------------------------------
create table if not exists public.ufc_legacy_repair_ledger (
  id bigserial primary key,
  plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  step text not null check (step in (
    'ufc1_ingest','period_semantics','event_ids_venue','judge_fields','rulesets',
    'tournaments','commission_facts','video_refs','portraits','division_title')),
  table_name text not null,
  row_key jsonb not null,
  operation text not null check (operation in ('insert','update')),
  before_image jsonb,
  after_image jsonb not null,
  evidence jsonb not null default '{}'::jsonb,
  operator text not null,
  applied_at timestamptz not null default now(),
  constraint ufc_legacy_repair_ledger_update_has_before check (operation <> 'update' or before_image is not null)
);

create index if not exists ufc_legacy_repair_ledger_plan_idx on public.ufc_legacy_repair_ledger (plan_sha256, step);

comment on table public.ufc_legacy_repair_ledger is
  'Append-only before/after images for every canonical ufc_* row changed by a legacy-origins repair, keyed to the reviewed plan hash.';

-- -------------------------------------------------------------------------
-- 8. Source rows (policy, not data). UFC.com stays disabled.
-- -------------------------------------------------------------------------
insert into public.combat_sources
  (source_key, source_name, source_kind, homepage_url, access_mode, rights_state, redistribution_allowed, enabled, rights_note, reviewed_at)
values
  ('nsac', 'Nevada State Athletic Commission', 'commission', 'https://boxing.nv.gov/', 'approved_ingest', 'approved', false, true,
    'Public commission results records. Authoritative for the Nevada fields they report directly (officials, scores, weights, suspensions). Facts only; documents are not redistributed.', now()),
  ('nj_sacb', 'New Jersey State Athletic Control Board', 'commission', 'https://www.nj.gov/lps/sacb/', 'review_required', 'unknown', false, false,
    'Legacy UFC records requested via OPRA (not yet sent). Enable per record set once received.', null),
  ('pbe_legacy_curated', 'PropBetEdge curated legacy research', 'internal', null, 'approved_ingest', 'internal', false, true,
    'Operator-curated legacy JSON. Every value carries its own cited source and tier; this row is the curation step, not the evidence.', now())
on conflict (source_key) do nothing;

-- -------------------------------------------------------------------------
-- 9. Fight Pass replays as external references (never embedded, never
--    mirrored). Current readers filter provider = youtube, so these rows are
--    invisible to every existing video surface.
-- -------------------------------------------------------------------------
alter table public.ufc_videos drop constraint if exists ufc_videos_video_type_check;
alter table public.ufc_videos add constraint ufc_videos_video_type_check check (video_type in (
  'embedded_episode','countdown','fight_preview','full_fight','highlights','interview','press_conference','media_day','weigh_in','faceoff','post_fight','analysis','other','event_replay'));

-- -------------------------------------------------------------------------
-- Privileges.
-- -------------------------------------------------------------------------
alter table public.ufc_event_fact_keys          enable row level security;
alter table public.ufc_event_fact_claims        enable row level security;
alter table public.ufc_event_fact_resolutions   enable row level security;
alter table public.ufc_tournaments              enable row level security;
alter table public.ufc_tournament_entries       enable row level security;
alter table public.ufc_tournament_advancements  enable row level security;
alter table public.ufc_legacy_repair_ledger     enable row level security;

revoke all on public.ufc_event_fact_keys, public.ufc_event_fact_claims, public.ufc_event_fact_resolutions,
              public.ufc_tournaments, public.ufc_tournament_entries, public.ufc_tournament_advancements,
              public.ufc_legacy_repair_ledger
  from public, anon, authenticated, service_role;
revoke all on public.ufc_bout_round_stats_periods, public.ufc_event_fact_display from public, anon, authenticated, service_role;

grant select on public.ufc_event_fact_keys to service_role;
grant select, insert, update on public.ufc_event_fact_claims, public.ufc_event_fact_resolutions,
                                public.ufc_tournaments, public.ufc_tournament_entries, public.ufc_tournament_advancements
  to service_role;
grant select, insert on public.ufc_legacy_repair_ledger to service_role;
grant usage on sequence public.ufc_legacy_repair_ledger_id_seq to service_role;
grant select on public.ufc_bout_round_stats_periods, public.ufc_event_fact_display to service_role;

revoke all on function public.ufc_time_format_structure(text) from public, anon, authenticated;
grant execute on function public.ufc_time_format_structure(text) to service_role;
revoke all on function public.ufc_event_fact_claims_guard(), public.ufc_event_fact_resolutions_guard(),
                       public.ufc_tournament_advancements_guard() from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
