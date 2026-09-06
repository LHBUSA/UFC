-- PropBetEdge UFC - 006: fighter image candidate ledger
-- Project: tkmlnhmylqnttmnsnief
--
-- Private discovery queue for fighter media that is not yet safe to render.
-- High-confidence rights-safe assets may be promoted into ufc_images; ambiguous
-- or non-cleared media remains review-only and is never exposed publicly.

begin;

create table if not exists public.ufc_image_candidates (
  id uuid primary key default gen_random_uuid(),
  fighter_id uuid not null references public.ufc_fighters(id) on delete cascade,
  source_family text not null,
  provider_asset_id text,
  source_url text not null,
  image_url text,
  thumbnail_url text,
  license text,
  author text,
  attribution_text text,
  rights_label text not null default 'unknown',
  discovery_method text not null,
  identity_confidence numeric not null default 0 check (identity_confidence >= 0 and identity_confidence <= 1),
  rights_confidence numeric not null default 0 check (rights_confidence >= 0 and rights_confidence <= 1),
  identity_evidence jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'needs_review' check (status in ('auto_approved','needs_review','published','rejected')),
  rejection_reason text,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (fighter_id, source_url)
);

create index if not exists ufc_image_candidates_fighter_status_idx
  on public.ufc_image_candidates (fighter_id, status, identity_confidence desc);
create index if not exists ufc_image_candidates_status_rights_idx
  on public.ufc_image_candidates (status, rights_confidence desc, identity_confidence desc);
create index if not exists ufc_image_candidates_source_idx
  on public.ufc_image_candidates (source_family, discovery_method);

alter table public.ufc_image_candidates enable row level security;

comment on table public.ufc_image_candidates is
  'Private fighter-media discovery ledger. High-confidence rights-safe candidates may be promoted into ufc_images; ambiguous or non-cleared media remains review-only and is never rendered publicly.';

commit;
