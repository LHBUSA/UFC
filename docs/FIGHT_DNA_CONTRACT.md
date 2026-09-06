# Fight DNA v1 — deterministic data contract

Shared by the feature builder (`scripts/dna/`), the API (`workers/ufc-api`)
and the web (`web/`). Implements `docs/FIGHT_DNA_V1.md` on the tables in
`migrations/004_ufc_fight_dna.sql`. `definition_version = 1` everywhere.
Nothing below may be computed from `ufc_fighters.career_*`.

## Metric object (every derived number, everywhere)

```jsonc
{
  "metric_key": "sig_landed_per_min",
  "value": 4.12,                 // number | null (null = no denominator / below minimum? NO: below minimum keeps value but confidence "insufficient")
  "unit": "per_min",             // ratio | per_min | per_15 | seconds | seconds_per_td | record | count | distribution
  "numerator": 412, "denominator": 6000,   // raw counts / seconds the value was derived from (null when not applicable)
  "sample_bouts": 5, "sample_rounds": 13, "sample_seconds": 3720,
  "confidence": "medium",        // insufficient | low | medium | high
  "coverage_status": "medium",   // same scale; reflects stat coverage of the sample
  "definition_version": 1,
  "origin": "pbe_derived",       // pbe_derived | source | licensed | model
  "source_families": ["ufcstats"],
  "as_of_date": "2026-09-06"
}
```

- Zero denominator → `value: null`, `confidence: "insufficient"`.
- Confidence tiers (v1, from `ufc_dna_metric_definitions` minimums):
  `insufficient` below `min_bouts`/`min_rounds`/`min_seconds`;
  `low` when minimum met but `sample_bouts < 3` (result metrics) or
  `sample_seconds < 1800` (rate metrics); `medium` up to `sample_bouts < 8` /
  `sample_seconds < 5400`; `high` above.
- Record objects: `{ "w": 3, "l": 1, "d": 0, "nc": 0, "appearances": 4 }`.
- Distribution objects: `{ "buckets": {"1": 2, "2": 1, "3": 0, "4": 0, "5": 0}, "total": 3 }`.

## Observed time

`observed_seconds` for a bout = sum over stat-covered rounds of the round's
observed length: 300 s for full standard rounds; a partial final round uses
`ufc_bout_results.time_sec`; `time_format` is parsed (`3 Rnd (5-5-5)`,
`5 Rnd (5-5-5-5-5)`, `3 Rnd + OT (5-5-5-5)`); any other format sets
`observed_seconds = null` and a warning. Round-specific rates use that
round's own observed seconds.

## `ufc_fighter_bout_features` (two rows per completed bout)

- `raw_stats`: `{ "rounds": [ { "round": 1, "seconds": 300, "sig_l": 32, "sig_a": 90, "tot_l":…, "td_l":…, "td_a":…, "sub":…, "rev":…, "ctrl":…, "kd":…, "head_l","head_a","body_l","body_a","leg_l","leg_a","dist_l","dist_a","clinch_l","clinch_a","ground_l","ground_a", "opp": { same keys for the opponent's row } } ], "totals": {…}, "opp_totals": {…} }`
- `features`: flat per-bout derived values (null when no denominator):
  `sig_landed_per_min, sig_absorbed_per_min, sig_accuracy, sig_defense, sig_diff_per_min, head_attack_share, body_attack_share, leg_attack_share, distance_attack_share, clinch_attack_share, ground_attack_share, kd_per_15, kd_absorbed_per_15, td_attempts_per_15, td_landed_per_15, td_accuracy, control_seconds_per_td, control_share, sub_attempts_per_15, reversals_per_15, r1_sig_att_per_min, r2_sig_att_per_min, r3_sig_att_per_min, r4_sig_att_per_min, r5_sig_att_per_min, late_round_sig_att_per_min, pace_retention_r2_vs_r1, pace_retention_r3_vs_r1, championship_round_delta, r1_absorbed_per_min, r3_absorbed_per_min, defensive_drift_r3_vs_r1, finish_round, finish_elapsed_sec`
- `stats_coverage`: `complete` when every scheduled-or-fought round has a row for both fighters, `partial` when some, `none` when zero.
- `provenance`: `{ "sources": ["espn","ufcstats"], "result_source": "espn", "round_source_url": "…", "watermark": { "results_captured_at": "…", "round_stats_captured_at": "…" }, "builder": "scripts/dna/build_fight_dna.mjs@<git-sha-or-version>" }`
- `is_main_event`: highest `bout_order` on the event.

