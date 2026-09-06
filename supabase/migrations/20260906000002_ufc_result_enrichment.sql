-- PropBetEdge UFC — 002: UFC Stats enrichment markers on results
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. ESPN is the primary result source; UFC Stats enriches a
-- result with round stats, judges and scorecards. A result row needs to say
-- WHEN and FROM WHERE that enrichment happened, independently of
-- has_stats (a legitimate UFC Stats fight can have no round stats and must
-- not be re-fetched forever).
--
-- Until this migration is applied the backfill falls back to
-- "enriched = has_stats or result_source = 'ufcstats'" and re-parses
-- no-stats ESPN fights from its local cache on every run (no network cost).

begin;

alter table public.ufc_bout_results
  add column if not exists stats_source_url text,            -- UFC Stats fight page the enrichment came from
  add column if not exists stats_captured_at timestamptz;    -- when the UFC Stats page was parsed (null = not yet enriched)

comment on column public.ufc_bout_results.stats_captured_at is 'Set when the UFC Stats fight page was parsed, even if it carried no round stats. Null = UFC Stats enrichment pending.';

create index if not exists ufc_bout_results_enrich_idx
  on public.ufc_bout_results (stats_captured_at) where stats_captured_at is null;

commit;
