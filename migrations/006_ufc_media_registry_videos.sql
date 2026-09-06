-- PropBetEdge UFC — 006: media registry evolution + official video layer
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive. Extends ufc_images so additional rights-safe image classes can be
-- registered without breaking existing rows, and adds the official-video
-- layer (allowlisted channels + normalized videos). Videos are never
-- downloaded or rehosted: only provider ids and metadata are stored and the
-- embed URL is constructed at render time.

begin;

-- ---------------------------------------------------------------------------
-- ufc_images: more kinds, explicit rights metadata, identity evidence
-- ---------------------------------------------------------------------------
alter table public.ufc_images drop constraint if exists ufc_images_kind_check;
alter table public.ufc_images
  add constraint ufc_images_kind_check
  check (kind in ('statcard','wikimedia','public_domain','licensed_editorial','official_press'));
alter table public.ufc_images
  add column if not exists source_family text,          -- wikimedia | us_gov | first_party | provider:<name>
  add column if not exists attribution_text text,       -- rendered credit line
  add column if not exists rights_label text,           -- e.g. "CC BY-SA 4.0", "Public domain", "Licensed (contract #)"
  add column if not exists rights_expires_at timestamptz,
  add column if not exists provider_asset_id text,
  add column if not exists stored_first_party boolean not null default true,  -- false = display-only per contract, serve from provider
  add column if not exists identity_evidence jsonb not null default '{}'::jsonb,  -- {wikidata_qid, dob_match, name_match, category, reviewer}
  add column if not exists width int,
  add column if not exists height int,
  add column if not exists captured_at timestamptz not null default now();
create index if not exists ufc_images_kind_idx on public.ufc_images (kind, fighter_id);

-- ---------------------------------------------------------------------------
-- Allowlisted official channels. Only verified, enabled channels feed
-- automatic publication.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_video_channels (
  provider text not null default 'youtube',
  channel_id text not null,
  name text not null,
  handle text,
  channel_class text not null check (channel_class in ('ufc_official','ufc_regional','broadcast_partner','promotion_official','other')),
  verified boolean not null default false,
  verification jsonb not null default '{}'::jsonb,    -- {method, feed_title, checked_at}
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, channel_id)
);

-- ---------------------------------------------------------------------------
-- Normalized videos (metadata only).
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_videos (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'youtube',
  provider_video_id text not null,
  channel_id text not null,
  channel_name text,
  channel_verified_source boolean not null default false,
  url text not null,
  title text not null,
  description text,
  published_at timestamptz,
  duration_sec int,
  thumbnail_url text,
  embeddable boolean,                       -- null = not yet checked
  live_broadcast_state text,               -- none | upcoming | live | completed | null
  video_type text not null default 'other' check (video_type in (
    'embedded_episode','countdown','fight_preview','full_fight','highlights','interview','press_conference','media_day','weigh_in','faceoff','post_fight','analysis','other'
  )),
  fighter_ids uuid[] not null default '{}',
  event_id uuid references public.ufc_events(id),
  bout_id uuid references public.ufc_bouts(id),
  article_id uuid references public.ufc_articles(id),
  resolver_confidence text not null default 'none' check (resolver_confidence in ('none','low','medium','high')),
  link_status text not null default 'published' check (link_status in ('published','review','rejected')),
  source_metadata jsonb not null default '{}'::jsonb,   -- discovery method, raw feed/API fields, classification evidence
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_video_id)
);
create index if not exists ufc_videos_published_idx on public.ufc_videos (published_at desc);
create index if not exists ufc_videos_event_idx on public.ufc_videos (event_id, published_at desc);
create index if not exists ufc_videos_bout_idx on public.ufc_videos (bout_id, published_at desc);
create index if not exists ufc_videos_type_idx on public.ufc_videos (video_type, published_at desc);
create index if not exists ufc_videos_fighters_idx on public.ufc_videos using gin (fighter_ids);

alter table public.ufc_video_channels enable row level security;
alter table public.ufc_videos enable row level security;

commit;