## `ufc_fighter_dna_snapshots`

One row per fighter per `as_of_date` per version. `as_of_date` semantics are
**exclusive**: the snapshot at `D` includes bouts with `event_date < D`.
Generate a snapshot for every distinct `event_date + 1 day` in the fighter's
history plus a `current` snapshot dated today; the API resolves
`?as_of=YYYY-MM-DD` to the latest snapshot with `as_of_date <= as_of`.

- `metrics`: `{ metric_key: MetricObject }` for the striking/pace/grappling/finish keys in the registry.
- `stance_splits`: `{ "SOUTHPAW": StanceSplit, "ORTHODOX": …, "SWITCH": …, "UNKNOWN": …, "open": StanceSplit, "same": StanceSplit }` where `StanceSplit = { record, ko_tko_wins, submission_wins, decision_wins, finish_rate: MetricObject, ko_rate: MetricObject, sub_rate: MetricObject, sig_diff_per_min: MetricObject, kd_per_15: MetricObject, td_landed_per_15: MetricObject, stat_bouts, stat_rounds, observed_seconds, confidence }`.
- `round_profile`: `{ "rounds": { "1": { "sig_att_per_min": MetricObject, "sig_landed_per_min": MetricObject, "absorbed_per_min": MetricObject, "rounds": n, "seconds": s }, "2": …, "5": … }, "pace_retention_r2_vs_r1": MetricObject, "pace_retention_r3_vs_r1": MetricObject, "championship_round_delta": MetricObject, "defensive_drift_r3_vs_r1": MetricObject }`.
- `finish_profile`: `{ "finish_rate": MetricObject, "ko_finish_rate": MetricObject, "submission_finish_rate": MetricObject, "finish_round_distribution": MetricObject(distribution), "finish_time_median_sec": MetricObject, "finished_by": { "ko_tko": n, "submission": n }, "finished_by_round_distribution": … }`.
- `context_splits`: `{ "short_notice": StanceSplit-like record block, "three_round": …, "five_round": …, "title": …, "main_event": … }`.
- `position_profile`: `{}` until licensed data exists (never synthesized).
- `provenance`: `{ "bouts": [bout_id…], "watermark": {…}, "build_run_id": "…" }`.

## `ufc_fighter_stance_splits`

One row per fighter × `as_of_date` × `opponent_stance` (`ORTHODOX`,
`SOUTHPAW`, `SWITCH`, `OPEN_STANCE`, `SIDEWAYS`, `UNKNOWN`) with the counts in
the table columns and `metrics = { finish_rate, ko_rate, sub_rate,
sig_diff_per_min, kd_per_15, td_landed_per_15 }` as MetricObjects. Result
counts must reconcile exactly to `ufc_bout_results` for the fighter's bouts
before `as_of_date`.

## API shapes

- `GET /v1/ufc/dna/metrics` → the registry rows.
- `GET /v1/ufc/fighters/{id}/dna[?as_of=]` → `{ fighter: compact, snapshot: { as_of_date, definition_version, sample_*, coverage_status, metrics, stance_splits, round_profile, finish_profile, context_splits, position_profile, provenance }, meta: { resolved_as_of, requested_as_of, note } }`; `data: null` + `dna_not_available` when no snapshot.
- `/splits?opponent_stance=` → rows from `ufc_fighter_stance_splits` (latest as_of unless `as_of` given).
- `/round-profile`, `/finish-profile`, `/position-profile` → the matching snapshot family plus sample context.
- `GET /v1/ufc/matchups/{a}/{b}/dna[?as_of=]` → `{ fighters: [compact a, compact b], a: snapshot subset, b: snapshot subset, comparisons: [ { key, label, a: MetricObject|null, b: MetricObject|null, delta, direction } ], insights: [ { key, label, value, sample_bouts, sample_rounds, confidence, direction: "contextual"|"a"|"b", explanation } ], warnings: [ "…" ] }`. An insight is emitted only when the underlying metric confidence is `low` or better AND thresholds documented in the API doc are met; otherwise it goes to `warnings`.

## UI labels

`PBE DERIVED` for everything from the snapshot tables, `SOURCE` for raw
ESPN/UFC Stats facts, `LICENSED` / `MODEL` reserved. Every card shows
`sample_bouts / sample_rounds / minutes` and the confidence tier.
