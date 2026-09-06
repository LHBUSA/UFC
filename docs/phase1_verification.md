# Phase 1 verification — 2026-09-06T00:21:46.100377+00:00

Project `tkmlnhmylqnttmnsnief`. Read-only, service role + local HTML cache.

## 1. Row counts

| Table | Rows |
|---|---|
| ufc_fighters | 24 |
| ufc_events | 762 |
| ufc_bouts | 12 |
| ufc_bout_results | 12 |
| ufc_bout_round_stats | 0 |
| ufc_fighter_aliases | 41 |
| ufc_alias_review_queue | 0 |
| ufc_ingest_runs | 3 |

## 2. Completed list vs ufc_events

Cached completed list: 762 events. In ufc_events with a ufcstats_id: 762. Missing: 0 (100% coverage).

## 3. Bouts per event vs event page

Cached event pages checked: 1. Mismatches: 1.

- UFC Fight Night: Bautista vs. Oliveira (2026-02-07): page 13 vs db 0

## 4. Results without round stats

12 of 12 results have has_stats=false (12 are ESPN-sourced results whose UFC Stats page has not been ingested yet).

- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401831986 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401838016 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401833339 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401838017 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401839311 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401838015 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401839019 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401833556 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401833558 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401833559 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401833555 [espn]
- UFC Fight Night: Royval vs. Kape (2025-12-14) bout 401830372 [espn]

## 5. Fighter history vs our bouts

Cached fighter pages checked: 0. Mismatches (UFC-linked history vs db bouts): 0.

## 6. Alias review queue and near-duplicates

Review queue: 0 rows (0 pending).
Fighter rows: 24. Exact-name collisions: 0. Near-duplicates (token-sort ratio >= 90): 0.

| Kind | Score | Names | DOBs | Records |
|---|---|---|---|---|


## 7. Ingest runs and assertion failures

| Worker | Started | Status | events_new | bouts_new | fighters | failures |
|---|---|---|---|---|---|---|
| backfill_ufcstats | 2026-09-06T00:20:11 | running | 0 | 0 | 0 | 0 |
| backfill_ufcstats | 2026-09-06T00:19:49 | success | 761 | 0 | 0 | 0 |
| ufc-stats-ingest | 2026-09-05T23:09:56 | success | 1 | 12 | 24 | 0 |


Wayback coverage gaps (counted, not failures): wayback_missing_lists=1

## 8. Spot-check (compare by hand against the archived fight page)

