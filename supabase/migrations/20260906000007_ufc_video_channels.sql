-- Allowlisted video channels for the official video layer (docs/videos.md).
-- Drift-safe: production may already carry this table from the repo-root
-- migration 006_ufc_media_registry_videos.sql; create only when absent.
-- The ingest reads ONLY rows with enabled=true AND verified=true, and
-- scripts/videos/seed_channels.mjs re-proves verification live on every run.
create table if not exists public.ufc_video_channels (
  provider text not null default 'youtube',
  channel_id text not null,
  name text not null,
  handle text,
  channel_class text not null check (channel_class in ('ufc_official','ufc_regional','broadcast_partner','promotion_official','other')),
  verified boolean not null default false,
  verification jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, channel_id)
);

alter table public.ufc_video_channels enable row level security;
comment on table public.ufc_video_channels is 'Allowlist for the official video layer. Exact channel ids only; handles are evidence, never keys. Ingest reads enabled AND verified rows only.';
