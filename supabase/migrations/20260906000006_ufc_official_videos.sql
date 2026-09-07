-- Official/allowlisted UFC video metadata. We store references and identity
-- links only; video bytes remain on the publisher platform (YouTube).
create table if not exists public.ufc_videos (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'youtube' check (provider in ('youtube')),
  provider_video_id text not null,
  channel_id text not null,
  channel_name text not null,
  title text not null,
  description text,
  url text not null,
  thumbnail_url text,
  published_at timestamptz,
  video_type text not null default 'official_video' check (video_type in ('official_video','preview','interview','press_conference','highlights','weigh_in','embedded','other')),
  event_id uuid references public.ufc_events(id) on delete set null,
  article_id uuid references public.ufc_articles(id) on delete set null,
  fighter_ids uuid[] not null default '{}',
  resolver_method text,
  resolver_confidence numeric(5,4),
  source_feed text not null,
  status text not null default 'active' check (status in ('active','held','removed')),
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ufc_videos_provider_video_key unique (provider, provider_video_id),
  constraint ufc_videos_resolver_confidence_check check (resolver_confidence is null or (resolver_confidence >= 0 and resolver_confidence <= 1))
);

create index if not exists ufc_videos_published_idx on public.ufc_videos (published_at desc);
create index if not exists ufc_videos_event_idx on public.ufc_videos (event_id, published_at desc) where status = 'active';
create index if not exists ufc_videos_article_idx on public.ufc_videos (article_id, published_at desc) where status = 'active';
create index if not exists ufc_videos_fighter_ids_idx on public.ufc_videos using gin (fighter_ids);

alter table public.ufc_videos enable row level security;
comment on table public.ufc_videos is 'Allowlisted publisher-hosted video metadata only. No copyrighted video bytes are stored or redistributed.';
