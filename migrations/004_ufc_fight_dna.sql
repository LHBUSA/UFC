-- PropBetEdge UFC — 004: Fight DNA feature store
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. This migration creates the versioned derived-feature layer
-- above canonical UFC source facts. It does not alter existing UFC tables.
--
-- Design rules:
--   * historical snapshots are AS-OF and must never use future rows
--   * every derived metric carries sample / coverage / provenance context
--   * licensed provider facts are stored separately from PBE-derived features
--   * future CV/action labels are confidence + validation gated
--   * RLS is enabled with no public policies, matching the existing UFC schema

begin;

-- ---------------------------------------------------------------------------
-- 1. Metric registry. This is the public definition catalog for PBE-derived IP.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_dna_metric_definitions (
  metric_key text not null,
  definition_version int not null default 1,
  family text not null check (family in (
    'stance','striking','pace','grappling','finish','context','position','composite','opponent_adjusted'
  )),
  display_name text not null,
  description text not null,
  unit text,
  formula text not null,
  source_families text[] not null default '{}',
  min_bouts int not null default 1 check (min_bouts >= 0),
  min_rounds int not null default 0 check (min_rounds >= 0),
  min_seconds int not null default 0 check (min_seconds >= 0),
  public boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (metric_key, definition_version)
);

comment on table public.ufc_dna_metric_definitions is
  'Versioned definitions for PropBetEdge-derived Fight DNA metrics. Formula text and minimum sample rules are part of the contract.';

-- ---------------------------------------------------------------------------
-- 2. One feature row per fighter per bout. This is the reproducible primitive
--    from which as-of snapshots and matchup comparisons are aggregated.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_bout_features (
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  event_id uuid not null references public.ufc_events(id) on delete cascade,
  opponent_id uuid not null references public.ufc_fighters(id),
  event_date date not null,

  feature_version int not null default 1,

  fighter_stance text,
  opponent_stance text,
  stance_context text check (stance_context is null or stance_context in (
    'same','open','switch_involved','unknown'
  )),

  outcome text check (outcome is null or outcome in ('W','L','D','NC')),
  method text,
  scheduled_rounds int,
  is_title boolean not null default false,
  is_main_event boolean not null default false,
  short_notice_days int,

  round_rows int not null default 0 check (round_rows >= 0),
  observed_seconds int check (observed_seconds is null or observed_seconds >= 0),
  stats_coverage text not null default 'none' check (stats_coverage in ('none','partial','complete')),

  -- Source-normalized bout totals / per-round arrays used to rebuild metrics.
  raw_stats jsonb not null default '{}'::jsonb,

  -- PBE-derived feature values for this one bout. Values remain nullable when
  -- the source does not support the denominator or required context.
  features jsonb not null default '{}'::jsonb,

  -- Exact source families, source ids/capture times and builder watermark.
  provenance jsonb not null default '{}'::jsonb,

  generated_at timestamptz not null default now(),
  primary key (fighter_id, bout_id, feature_version),
  check (fighter_id <> opponent_id)
);

create index if not exists ufc_fighter_bout_features_fighter_date_idx
  on public.ufc_fighter_bout_features (fighter_id, event_date desc);
create index if not exists ufc_fighter_bout_features_opponent_idx
  on public.ufc_fighter_bout_features (opponent_id, event_date desc);
create index if not exists ufc_fighter_bout_features_stance_idx
  on public.ufc_fighter_bout_features (fighter_id, opponent_stance, event_date desc);
create index if not exists ufc_fighter_bout_features_coverage_idx
  on public.ufc_fighter_bout_features (stats_coverage, event_date desc);

-- ---------------------------------------------------------------------------
-- 3. As-of fighter snapshots. Current pages use the newest snapshot; historical
--    modeling uses the snapshot strictly before the target fight date.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_dna_snapshots (
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  as_of_date date not null,
  definition_version int not null default 1,

  sample_bouts int not null default 0,
  sample_completed_bouts int not null default 0,
  sample_stat_bouts int not null default 0,
  sample_rounds int not null default 0,
  sample_seconds int not null default 0,

  coverage_status text not null default 'insufficient'
    check (coverage_status in ('insufficient','low','medium','high')),

  metrics jsonb not null default '{}'::jsonb,
  stance_splits jsonb not null default '{}'::jsonb,
  round_profile jsonb not null default '{}'::jsonb,
  finish_profile jsonb not null default '{}'::jsonb,
  context_splits jsonb not null default '{}'::jsonb,
  position_profile jsonb not null default '{}'::jsonb,
  archetype jsonb,

  provenance jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  primary key (fighter_id, as_of_date, definition_version)
);

create index if not exists ufc_fighter_dna_snapshots_latest_idx
  on public.ufc_fighter_dna_snapshots (fighter_id, as_of_date desc, definition_version desc);
create index if not exists ufc_fighter_dna_snapshots_coverage_idx
  on public.ufc_fighter_dna_snapshots (coverage_status, as_of_date desc);

