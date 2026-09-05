-- PropBetEdge UFC — Phase 1 core schema + Track B news tables
-- Project: tkmlnhmylqnttmnsnief (the NFL instance). UFC stays OFF rlfyavnhbngwbldebrid (MLB + PropData).
--
-- Additive only. Creates ufc_* tables and nothing else. Touches no MLB/NFL
-- table, function, policy, or Stripe object.
--
-- Run once in the Supabase SQL editor. Safe to re-run: every statement is
-- guarded with `if not exists`.
--
-- Design notes that are NOT in the kickoff brief and were decided here:
--   * ufc_fighter_aliases uniqueness is (fighter_id, source, normalized), not
--     (source, normalized) as the brief says. UFC Stats itself carries several
--     fighters with the same name ("Bruno Silva" x3). A (source, normalized)
--     unique key would make the second one unwritable. Ambiguity is the
--     resolver's job (it returns every candidate), not the schema's.
--   * ufc_events carries location_raw + region. UFC Stats only gives
--     "City, Region, Country" — there is no venue. venue stays nullable for a
--     later source.
--   * ufc_bouts for announced (upcoming) cards: UFC Stats exposes a
--     fight-details id for upcoming bouts, so ufcstats_id is normally set.
--     For a row without one, a partial unique index on
--     (event_id, fighter_a_id, fighter_b_id) prevents duplicates.
--   * ufc_bout_results.method gains DRAW and OTHER. UFC Stats prints "Draw"
--     as a method-less result; the brief's enum had no slot for it.
--     OTHER is never written by a parser (unknown method = assertion
--     failure); it exists only so a manual correction has a value to use.
--   * Every ufc_* table has RLS enabled with NO policies. Workers and the
--     backfill script write with the service role, which bypasses RLS. Public
--     read access for the Track B web routes is a separate, later migration
--     (or the web layer reads server-side with the service key, as NFL does).

begin;

