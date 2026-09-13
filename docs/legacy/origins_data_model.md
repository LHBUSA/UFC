# UFC Legacy / Origins data model: proposal + rollback proof

Branch `ufc-legacy-origins-v1`. Migration `supabase/migrations/20260913140000_ufc_legacy_origins.sql`
(sha256 `c6e3162d…9f84`).

## Production status (2026-09-13)

**APPLIED.** The migration and the first repair were applied in one transaction by session goodl-be, after the owner's approval.

- **Order:** privilege hardening `20260913000005` first (proof 16/16, live verify 16/16), then this migration with the repair.
- **Plan:** `589ab62c…7491`. It was regenerated against current production, and its content equals the original plan except for two owner decisions:
  - the three new identities get DOB NULL (ESPN is the only source);
  - UFC 1 referee claims come from both ESPN and Sherdog, with the canonical referee left NULL.
- **Proofs:**
  - BEGIN…ROLLBACK proof 105/105, including current-main checks: out-of-scope table counts, DWCS byte-identity, and the 022 privilege posture;
  - commit-time assertions 89/89;
  - fresh-connection verify 36/36 against a fingerprint captured before the apply.
- **Production result:**
  - UFC 1 added: 1 event, 8 bouts, 8 whole-fight results, and 3 new fighters (Gordeau, Tuli, Jimmerson, DOB NULL). The review rows are resolved and keep their evidence.
  - Period semantics written on the 440 pre-2005 results: 31 whole fight, 53 single period, 88 regulation, 29 overtime, 239 rounds.
  - 54 ESPN event IDs filled.
  - 69 claims: 53 ESPN venue claims and 16 UFC 1 referee claims (8 ESPN, 8 Sherdog; 8 open across the 4 disagreeing bouts).
  - 0 canonical venue writes, 0 resolutions, 0 tournaments.
- **Raw fingerprints unchanged:** results, bouts, events (excluding the ESPN ID fill), round stats, videos, DWCS claims and resolutions, and existing fighters.
- **Evidence:** everything is in `docs/legacy/proof/`.

## Principle

The source's words stay where they are. Our interpretation lives in new columns beside them.

- `ufc_bout_results.round`, `time_format`, `weight_class_raw` and `is_title` keep their imported values.
- Every change a repair makes to a canonical row writes its before and after image to `ufc_legacy_repair_ledger`.
- Competing facts coexist as claims. What gets displayed is decided separately, in resolutions.

## Tables and columns

| Object | Kind | Purpose |
|---|---|---|
| `ufc_time_format_structure(text)` | function, immutable | Parses the verbatim format into `untimed`, `single_period`, `regulation_overtime`, `rounds` or `unparsed`. It returns `unparsed` rather than guessing. |
| `ufc_bout_results` + `period_structure`, `ending_period_kind`, `ending_period_number`, `elapsed_fight_sec`, `period_semantics_basis`, `period_semantics_version` | columns | Interpretation beside raw `round`/`time_sec`. `ending_period_kind` is one of `whole_fight`, `regulation_period`, `overtime`, `round`. |
| `ufc_bout_round_stats_periods` | view, security_invoker | Each stat row labelled Whole fight / Regulation / Overtime n / Round n. Derived, not stored. |
| `ufc_bouts` + `ruleset_id` → `combat_rulesets`, `ruleset_basis` | columns | Link to the existing ruleset model. |
| `ufc_bouts` + `historical_weight_limit_text`, `historical_weight_min_lbs`, `historical_weight_max_lbs`, `historical_limit_basis`, `historical_division_label`, `title_kind`, `title_label_raw`, `historical_semantics_evidence` | columns | Period-correct division and title reading. `weight_class` and `is_title` are unchanged. |
| `ufc_event_fact_keys` | table (seeded, 21 keys) | Controlled vocabulary for claims |
| `ufc_event_fact_claims` | table, append-only | One sourced statement: raw and normalized value, source type, tier 1–5, locator, verification, conflict group/state |
| `ufc_event_fact_resolutions` | table | Which claim is displayed, and under which rule |
| `ufc_event_fact_display` | view, security_invoker | Resolved value plus the count of competing claims |
| `ufc_tournaments`, `ufc_tournament_entries`, `ufc_tournament_advancements` | tables | Bracket graph. `bout_id` is NULL for every non-bout advancement. |
| `ufc_legacy_repair_ledger` | table, append-only | Before/after images keyed to the reviewed plan's sha256 |
| `combat_sources` rows `nsac` (approved), `nj_sacb` (review, disabled), `pbe_legacy_curated` (internal) | reference data | `ufc_official` stays disabled |
| `ufc_videos.video_type` + `event_replay` | check widened (superset) | External Fight Pass references. Existing readers filter `provider=youtube`, so these rows are invisible to them. |