-- ---------------------------------------------------------------------------
-- 4. Query-friendly stance splits. Kept separate because this is a high-value
--    filter/API surface and should not require JSON scans.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_stance_splits (
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  as_of_date date not null,
  opponent_stance text not null,
  definition_version int not null default 1,

  appearances int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  no_contests int not null default 0,
  ko_tko_wins int not null default 0,
  submission_wins int not null default 0,
  decision_wins int not null default 0,

  stat_bouts int not null default 0,
  stat_rounds int not null default 0,
  observed_seconds int not null default 0,

  metrics jsonb not null default '{}'::jsonb,
  confidence text not null default 'insufficient'
    check (confidence in ('insufficient','low','medium','high')),
  provenance jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),

  primary key (fighter_id, as_of_date, opponent_stance, definition_version)
);

create index if not exists ufc_fighter_stance_splits_lookup_idx
  on public.ufc_fighter_stance_splits (opponent_stance, as_of_date desc, appearances desc);

-- ---------------------------------------------------------------------------
-- 5. Licensed / independently verified position-time enrichment.
--    This table is SOURCE FACT, not a PBE-derived score.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_bout_position_stats (
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  source text not null,
  scope text not null check (scope in ('fight','round')),
  round int,

  standing_sec int,
  distance_sec int,
  clinch_sec int,
  ground_sec int,
  neutral_sec int,
  control_sec int,
  ground_control_sec int,
  back_control_sec int,
  mount_control_sec int,
  side_control_sec int,
  guard_control_sec int,
  half_guard_control_sec int,
  misc_ground_control_sec int,

  source_record_id text,
  source_captured_at timestamptz,
  captured_at timestamptz not null default now(),

  primary key (bout_id, fighter_id, source, scope, round),
  check ((scope = 'round' and round is not null and round > 0) or (scope = 'fight' and round is null))
);

