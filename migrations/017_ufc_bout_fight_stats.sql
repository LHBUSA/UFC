-- ESPN fight totals. FIGHT-LEVEL ONLY.
--
-- =========================================================================
-- WHY A SEPARATE TABLE
-- =========================================================================
--
-- ESPN publishes per-fighter statistics for a completed bout and labels them,
-- in its own payload, as:
--
--   splits.type = "total"   splits.name = "All Splits"   abbreviation = "TOT"
--
-- There is no round dimension anywhere in the public graph. Verified 2026-09-12
-- across 2019, 2023, 2024 and 2026 events: every competitor statistics document
-- is splits.type "total", and the endpoint ignores every attempt to address a
-- round (?period=1, ?split=1, /statistics/0, /statistics/1, /statistics/2 all
-- return a byte-identical document, md5 c6bc0274ca38). ESPN's own metadata says
-- the same thing a second way: statsSource, boxscoreSource and playByPlaySource
-- all report description "none".
--
-- So these numbers CANNOT go in ufc_bout_round_stats. That table's primary key
-- is (bout_id, fighter_id, round), and writing a fight total into it would have
-- to invent a round number — most temptingly "the round the fight ended in",
-- which would be a fabricated per-round figure carrying a real total's value.
-- ufc_bout_round_stats stays exactly as it is: UFC Stats round decomposition,
-- and nothing else.
--
-- The two datasets are complements, not competitors, and may coexist for the
-- same bout:
--
--   ufc_bout_fight_stats   ESPN     verified whole-fight totals
--   ufc_bout_round_stats   UFCStats round-by-round decomposition
--
-- Neither is ever derived from, or overwritten by, the other.
--
-- =========================================================================
-- WHAT IS DELIBERATELY ABSENT
-- =========================================================================
--
-- sub_att. ESPN exposes a "submissions" counter whose semantics have NOT been
-- proven equal to UFC Stats' submission ATTEMPTS. A column that silently means
-- two different things depending on which source filled it is worse than a
-- column that does not exist yet, so it is left out until the equivalence is
-- demonstrated rather than assumed.
--
-- Also absent: takedownAccuracy, targetBreakdown*, posBreakdown*, slamRate.
-- Every one is derivable from the counts stored here, and a stored derivation
-- is a second copy that can disagree with the first.
--
-- Additive and non-destructive. Nothing that already exists is altered.
-- =========================================================================

begin;

create table if not exists public.ufc_bout_fight_stats (
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_id uuid not null references public.ufc_fighters(id),

  kd int,

  sig_str_landed int, sig_str_att int,
  total_str_landed int, total_str_att int,
  td_landed int, td_att int,

  -- Seconds. ESPN reports timeInControl as an integer count of seconds and
  -- renders it "0:41"; the integer is stored and the display is formatted.
  ctrl_sec int,
  rev int,

  -- Target breakdown of SIGNIFICANT strikes, summed across positions.
  head_landed int, head_att int,
  body_landed int, body_att int,
  leg_landed int, leg_att int,

  -- Position breakdown of SIGNIFICANT strikes, summed across targets.
  distance_landed int, distance_att int,
  clinch_landed int, clinch_att int,
  ground_landed int, ground_att int,

  -- Provenance. source_family is explicit rather than assumed so a second
  -- totals source could never be mistaken for this one, and the UI can say
  -- "Fight totals · ESPN" from the row rather than from a hardcoded string.
  source_family text not null default 'espn' check (source_family in ('espn', 'ufcstats')),
  source_url text not null,
  source_competition_id text,
  -- ESPN's own "wallclock" stat: when the SOURCE last updated these numbers,
  -- which is a different fact from when we read them.
  source_updated_at timestamptz,
  captured_at timestamptz not null default now(),

  primary key (bout_id, fighter_id),

  -- Coherence, enforced by the database and not only by the writer. A landed
  -- count above its attempted count is not a number we are willing to store
  -- under any circumstances, so it fails at the boundary rather than being
  -- rendered later.
  constraint ufc_bout_fight_stats_sig_le_att check (sig_str_landed is null or sig_str_att is null or sig_str_landed <= sig_str_att),
  constraint ufc_bout_fight_stats_tot_le_att check (total_str_landed is null or total_str_att is null or total_str_landed <= total_str_att),
  constraint ufc_bout_fight_stats_td_le_att check (td_landed is null or td_att is null or td_landed <= td_att),
  constraint ufc_bout_fight_stats_sig_le_total check (sig_str_landed is null or total_str_landed is null or sig_str_landed <= total_str_landed),
  constraint ufc_bout_fight_stats_nonneg check (
    coalesce(kd, 0) >= 0 and coalesce(ctrl_sec, 0) >= 0 and coalesce(rev, 0) >= 0
    and coalesce(sig_str_att, 0) >= 0 and coalesce(total_str_att, 0) >= 0 and coalesce(td_att, 0) >= 0
  )
);

create index if not exists ufc_bout_fight_stats_fighter_idx on public.ufc_bout_fight_stats (fighter_id);
create index if not exists ufc_bout_fight_stats_captured_idx on public.ufc_bout_fight_stats (captured_at desc);

-- Same posture as every other ufc_* table: RLS on, no policies. The Worker and
-- the server-side web reads use the service role, which bypasses RLS; there is
-- no anonymous read path.
alter table public.ufc_bout_fight_stats enable row level security;

comment on table public.ufc_bout_fight_stats is
  'ESPN whole-fight statistics, one row per (bout, fighter). FIGHT TOTALS ONLY: ESPN reports splits.type=total with no round dimension. Never write these into ufc_bout_round_stats.';
comment on column public.ufc_bout_fight_stats.ctrl_sec is 'Control time in seconds (ESPN timeInControl).';
comment on column public.ufc_bout_fight_stats.source_updated_at is 'ESPN wallclock: when the source last updated these totals, not when we read them.';

commit;
