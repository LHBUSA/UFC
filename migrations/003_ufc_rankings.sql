-- PropBetEdge UFC — 003: official UFC rankings snapshots (ufc.com/rankings)
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. One row per (snapshot day, division, rank slot). rank 0 is
-- the champion, 1..15 the ranked contenders. Pound-for-pound lists are the
-- division 'P4P' (is_p4p = true) and carry no rank-0 row: their #1 is rank 1.
--
-- The unique key is wider than (snapshot_date, division, rank) on purpose:
--   * is_womens: men's and women's FLYWEIGHT / BANTAMWEIGHT share a division
--     key, and both P4P lists are 'P4P'; without it the second list is unwritable.
--   * name_raw: ufc.com prints competition-style ties (2026-09-06: Ciryl Gane
--     and Joshua Van both #10 in men's P4P, next slot 12). Two rows at the same
--     rank on the same day are legitimate and must both be stored.
--
-- Until this migration is applied, scripts/rankings/ingest_rankings.mjs
-- treats PostgREST's 404 on ufc_rankings as "not applied yet", keeps writing
-- the Storage snapshot (ufc-media/rankings/latest.json) and exits 0. Once the
-- table exists the same script starts upserting into it with no code change.
--
-- Run once in the Supabase SQL editor. Safe to re-run: every statement is
-- guarded with `if not exists`.

begin;

create table if not exists public.ufc_rankings (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  division text not null
    check (division in ('STRAWWEIGHT','FLYWEIGHT','BANTAMWEIGHT','FEATHERWEIGHT','LIGHTWEIGHT','WELTERWEIGHT','MIDDLEWEIGHT','LIGHT_HEAVYWEIGHT','HEAVYWEIGHT','P4P')),
  is_womens boolean not null,
  is_p4p boolean not null,
  rank int not null check (rank >= 0),         -- 0 = champion, 1..15 = ranked
  fighter_id uuid references public.ufc_fighters(id),   -- null until the alias resolver links unambiguously; never guessed
  name_raw text not null,                       -- verbatim name from ufc.com
  ufc_slug text,                                -- /athlete/<slug> on ufc.com
  rank_change int,                              -- signed; positive = moved up; 0 = unchanged; null = unknown / new entry
  is_new boolean not null default false,        -- ufc.com printed "NR" (not previously ranked)
  source_url text not null,
  captured_at timestamptz not null default now(),
  unique (snapshot_date, division, is_womens, rank, name_raw),
  check (is_p4p = (division = 'P4P')),
  check (not (is_p4p and rank = 0))
);
comment on column public.ufc_rankings.rank is '0 = champion, 1..15 = ranked contender (competition ranking: ties share a rank and the next slot is skipped). P4P lists have no rank 0.';
comment on column public.ufc_rankings.rank_change is 'Signed movement since the previous official update. Positive = moved up. Null when unknown (e.g. new entry).';

create index if not exists ufc_rankings_division_idx
  on public.ufc_rankings (division, is_womens, snapshot_date desc);
create index if not exists ufc_rankings_fighter_idx
  on public.ufc_rankings (fighter_id);
create index if not exists ufc_rankings_snapshot_idx
  on public.ufc_rankings (snapshot_date desc);

-- RLS on, no policies: service-role writes only, same as every other ufc_* table.
alter table public.ufc_rankings enable row level security;

commit;