create index if not exists ufc_bout_position_stats_fighter_idx
  on public.ufc_bout_position_stats (fighter_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- 6. Licensed / independently verified detailed finish enrichment.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_bout_finish_enrichment (
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  source text not null,
  official boolean,
  finish_weapon text,
  finish_target text,
  finish_position text,
  submission_technique text,
  ending_round int,
  ending_time_sec int,
  source_record_id text,
  source_captured_at timestamptz,
  captured_at timestamptz not null default now(),
  primary key (bout_id, source)
);

create index if not exists ufc_bout_finish_enrichment_weapon_idx
  on public.ufc_bout_finish_enrichment (finish_weapon);
create index if not exists ufc_bout_finish_enrichment_position_idx
  on public.ufc_bout_finish_enrichment (finish_position);

-- ---------------------------------------------------------------------------
-- 7. Future action-event stream. Supports licensed events, CV output and
--    human-reviewed technique annotations without pretending all are equal.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_action_events (
  id uuid primary key default gen_random_uuid(),
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_id uuid references public.ufc_fighters(id) on delete cascade,
  opponent_id uuid references public.ufc_fighters(id),

  round int,
  clock_sec int,
  elapsed_fight_sec int,

  event_type text not null check (event_type in (
    'strike','knockdown','takedown','submission_attempt','reversal','position_change','finish','other'
  )),
  result text,
  strength text,
  weapon text,
  technique text,
  target text,
  position text,
  stance_at_action text,

  source text not null,
  source_event_id text,
  source_media_ref text,
  model_version text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  validation_status text not null default 'source_verified'
    check (validation_status in ('source_verified','model_unreviewed','human_verified','rejected')),
  reviewer text,
  reviewed_at timestamptz,

  captured_at timestamptz not null default now(),
  check (fighter_id is null or opponent_id is null or fighter_id <> opponent_id)
);

create unique index if not exists ufc_action_events_source_event_uniq
  on public.ufc_action_events (source, source_event_id)
  where source_event_id is not null;
create index if not exists ufc_action_events_bout_time_idx
  on public.ufc_action_events (bout_id, round, clock_sec desc);
create index if not exists ufc_action_events_fighter_idx
  on public.ufc_action_events (fighter_id, event_type, captured_at desc);
create index if not exists ufc_action_events_technique_idx
  on public.ufc_action_events (technique)
  where validation_status in ('source_verified','human_verified');

-- ---------------------------------------------------------------------------
-- 8. Build ledger / reproducibility.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_dna_build_runs (
  id uuid primary key default gen_random_uuid(),
  definition_version int not null,
  mode text not null check (mode in ('full','incremental','fighter','as_of','dry_run')),
  fighter_id uuid references public.ufc_fighters(id),
  as_of_date date,
  source_watermark jsonb not null default '{}'::jsonb,
  input_counts jsonb not null default '{}'::jsonb,
  output_counts jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ufc_dna_build_runs_status_idx
  on public.ufc_dna_build_runs (status, started_at desc);

-- ---------------------------------------------------------------------------
-- 9. Seed the first public metric definitions. Inserts are idempotent.
-- ---------------------------------------------------------------------------
insert into public.ufc_dna_metric_definitions
  (metric_key, definition_version, family, display_name, description, unit, formula, source_families, min_bouts, min_rounds, min_seconds)
values
  ('stance_ko_rate', 1, 'stance', 'KO/TKO Rate vs Stance', 'KO/TKO wins divided by completed appearances against a listed opponent stance.', 'ratio', 'ko_tko_wins / completed_appearances_vs_stance', array['espn','ufcstats'], 2, 0, 0),
  ('stance_finish_rate', 1, 'stance', 'Finish Rate vs Stance', 'KO/TKO plus submission wins divided by wins against a listed opponent stance.', 'ratio', '(ko_tko_wins + submission_wins) / wins_vs_stance', array['espn','ufcstats'], 2, 0, 0),
  ('sig_landed_per_min', 1, 'striking', 'Sig. Strikes Landed / Min', 'Significant strikes landed divided by observed stat-covered minutes.', 'per_min', 'sig_str_landed / observed_minutes', array['ufcstats'], 1, 2, 300),
  ('sig_absorbed_per_min', 1, 'striking', 'Sig. Strikes Absorbed / Min', 'Opponent significant strikes landed divided by observed stat-covered minutes.', 'per_min', 'opponent_sig_str_landed / observed_minutes', array['ufcstats'], 1, 2, 300),
  ('head_attack_share', 1, 'striking', 'Head Attack Share', 'Head significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'head_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('body_attack_share', 1, 'striking', 'Body Attack Share', 'Body significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'body_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('leg_attack_share', 1, 'striking', 'Leg Attack Share', 'Leg significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'leg_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('distance_attack_share', 1, 'striking', 'Distance Attack Share', 'Distance significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'distance_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('clinch_attack_share', 1, 'striking', 'Clinch Attack Share', 'Clinch significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'clinch_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('ground_attack_share', 1, 'striking', 'Ground Attack Share', 'Ground significant-strike attempts divided by all significant-strike attempts.', 'ratio', 'ground_att / sig_str_att', array['ufcstats'], 1, 2, 300),
  ('knockdowns_per_15', 1, 'striking', 'Knockdowns / 15', 'Knockdowns created per 15 stat-covered minutes.', 'per_15', 'kd * 900 / observed_seconds', array['ufcstats'], 1, 2, 300),
  ('td_attempts_per_15', 1, 'grappling', 'Takedown Attempts / 15', 'Takedown attempts per 15 stat-covered minutes.', 'per_15', 'td_att * 900 / observed_seconds', array['ufcstats'], 1, 2, 300),
  ('td_accuracy', 1, 'grappling', 'Takedown Accuracy', 'Takedowns landed divided by takedowns attempted.', 'ratio', 'td_landed / td_att', array['ufcstats'], 1, 2, 300),
  ('control_seconds_per_td', 1, 'grappling', 'Control Seconds / Takedown', 'Recorded control seconds divided by takedowns landed.', 'seconds_per_td', 'ctrl_sec / td_landed', array['ufcstats'], 1, 2, 300),
  ('sub_attempts_per_15', 1, 'grappling', 'Submission Attempts / 15', 'Submission attempts per 15 stat-covered minutes.', 'per_15', 'sub_att * 900 / observed_seconds', array['ufcstats'], 1, 2, 300),
  ('pace_retention_r2_vs_r1', 1, 'pace', 'R2 Pace Retention', 'Round-two significant-strike attempt pace divided by round-one pace.', 'ratio', 'r2_sig_att_per_min / r1_sig_att_per_min', array['ufcstats'], 2, 4, 600),
  ('pace_retention_r3_vs_r1', 1, 'pace', 'R3 Pace Retention', 'Round-three significant-strike attempt pace divided by round-one pace.', 'ratio', 'r3_sig_att_per_min / r1_sig_att_per_min', array['ufcstats'], 2, 6, 900),
  ('finish_rate', 1, 'finish', 'Finish Rate', 'KO/TKO plus submission wins divided by wins.', 'ratio', '(ko_tko_wins + submission_wins) / wins', array['espn','ufcstats'], 2, 0, 0),
  ('short_notice_record', 1, 'context', 'Short-Notice Record', 'W/L/D/NC in bouts carrying a verified short_notice_days value.', 'record', 'aggregate outcomes where short_notice_days is not null', array['espn'], 1, 0, 0)
on conflict (metric_key, definition_version) do nothing;

-- RLS: service-role / Workers only until an explicit API policy is designed.
alter table public.ufc_dna_metric_definitions enable row level security;
alter table public.ufc_fighter_bout_features enable row level security;
alter table public.ufc_fighter_dna_snapshots enable row level security;
alter table public.ufc_fighter_stance_splits enable row level security;
alter table public.ufc_bout_position_stats enable row level security;
alter table public.ufc_bout_finish_enrichment enable row level security;
alter table public.ufc_action_events enable row level security;
alter table public.ufc_dna_build_runs enable row level security;

commit;
