# Phase 1 verification — 2026-09-06T01:59:54.799363+00:00

Project `tkmlnhmylqnttmnsnief`. Read-only, service role + local HTML cache.

## 1. Row counts

| Table | Rows |
|---|---|
| ufc_fighters | 77 |
| ufc_events | 762 |
| ufc_bouts | 39 |
| ufc_bout_results | 36 |
| ufc_bout_round_stats | 124 |
| ufc_fighter_aliases | 136 |
| ufc_alias_review_queue | 2 |
| ufc_ingest_runs | 8 |

## 2. Archived completed-list capture vs ufc_events

This measures coverage of ONE archived UFC Stats completed-list capture (Wayback timestamp 20260216225116; newest event on it: UFC Fight Night: Strickland vs. Hernandez 2026-02-21), not of the live site. Events after that cutoff enter through ESPN.
Capture lists 762 events; 762 are in ufc_events with that ufcstats_id; missing 0 (100% of the capture).

## 3. Bouts per event vs event page

Cached event pages checked: 2. Mismatches: 0.

## 4. Results without round stats

12 of 36 results have has_stats=false (12 are ESPN-sourced results whose UFC Stats page has not been ingested yet).

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

Cached fighter pages checked: 53. Mismatches (UFC-linked history vs db bouts): 13.

- Anthony Hernandez: history rows 12 (UFC-linked 0) vs db bouts 1
- Melquizael Costa: history rows 9 (UFC-linked 1) vs db bouts 2
- Luis Gurule: history rows 3 (UFC-linked 0) vs db bouts 1
- Ramiz Brahimaj: history rows 8 (UFC-linked 0) vs db bouts 1
- Michel Pereira: history rows 14 (UFC-linked 0) vs db bouts 1
- Ode Osbourne: history rows 13 (UFC-linked 0) vs db bouts 1
- Yadier del Valle: history rows 3 (UFC-linked 0) vs db bouts 1
- Bruna Brasil: history rows 7 (UFC-linked 0) vs db bouts 1
- Rizvan Kuniev: history rows 3 (UFC-linked 0) vs db bouts 1
- Farid Basharat: history rows 6 (UFC-linked 0) vs db bouts 1
- Javid Basharat: history rows 7 (UFC-linked 0) vs db bouts 1
- Dustin Jacoby: history rows 17 (UFC-linked 0) vs db bouts 1
- Jean Matsumoto: history rows 5 (UFC-linked 0) vs db bouts 1

## 6. Alias review queue and near-duplicates

Review queue: 2 rows (0 pending).
Fighter rows: 77. Exact-name collisions: 0. Near-duplicates (token-sort ratio >= 90): 0.

| Kind | Score | Names | DOBs | Records |
|---|---|---|---|---|

- queue: Javid Basharat [ufcstats] rejected candidates=1 reason=no_second_key
- queue: Melquizael Costa [ufcstats] resolved candidates=1 reason=no_second_key

## 7. Ingest runs and assertion failures

| Worker | Started | Status | events_new | bouts_new | fighters | failures |
|---|---|---|---|---|---|---|
| backfill_ufcstats | 2026-09-06T01:58:36 | success | 0 | 0 | 0 | 0 |
| backfill_ufcstats | 2026-09-06T01:45:12 | success | 0 | 1 | 0 | 0 |
| backfill_ufcstats | 2026-09-06T01:35:58 | success | 0 | 26 | 53 | 0 |
| backfill_ufcstats | 2026-09-06T01:34:32 | failed | 0 | 0 | 0 | 1 |
| backfill_ufcstats | 2026-09-06T01:05:42 | failed | 0 | 0 | 0 | 0 |
| backfill_ufcstats | 2026-09-06T00:20:11 | failed | 0 | 0 | 0 | 0 |
| backfill_ufcstats | 2026-09-06T00:19:49 | success | 761 | 0 | 0 | 0 |
| ufc-stats-ingest | 2026-09-05T23:09:56 | success | 1 | 12 | 24 | 0 |

- backfill_ufcstats: SchemaAssertion history row without data-link: 'next Sean Strickland Khamzat Chimaev Matchup Preview UFC 328' http://ufcstats.com/fighter-details/0d8011111be000b2

Wayback coverage gaps (counted, not failures): wayback_missing_fights=9, wayback_missing_fighters=2, wayback_missing_lists=1

## 8. Spot-check (compare by hand against the archived fight page)

### UFC Fight Night: Strickland vs. Hernandez (2026-02-21) — http://ufcstats.com/fight-details/dc6f6c8228390ebb

| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Melquizael Costa | 1 | 1 | 19/40 | 26/48 | 1/1 | 0 | 0 | 32 | 9/26 | 7/9 | 3/5 | 13/29 | 4/5 | 2/6 |
| Dan Ige | 1 | 0 | 7/11 | 12/16 | 1/3 | 0 | 0 | 91 | 2/5 | 2/3 | 3/3 | 7/11 | 0/0 | 0/0 |

