# Migration 001 verification — 2026-09-05T23:05:43.848368+00:00

Project `tkmlnhmylqnttmnsnief`. **92/92 checks passed.** Method: PostgREST with the service-role and anon keys only; no SQL / catalog access.

| Check | Result | Detail |
|---|---|---|
| table ufc_fighters columns | PASS | 27 columns |
| table ufc_fighter_aliases columns | PASS | 6 columns |
| table ufc_alias_review_queue columns | PASS | 9 columns |
| table ufc_events columns | PASS | 16 columns |
| table ufc_bouts columns | PASS | 19 columns |
| table ufc_bout_results columns | PASS | 17 columns |
| table ufc_bout_round_stats columns | PASS | 27 columns |
| table ufc_ingest_runs columns | PASS | 10 columns |
| table ufc_news_sources columns | PASS | 7 columns |
| table ufc_news_items columns | PASS | 12 columns |
| table ufc_articles columns | PASS | 19 columns |
| table ufc_images columns | PASS | 8 columns |
| no unexpected ufc_* tables | PASS | exposed=['ufc_alias_review_queue', 'ufc_articles', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_bouts', 'ufc_events', 'ufc_fighter_aliases', 'ufc_fighters', 'ufc_images', 'ufc_ingest_runs', 'ufc_news_items', 'ufc_news_sources'] |
| non-UFC exposed table list unchanged | PASS | before=30 after=30 diff=[] |
| non-UFC exposed column sets unchanged | PASS | 30 tables compared |
| fighter with no source id rejected (check constraint) | PASS | HTTP 400 {"code":"23514","details":"Failing row contains (9f09e8b2-4980-4d2b-9b7d-c49ca1ee9d91, null, null, v |
| event with no source id rejected (check constraint) | PASS | HTTP 400 {"code":"23514","details":"Failing row contains (f9f4af44-3cab-4640-9e14-9a55c0279a12, null, null, v |
| probe insert ufc_fighters (service role) | PASS | HTTP 201  |
| probe insert ufc_fighters (service role) | PASS | HTTP 201  |
| probe insert ufc_events (service role) | PASS | HTTP 201  |
| probe insert ufc_bouts (service role) | PASS | HTTP 201  |
| bad weight_class enum rejected (check constraint) | PASS | HTTP 400 |
| probe insert ufc_bout_results (service role) | PASS | HTTP 201  |
| probe insert ufc_bout_round_stats (service role) | PASS | HTTP 201  |
| probe insert ufc_fighter_aliases (service role) | PASS | HTTP 201  |
| probe insert ufc_alias_review_queue (service role) | PASS | HTTP 201  |
| probe insert ufc_ingest_runs (service role) | PASS | HTTP 201  |
| probe insert ufc_news_sources (service role) | PASS | HTTP 201  |
| probe insert ufc_news_items (service role) | PASS | HTTP 201  |
| probe insert ufc_articles (service role) | PASS | HTTP 201  |
| probe insert ufc_images (service role) | PASS | HTTP 201  |
| service role sees probe in ufc_fighters | PASS | HTTP 200 rows=2 |
| anon cannot read probe in ufc_fighters | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_fighters | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_fighters | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_fighter_aliases | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_fighter_aliases | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_fighter_aliases | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_fighter_aliases | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_alias_review_queue | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_alias_review_queue | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_alias_review_queue | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_alias_review_queue | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_events | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_events | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_events | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_events | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_bouts | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_bouts | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_bouts | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_bouts | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_bout_results | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_bout_results | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_bout_results | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_bout_results | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_bout_round_stats | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_bout_round_stats | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_bout_round_stats | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_bout_round_stats | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_ingest_runs | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_ingest_runs | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_ingest_runs | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_ingest_runs | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_news_sources | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_news_sources | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_news_sources | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_news_sources | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_news_items | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_news_items | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_news_items | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_news_items | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_articles | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_articles | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_articles | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_articles | PASS | HTTP 200 rows=0 |
| service role sees probe in ufc_images | PASS | HTTP 200 rows=1 |
| anon cannot read probe in ufc_images | PASS | HTTP 200 rows=0 |
| anon insert rejected on ufc_images | PASS | HTTP 401  |
| anon delete affects 0 rows on ufc_images | PASS | HTTP 200 rows=0 |
| cleanup ufc_images | PASS | deleted=1 |
| cleanup ufc_articles | PASS | deleted=1 |
| cleanup ufc_news_items | PASS | deleted=1 |
| cleanup ufc_news_sources | PASS | deleted=1 |
| cleanup ufc_ingest_runs | PASS | deleted=1 |
| cleanup ufc_alias_review_queue | PASS | deleted=1 |
| cleanup ufc_fighter_aliases | PASS | deleted=1 |
| cleanup ufc_bout_round_stats | PASS | deleted=1 |
| cleanup ufc_bout_results | PASS | deleted=1 |
| cleanup ufc_bouts | PASS | deleted=1 |
| cleanup ufc_events | PASS | deleted=1 |
| cleanup ufc_fighters | PASS | deleted=2 |
| zero verify-* rows remain | PASS | 12 tables swept |

## What this does and does not prove

- RLS on every `ufc_*` table is proven behaviourally: a service-role probe row exists in each of the 12 tables, the anon key cannot read it, cannot insert, and its delete affects zero rows. This does not enumerate `pg_policies`; it proves the effect.
- The non-UFC comparison proves the set of PostgREST-exposed tables and their column sets did not change between the pre-migration snapshot and now. It does NOT prove that functions, triggers, policies, grants, sequences, or other catalog objects are byte-identical; that requires catalog access this script does not have.
- Check constraints are proven by rejected inserts (at-least-one-source on fighters/events, weight_class enum on bouts).
- All probe rows are deleted in FK-safe order and a final sweep confirms zero `verify-*` residue.
