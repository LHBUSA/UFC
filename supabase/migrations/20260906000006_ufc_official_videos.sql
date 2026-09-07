-- Normalized allowlisted video metadata. Production already carried this
-- contract before this repo migration was added, so the migration is written
-- drift-safe: create when absent, then add only indexes/comments that are safe
-- against the live table. Video bytes stay on the publisher platform.
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
  duration_sec integer,
  thumbnail_url text,
  embeddable boolean,
  live_broadcast_state text,
  video_type text not null default 'other',
  fighter_ids uuid[] not null default '{}',
  event_id uuid references public.ufc_events(id) on delete set null,
  bout_id uuid references public.ufc_bouts(id) on delete set null,
  article_id uuid references public.ufc_articles(id) on delete set null,
  resolver_confidence text not null default 'none',
  link_status text not null default 'published',
  source_metadata jsonb not null default '{}',
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ufc_videos_provider_video_key unique (provider, provider_video_id)
);

create index if not exists ufc_videos_published_idx on public.ufc_videos (published_at desc);
create index if not exists ufc_videos_event_idx on public.ufc_videos (event_id, published_at desc) where link_status = 'published';
create index if not exists ufc_videos_article_idx on public.ufc_videos (article_id, published_at desc) where link_status = 'published';
create index if not exists ufc_videos_bout_idx on public.ufc_videos (bout_id, published_at desc) where link_status = 'published';
create index if not exists ufc_videos_fighter_ids_idx on public.ufc_videos using gin (fighter_ids);

alter table public.ufc_videos enable row level security;
comment on table public.ufc_videos is 'Allowlisted publisher-hosted video metadata only. PropBetEdge stores references/identity links, not copyrighted video bytes.';