## Constraints that carry the rules

- **Period coherence.** A result is either wholly uninterpreted or wholly coherent.
  - `untimed` → `whole_fight`, period 1. `single_period` → `regulation_period`, period 1.
  - `regulation_overtime` → regulation period 1 or overtime n. `rounds` → round n.
  - Every field is required explicitly. The first proof run caught a NULL-passes-CHECK hole here.
- **No normalized weight limit without a stated basis** (same NULL fix).
- **Claims:**
  - A DELETE trigger refuses deletion.
  - An UPDATE trigger freezes event, bout, key, value, source and hash; only verification, conflict and notes may change.
  - `promotion_official` claims can't be tier 1 or 2; commission and public records must be tier 1.
  - Every claim needs a URL or a locator; an open conflict needs a group.
- **Resolutions:**
  - The composite FK `(selected_claim_id, event_id, fact_key)` forces the selected claim to be about the same fact.
  - A trigger refuses rejected claims.
  - A trigger refuses a UFC.com (`promotion_official`) claim against a disagreeing claim, unless `resolution_rule='operator_decision'`.
- **Tournaments:**
  - `bout_win`, `bout_loss` and `no_contest` require `bout_id`. `bye`, `walkover`, `withdrawal_replacement`, `alternate_insertion` and `default_win` forbid it.
  - A replacement must name who it replaces.
  - A trigger requires entries and bouts to belong to the tournament's own event.
  - An entry needs a canonical `fighter_id` or an `ufc_alias_review_queue` row; no invented IDs.

## Enum / value strategy

Closed sets use `text` plus `CHECK`, as everywhere else in this schema; there are no Postgres enum types. The one open vocabulary, fact keys, is a reference table with an FK, so adding a key is an insert, not a migration.

## Foreign keys

- **Legacy columns and claim tables:** `ufc_bouts.ruleset_id` → `combat_rulesets`. Claims and resolutions → `ufc_events`, `ufc_bouts`, `ufc_event_fact_keys`, `combat_sources`.
- **Tournament tables:**
  - Tournaments → `ufc_events` and `ufc_fighters` (winner).
  - Entries → tournaments, `ufc_fighters` and `ufc_alias_review_queue`.
  - Advancements → tournaments, entries (entry, opponent, replaced) and `ufc_bouts`.
- All of them are `on delete restrict`.

## Privileges

- RLS is on with no policies.
- anon and authenticated get nothing.
- service_role gets select/insert/update on claims, resolutions and tournaments; select/insert on the ledger; select on the views. It has no DELETE or TRUNCATE anywhere new.
- Trigger functions are revoked from public.

## Compatibility with current pages

- No existing column is renamed, dropped or retyped.
- Every dependent view still selects, and its counts are unchanged except `combat_career_bouts` (+4, from UFC 1 in the proof):
  - `ufc_bout_scorecards`, `ufc_judge_bouts`, `ufc_judge_stats`
  - `ufc_scorecard_coverage`, `ufc_scorecard_gaps`
  - `ufc_referee_bouts`, `ufc_referee_stats`
  - `ufc_weigh_in_current`, `combat_career_bouts`