-- ---------------------------------------------------------------------------
-- 1. Fighters. Keyed on the 16-hex ufcstats_id, never on name.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighters (
  id uuid primary key default gen_random_uuid(),
  ufcstats_id text not null unique,
  name text not null,
  nickname text,
  dob date,
  height_in numeric,
  reach_in numeric,
  weight_lbs numeric,
  stance text check (stance is null or stance in ('ORTHODOX','SOUTHPAW','SWITCH','OPEN_STANCE','SIDEWAYS')),
  record_w int,
  record_l int,
  record_d int,
  record_nc int,
  -- LEAKAGE WARNING. career_* are the CAREER-TO-DATE snapshot printed on the
  -- fighter page at capture time. They include fights that happen AFTER any
  -- historical bout you might be modelling. They are display/QA fields only
  -- and MUST NOT be used as model features. Phase 4 builds as-of features
  -- from ufc_bout_round_stats instead.
  career_slpm numeric,
  career_str_acc numeric,
  career_sapm numeric,
  career_str_def numeric,
  career_td_avg numeric,
  career_td_acc numeric,
  career_td_def numeric,
  career_sub_avg numeric,
  is_active boolean,
  fight_history_count int,          -- row count of the fighter page's history table; completeness cross-check
  source_url text not null,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.ufc_fighters.career_slpm is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_str_acc is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_sapm is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_str_def is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_td_avg is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_td_acc is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_td_def is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';
comment on column public.ufc_fighters.career_sub_avg is 'Career-to-date snapshot at capture. NOT a model feature (leakage).';

create index if not exists ufc_fighters_name_idx on public.ufc_fighters (lower(name));

-- ---------------------------------------------------------------------------
-- 2. Aliases + manual review queue.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_aliases (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  alias text not null,
  source text not null,              -- 'ufcstats' | 'ufcstats_nickname' | 'espn' | 'ufc_com' | 'manual' ...
  normalized text not null,          -- shared/alias_resolver normalize()
  created_at timestamptz not null default now(),
  unique (fighter_id, source, normalized)
);
create index if not exists ufc_fighter_aliases_lookup_idx
  on public.ufc_fighter_aliases (source, normalized);
create index if not exists ufc_fighter_aliases_norm_idx
  on public.ufc_fighter_aliases (normalized);

create table if not exists public.ufc_alias_review_queue (
  id uuid primary key default gen_random_uuid(),
  raw_name text not null,
  source text not null,
  candidate_fighter_ids uuid[] not null default '{}',
  context jsonb not null default '{}'::jsonb,   -- {reason, weight_class, dob, record, score, url, ...}
  status text not null default 'pending' check (status in ('pending','resolved','rejected')),
  resolved_fighter_id uuid references public.ufc_fighters(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists ufc_alias_review_queue_status_idx
  on public.ufc_alias_review_queue (status, created_at);

-- ---------------------------------------------------------------------------
-- 3. Events.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_events (
  id uuid primary key default gen_random_uuid(),
  ufcstats_id text not null unique,
  name text not null,
  event_date date,
  venue text,                        -- not on UFC Stats; later source
  city text,
  region text,                       -- state/province when present
  country text,
  location_raw text,                 -- verbatim "City, Region, Country" from the page
  commission text,
  is_ppv boolean,
  card_status text not null default 'announced'
    check (card_status in ('announced','locked','complete')),
  source_url text not null,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ufc_events_date_idx on public.ufc_events (event_date desc);
create index if not exists ufc_events_status_idx on public.ufc_events (card_status);

-- ---------------------------------------------------------------------------
-- 4. Bouts. One row per scheduled/announced matchup on a card.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_bouts (
  id uuid primary key default gen_random_uuid(),
  ufcstats_id text unique,           -- null only for announced bouts with no fight-details link
  event_id uuid not null references public.ufc_events(id) on delete cascade,
  fighter_a_id uuid not null references public.ufc_fighters(id),
  fighter_b_id uuid not null references public.ufc_fighters(id),
  weight_class text
    check (weight_class is null or weight_class in ('STRAWWEIGHT','FLYWEIGHT','BANTAMWEIGHT','FEATHERWEIGHT','LIGHTWEIGHT','WELTERWEIGHT','MIDDLEWEIGHT','LIGHT_HEAVYWEIGHT','HEAVYWEIGHT','SUPER_HEAVYWEIGHT','CATCHWEIGHT','OPEN')),
  weight_class_raw text,             -- verbatim, e.g. "Women's Strawweight Bout", "UFC Women's Bantamweight Title Bout"
  is_womens boolean not null default false,
  is_title boolean not null default false,
  scheduled_rounds int,
  card_position text,                -- main|prelim|early; NOT on UFC Stats, nullable
  bout_order int not null,           -- main event = highest; descends down the card
  status text not null default 'announced'
    check (status in ('announced','confirmed','cancelled','replaced','complete')),
  replaced_bout_id uuid references public.ufc_bouts(id),
  short_notice_days int,
  source_url text not null,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fighter_a_id <> fighter_b_id)
);
create index if not exists ufc_bouts_event_idx on public.ufc_bouts (event_id, bout_order desc);
create index if not exists ufc_bouts_fighter_a_idx on public.ufc_bouts (fighter_a_id);
create index if not exists ufc_bouts_fighter_b_idx on public.ufc_bouts (fighter_b_id);
create index if not exists ufc_bouts_status_idx on public.ufc_bouts (status);
create unique index if not exists ufc_bouts_announced_pair_uniq
  on public.ufc_bouts (event_id, fighter_a_id, fighter_b_id)
  where ufcstats_id is null;

-- ---------------------------------------------------------------------------
-- 5. Results. One row per completed bout.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_bout_results (
  bout_id uuid primary key references public.ufc_bouts(id) on delete cascade,
  winner_id uuid references public.ufc_fighters(id),   -- null for draw / NC
  method text not null check (method in ('KO_TKO','SUB','DEC_U','DEC_S','DEC_M','DQ','NC','DRAW','OTHER')),
  method_raw text not null,          -- verbatim, e.g. "Decision - Unanimous", "KO/TKO"
  round int,
  time_sec int,
  time_format text,                  -- verbatim "3 Rnd (5-5-5)"
  referee text,
  judge_1 text,
  judge_2 text,
  judge_3 text,
  scorecards jsonb,                  -- [{"judge":"Sal D''Amato","score":"29-28"}, ...]
  finish_detail text,                -- verbatim Details line for finishes
  has_stats boolean not null default false,
  source_url text not null,
  captured_at timestamptz not null default now()
);
create index if not exists ufc_bout_results_winner_idx on public.ufc_bout_results (winner_id);
create index if not exists ufc_bout_results_method_idx on public.ufc_bout_results (method);

-- ---------------------------------------------------------------------------
-- 6. Round stats. Round-level only; totals are recomputable.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_bout_round_stats (
  bout_id uuid not null references public.ufc_bouts(id) on delete cascade,
  fighter_id uuid not null references public.ufc_fighters(id),
  round int not null,
  kd int,
  sig_str_landed int, sig_str_att int,
  total_str_landed int, total_str_att int,
  td_landed int, td_att int,
  sub_att int,
  rev int,
  ctrl_sec int,
  head_landed int, head_att int,
  body_landed int, body_att int,
  leg_landed int, leg_att int,
  distance_landed int, distance_att int,
  clinch_landed int, clinch_att int,
  ground_landed int, ground_att int,
  source_url text not null,
  captured_at timestamptz not null default now(),
  primary key (bout_id, fighter_id, round)
);
create index if not exists ufc_bout_round_stats_fighter_idx on public.ufc_bout_round_stats (fighter_id);

-- ---------------------------------------------------------------------------
-- 7. Ingest run ledger. One row per worker/backfill invocation.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  worker text not null,              -- 'ufc-stats-ingest' | 'backfill_ufcstats' | ...
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  events_new int not null default 0,
  bouts_new int not null default 0,
  fighters_touched int not null default 0,
  assertion_failures jsonb not null default '[]'::jsonb,
  status text not null default 'running' check (status in ('running','success','failed','partial')),
  notes jsonb not null default '{}'::jsonb
);
create index if not exists ufc_ingest_runs_worker_idx on public.ufc_ingest_runs (worker, started_at desc);

-- ---------------------------------------------------------------------------
-- 8. Track B — news outlet tables. Created now, populated by Track B workers.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_news_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rss','x_list','internal')),
  url text,
  name text not null,
  weight numeric not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, name)
);

