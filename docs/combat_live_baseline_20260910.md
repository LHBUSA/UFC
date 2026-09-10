# UFC + Combat Career Graph live baseline — 2026-09-10

This snapshot was measured directly against the production Supabase project
after `combat_career_graph_v1`, `combat_expansion_layers_v1`, and
`combat_privilege_hardening_v1` were applied. It supersedes older historical
backfill counts when those documents disagree with the figures below.

## UFC structural graph

The UFC event/fight graph is no longer the primary coverage problem.

- 882 completed events
- 882 / 882 completed events have bout rows (100%)
- 9,340 completed/result-bearing bouts
- 9,336 / 9,340 have stored results
- 9,315 / 9,340 have a stored referee
- 8,912 / 9,340 have round-stat rows
- 41,930 total `ufc_bout_round_stats` rows
- 9,418 total UFC bout rows including non-completed/upcoming rows

`combat_career_bouts` reproduces all 9,418 canonical UFC bout rows exactly as
`source_scope='ufc'`. There are zero external combat bouts at this baseline.

## Remaining UFC depth gaps

### Round statistics

428 completed/result-bearing bouts currently lack round rows.

Missing round-stat bouts by year:

| year | missing |
|---:|---:|
| 2026 | 37 |
| 2025 | 60 |
| 2024 | 44 |
| 2023 | 37 |
| 2022 | 40 |
| 2021 | 36 |
| 2020 | 38 |
| 2019 | 37 |
| 2018 | 44 |
| 2017 | 30 |
| 1998 | 4 |
| 1997 | 2 |
| 1996 | 7 |
| 1995 | 6 |
| 1994 | 2 |

The normal production round-stat worker is still governed by the existing UFC
Stats source/challenge policy; this baseline does not relax it.

### Scorecards / judges

Use decision bouts as the denominator, not all fights:

- 4,292 decision/draw bouts
- 4,032 have normalized scorecards
- 4,032 have judge names
- 12,082 scorecard rows
- 260 decision/draw bouts are in the scorecard gap model

Current gap classifications:

| classification | reason | count |
|---|---|---:|
| source_unavailable | event_series_not_covered_by_source | 139 |
| source_unavailable | no_scorecard_recorded_upstream | 56 |
| recoverable | scores_present_judges_unnamed_upstream | 42 |
| recoverable | ufcstats_fight_page_identified | 16 |
| identity_mismatch | espn_row_unmatched_at_ingested_event | 5 |
| non_standard | tournament_era_time_expired_no_decision | 2 |

So 260 is not the actionable number. The immediately classified recoverable
bucket is 58 bouts; source-unavailable and non-standard rows must remain honest
rather than being fabricated.

### Other UFC-native layers

- `ufc_bout_finish_enrichment`: 0 rows at baseline
- `ufc_bout_position_stats`: 0 rows at baseline
- `ufc_weigh_in_results`: 90 readings across 4 events
- `ufc_fighter_status_events`: 6 rows
- `ufc_images`: 540 rows across 537 fighters (portrait/media work is a separate
  active workstream and these figures will move)
- `ufc_videos`: 147 rows
- `ufc_market_observations`: 352 rows
- latest rankings snapshot: 2026-09-10, 206 / 206 rows identity-linked

## Combat identity bridge

The cross-promotion identity shell is live and complete against the current UFC
fighter table:

- 3,178 UFC fighters
- 3,178 / 3,178 linked `combat_fighters`
- 2,756 UFC Stats IDs in `ufc_fighters`
- 2,756 / 2,756 bridged UFC Stats identities
- 1,324 ESPN athlete IDs in `ufc_fighters`
- 1,324 / 1,324 bridged ESPN identities
- 0 bridge identity reviews
- 0 external combat events
- 0 external combat bouts
- 0 staged external packets

The zero external count is intentional. Source rights gates are live before the
first non-UFC fact is allowed into canonical `combat_*` tables.

## Source enforcement proof

Production privileges after hardening:

- `service_role`: SELECT on all 27 combat relations
- `service_role`: INSERT + UPDATE on the 24 writable combat tables
- no service-role DELETE/TRUNCATE privilege on combat relations
- no anon/authenticated combat relation grants

A production canary attempted to insert a `combat_events` row from the disabled
`ufcalendar` source. The database source trigger rejected it and the canary left
zero rows. Source policy is therefore enforced by Postgres, not only by worker
code or documentation.

## Initial external-source decision

Do not fill the MMA graph by scraping whatever is easiest.

- UFC Stats + ESPN: identity namespaces already present in the UFC graph; this
  does not authorize a new cross-promotion collection path.
- Wikidata: approved open-data identity/reference source (CC0), but not deep
  enough to supply full fight careers.
- Combat Registry / MixedMartialArts.com: blocked for automated access in
  `combat_sources` unless written permission/data agreement changes the state.
- Fight Forensics: held for reference/evaluation because its current API terms
  conflict with the intended bulk/systematic Career DNA warehouse/model use.
- UFCalendar Fight API: first commercial API candidate to evaluate; current paid
  terms support commercial display/analysis, while raw/bulk redistribution has
  stronger plan/contract requirements. It remains `review_required` until the
  exact persistence/downstream rights are confirmed.
- SportsDataIO / Sportradar: commercial candidates, held until contract scope is
  known.

## Pilot

The first Career DNA ingest target is 100 UFC-linked fighters, ordered by:

1. current champion/ranked status;
2. next three announced cards;
3. active status;
4. zero external career rows;
5. availability of both already-verified UFC Stats + ESPN identity namespaces.

At baseline the first queue is dominated by current ranked/card-relevant names,
including Mackenzie Dern, Jean Silva, Islam Makhachev, Joshua Van, Khamzat
Chimaev, Merab Dvalishvili, Valentina Shevchenko, Zhang Weili, Alex Pereira,
Alexander Volkanovski and other ranked fighters.

Generate it from the current database with:

```bash
node scripts/combat/build_pilot_queue.mjs --limit 100 --json logs/combat-pilot.json
```

Evaluate a single UFCalendar career without any database write with:

```bash
UFCAL_KEY=... node scripts/combat/ufcalendar_probe.mjs --slug <fighter-slug>
```

## Next acceptance gate

Before enabling the first external career adapter:

1. verify provider plan permits the persistence and derived use we need;
2. run 5–10 high-value fighters through the read-only provider probe;
3. compare their UFC portion against our canonical graph (identity, opponent,
   date, method, round/time) and require near-zero unexplained disagreement;
4. measure how many verified non-UFC bouts the provider adds;
5. inspect ruleset/promotion/source fields needed to keep Career DNA separate
   from UFC DNA;
6. only then set that concrete source to `approved_ingest` and ingest the first
   100-fighter pilot.

The objective is not maximum row count. It is a complete UFC product plus a
verified multi-promotion career graph that never silently merges identities or
mixes unlike competition samples.