- The web's `RESULT_COLS` select still works.
- Pages keep rendering exactly as today until the UI reads the new columns; that is a separate, later change.

## Rollback proof (production, BEGIN … ROLLBACK)

`scripts/legacy/prove_first_repair.py`. Result: `docs/legacy/proof/first_repair_proof_result.json`.

- **91 of 91 assertions passed** against plan `2b6a372c…d581` and the exact committed migration hash.
- Raw columns of every pre-existing `ufc_bout_results`, `ufc_bouts` and `ufc_events` row are unchanged (md5 fingerprints before and after). `ufc_bout_round_stats` and `ufc_videos` are also unchanged.
- **Post-rollback check from a new session:** 0 new tables, columns, views or functions; 0 UFC 1 rows; 0 ESPN IDs filled; 0 review rows; 0 packets; 0 source rows; the `video_type` check is still the original.

## First data repair: exact rows

Full list: `docs/legacy/first_repair_rows.csv` (594 rows, plan sha in its header).

| Step | Table | Rows | What |
|---|---|---|---|
| 3 UFC 1 | `ufc_alias_review_queue` | 3 insert | Gerard Gordeau, Teila Tuli, Art Jimmerson. The resolver found **0 candidates** for each. |
| 3 | `ufc_fighters` | 3 insert, **after review** | UFCStats and ESPN IDs from the evidence. DOB NULL for all three; ESPN's Gordeau DOB is kept as review evidence only. |
| 3 | `ufc_events` | 1 insert | UFC 1, 1993-11-12, Denver. venue NULL. |
| 3 | `ufc_bouts` / `ufc_bout_results` | 8 + 8 insert | ESPN core agrees with the UFCStats capture on every winner, method, round and time. referee NULL (conflict). |
| 3 | `ufc_event_fact_claims` | 17 insert | 8 ESPN + 8 Sherdog referee claims in group `ufc1-referee` (open on the 4 bouts where they disagree) and 1 venue claim |
| 3 | `combat_ingest_packets` | 12 insert | Source `ufc_canonical`, validated |
| 4 | `ufc_bout_results` | 440 update (new columns only) | 31 untimed/whole_fight, 53 single_period, 88 regulation_period, 29 overtime, 239 round |
| 5 | `ufc_events.espn_event_id` | 54 update (NULL → id) | Every legacy event, each ID unique |
| 5 | `ufc_event_fact_claims` | 53 insert | ESPN venue names. UFC 27 and 43 have none. |
| 6 | none | 0 | All 6 polluted judge strings already resolve through `ufc_judge_aliases` |

## Deviations from the approved order, and why

- **Venue (step 5): claims only; `ufc_events.venue` stays NULL.** ESPN renders current venue names, which are anachronistic:
  - UFC 42 (2003) "Kaseya Center"
  - UFC 32 (2001) "Izod Center"
  - UFC 41 and 50 "Jim Whelan Boardwalk Hall"
  - UFC 21 (1999) "U.S. Cellular Center"
  - UFC 5 (1995) "Bojangles Coliseum"

  Filling the canonical column would write a wrong historical fact. The display value comes from a resolution once a period-correct claim exists.
- **Judge fields (step 6): no table writes.** The raw-plus-canonical mechanism already exists (`ufc_judge_aliases` with `card_note`).
- **UFC 1 packets use source `ufc_canonical`, not `espn`.** `combat_guard_fact_source` only accepts `approved_ingest` sources in `combat_ingest_packets`, and ESPN is `identity_only` there. ESPN and UFCStats are named inside each payload. Rulesets (step 7) will use `pbe_legacy_curated` for the same reason.
- **Semantics are written for events dated ≤ 2004-12-31 only.** Later results stay NULL and keep today's behaviour.

## Not in this migration

- No event/bout media table. UFC.com media is excluded by decision, and no other event-level source currently qualifies. Commons portraits use the existing fighter-media pipeline.