create table if not exists public.ufc_news_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.ufc_news_sources(id),
  url text unique,
  title text not null,
  published_at timestamptz,
  summary text,
  taxonomy jsonb not null default '{}'::jsonb,   -- {"labels":["withdrawal","replacement"], "confidence":0.9}
  fighter_ids uuid[] not null default '{}',
  bout_id uuid references public.ufc_bouts(id),
  event_id uuid references public.ufc_events(id),
  fingerprint text not null unique,              -- sha256(normalized title + domain)
  captured_at timestamptz not null default now()
);
create index if not exists ufc_news_items_published_idx on public.ufc_news_items (published_at desc);
create index if not exists ufc_news_items_event_idx on public.ufc_news_items (event_id);

create table if not exists public.ufc_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  headline text not null,
  dek text,
  body_md text not null,
  story_type text not null
    check (story_type in ('card_change','rankings','fight_preview','weigh_in','results','line_move','external')),
  status text not null default 'draft' check (status in ('draft','review','published')),
  hero_image_ref text,               -- ufc_images.id or r2 key
  hero_credit jsonb,                 -- {"author":..., "license":..., "source_url":...}
  sources jsonb not null default '[]'::jsonb,    -- [{"kind":"news_item","id":...}, {"kind":"fact_block","hash":...}]
  fact_block jsonb,                  -- exactly what the writer was allowed to state
  fighter_ids uuid[] not null default '{}',
  bout_id uuid references public.ufc_bouts(id),
  event_id uuid references public.ufc_events(id),
  model_version text,
  needs_human boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ufc_articles_status_pub_idx on public.ufc_articles (status, published_at desc);
create index if not exists ufc_articles_event_idx on public.ufc_articles (event_id);
create index if not exists ufc_articles_type_idx on public.ufc_articles (story_type);

create table if not exists public.ufc_images (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('statcard','wikimedia')),
  r2_key text not null unique,
  license text,
  author text,
  source_url text,
  fighter_id uuid references public.ufc_fighters(id),
  created_at timestamptz not null default now()
);
create index if not exists ufc_images_fighter_idx on public.ufc_images (fighter_id);

-- ---------------------------------------------------------------------------
-- RLS: service-role writes only. No anon/authenticated policy is created, so
-- the anon key can neither read nor write any ufc_* table until a later
-- migration deliberately opens the public-read surfaces.
-- ---------------------------------------------------------------------------
alter table public.ufc_fighters           enable row level security;
alter table public.ufc_fighter_aliases    enable row level security;
alter table public.ufc_alias_review_queue enable row level security;
alter table public.ufc_events             enable row level security;
alter table public.ufc_bouts              enable row level security;
alter table public.ufc_bout_results       enable row level security;
alter table public.ufc_bout_round_stats   enable row level security;
alter table public.ufc_ingest_runs        enable row level security;
alter table public.ufc_news_sources       enable row level security;
alter table public.ufc_news_items         enable row level security;
alter table public.ufc_articles           enable row level security;
alter table public.ufc_images             enable row level security;

commit;
