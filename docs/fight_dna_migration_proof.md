# Fight DNA — migration proof and application (2026-09-06)

Migrations `002_ufc_result_enrichment.sql`, `003_ufc_rankings.sql` and
`004_ufc_fight_dna.sql` were reviewed, proven and applied to project
`tkmlnhmylqnttmnsnief` with `scripts/db/apply_migration.ps1`, which sends the
SQL through the Supabase Management API (`POST /v1/projects/{ref}/database/query`)
authenticated with the Supabase CLI's stored access token. No database
password exists on this machine and PostgREST cannot run DDL.

## Review notes (004)

- `ufc_bout_position_stats` uses a surrogate `id` primary key with partial
  unique indexes for fight-scope (`round is null`) and round-scope rows;
  Postgres cannot put a nullable column in a primary key (commit bde9cff).
- All FKs target existing tables (`ufc_fighters`, `ufc_bouts`, `ufc_events`).
- Every table has RLS enabled and no policies; the API and builders use the
  service role.
- The 19 seeded `ufc_dna_metric_definitions` rows carry formula text and
  minimum sample rules; inserts are `on conflict do nothing`.

## Proof

Each file was executed with its own `begin`/`commit` stripped inside
`BEGIN; ... ROLLBACK;` on the production engine (no side effects). All three
returned without error. They were then applied inside `BEGIN; ... COMMIT;`.

A local Docker-based `supabase start` / `db reset` (the `supabase/` folder
carries the same four migrations with timestamped names) is the
disposable-database path when Docker Desktop is running.

## Verification after apply

PostgREST returns 200 for `ufc_rankings` (206 rows after the first ingest),
`ufc_dna_metric_definitions` (19 rows), `ufc_fighter_bout_features`,
`ufc_fighter_dna_snapshots`, `ufc_fighter_stance_splits`,
`ufc_bout_position_stats`, `ufc_bout_finish_enrichment`, `ufc_action_events`,
`ufc_dna_build_runs`; `ufc_bout_results.stats_captured_at` and
`stats_source_url` now exist (null until the enrichment backfill sets them).