### UFC Fight Night: Strickland vs. Hernandez (2026-02-21) — http://ufcstats.com/fight-details/dd12bf51c5ed7f1e

| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Uros Medic | 1 | 1 | 10/19 | 10/19 | 0/0 | 0 | 0 | 0 | 4/10 | 6/9 | 0/0 | 10/19 | 0/0 | 0/0 |
| Geoff Neal | 1 | 0 | 3/10 | 3/10 | 0/0 | 0 | 0 | 0 | 1/6 | 1/3 | 1/1 | 3/10 | 0/0 | 0/0 |

### UFC Fight Night: Strickland vs. Hernandez (2026-02-21) — http://ufcstats.com/fight-details/508e622130b0a84d

| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Jean-Paul Lebosnoyani | 1 | 0 | 32/38 | 43/53 | 1/4 | 0 | 0 | 106 | 22/27 | 4/5 | 6/6 | 18/23 | 2/3 | 12/12 |
| Phil Rowe | 1 | 0 | 14/26 | 15/27 | 0/0 | 0 | 0 | 7 | 10/21 | 0/0 | 4/5 | 13/25 | 1/1 | 0/0 |
| Jean-Paul Lebosnoyani | 2 | 0 | 19/32 | 26/42 | 1/4 | 0 | 0 | 109 | 10/19 | 4/8 | 5/5 | 15/26 | 4/6 | 0/0 |
| Phil Rowe | 2 | 0 | 16/31 | 20/36 | 0/0 | 0 | 0 | 3 | 10/22 | 2/4 | 4/5 | 13/28 | 3/3 | 0/0 |
| Jean-Paul Lebosnoyani | 3 | 0 | 15/41 | 15/41 | 1/1 | 2 | 0 | 102 | 8/31 | 2/4 | 5/6 | 14/38 | 0/1 | 1/2 |
| Phil Rowe | 3 | 0 | 24/54 | 24/54 | 0/0 | 0 | 0 | 5 | 22/51 | 1/2 | 1/1 | 24/54 | 0/0 | 0/0 |

### UFC Fight Night: Strickland vs. Hernandez (2026-02-21) — http://ufcstats.com/fight-details/04b7bcc0e8488604

| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Serghei Spivac | 1 | 0 | 20/46 | 20/46 | 0/0 | 0 | 0 | 0 | 20/46 | 0/0 | 0/0 | 20/46 | 0/0 | 0/0 |
| Ante Delija | 1 | 0 | 19/58 | 19/58 | 0/0 | 0 | 0 | 0 | 17/55 | 2/3 | 0/0 | 19/58 | 0/0 | 0/0 |
| Serghei Spivac | 2 | 0 | 20/41 | 34/55 | 0/0 | 0 | 0 | 68 | 20/39 | 0/2 | 0/0 | 20/40 | 0/1 | 0/0 |
| Ante Delija | 2 | 0 | 26/63 | 26/64 | 0/0 | 0 | 0 | 12 | 25/62 | 1/1 | 0/0 | 23/59 | 3/4 | 0/0 |
| Serghei Spivac | 3 | 0 | 27/62 | 48/84 | 1/4 | 0 | 0 | 112 | 25/60 | 1/1 | 1/1 | 27/62 | 0/0 | 0/0 |
| Ante Delija | 3 | 0 | 16/51 | 16/51 | 0/0 | 0 | 0 | 0 | 14/49 | 2/2 | 0/0 | 16/51 | 0/0 | 0/0 |

### UFC Fight Night: Strickland vs. Hernandez (2026-02-21) — http://ufcstats.com/fight-details/5b97f47cdd355cbe

| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Jordan Leavitt | 1 | 0 | 7/14 | 20/33 | 3/4 | 0 | 0 | 244 | 4/8 | 2/5 | 1/1 | 4/7 | 0/0 | 3/7 |
| Yadier del Valle | 1 | 0 | 3/7 | 32/38 | 0/0 | 0 | 0 | 0 | 0/4 | 2/2 | 1/1 | 2/6 | 1/1 | 0/0 |
| Jordan Leavitt | 2 | 0 | 7/19 | 15/33 | 0/2 | 0 | 0 | 182 | 2/5 | 1/10 | 4/4 | 6/18 | 0/0 | 1/1 |
| Yadier del Valle | 2 | 0 | 5/17 | 10/23 | 0/0 | 0 | 0 | 5 | 4/12 | 1/1 | 0/4 | 4/16 | 0/0 | 1/1 |
| Jordan Leavitt | 3 | 0 | 3/12 | 10/20 | 1/2 | 0 | 0 | 51 | 1/5 | 0/4 | 2/3 | 2/11 | 0/0 | 1/1 |
| Yadier del Valle | 3 | 0 | 5/18 | 34/51 | 0/0 | 0 | 0 | 132 | 0/10 | 5/5 | 0/3 | 1/14 | 0/0 | 4/4 |

