# PropBetEdge Fight DNA — Claude Code Execution Brief

Branch: `ufc-fight-dna-v1`
Base: accepted V3 head `a58f746e7c004f392b11396ed3720b4f028540d4`

Read first:

1. `docs/UFC_PRODUCTION_V3_ACCEPTANCE.md`
2. `docs/FIGHT_DNA_V1.md`
3. `migrations/004_ufc_fight_dna.sql`
4. `scripts/backfill/backfill_ufcstats.py`
5. `workers/ufc-api/src/index.js`

## Mission

Build PropBetEdge Fight DNA as a proprietary, deterministic, versioned analytics layer over the normalized UFC data platform.

Do not build generic fighter cards with renamed UFC Stats metrics. The product must expose matchup intelligence that is reproducible, as-of safe, sample-aware and API-native.

Do not merge to `main`.

---

# PHASE 0 — preserve V3 and prove baseline

Before any Fight DNA code:

- checkout `ufc-fight-dna-v1`
- verify branch ancestry includes accepted V3
- run existing web build/type checks
- run current UFC API tests/live smoke
- record current canonical counts
- record current round-stat coverage
- do not modify V3 visual/news behavior unless Fight DNA integration requires additive UI changes

Expected current gap from the accepted report: only a small subset of canonical bouts has round stats. Treat that as a coverage problem, not a reason to fake DNA.

---

# PHASE 1 — historical round-stat coverage is the first priority

Fight DNA quality depends on UFC Stats historical round coverage.

Audit `scripts/backfill/backfill_ufcstats.py` and determine the exact remaining enrichment universe:

- canonical completed bouts
- bouts with `ufcstats_id`
- results with/without `stats_captured_at`
- bouts with zero round rows because the source legitimately has no stats
- unresolved UFCStats linkage
- archived-page failures
- parser failures

Create a deterministic coverage report with at minimum:

- canonical completed bouts
- UFCStats-linked completed bouts
- enrichment attempted
- enrichment complete
- legitimate no-stats
- unresolved link
- source unavailable/archive unavailable
- parser/error
- round rows
- fighters represented
- date range covered

Never call historical coverage 100% unless the denominator and exclusion categories are explicit.

Continue the existing backfill safely. Persist errors; do not erase ESPN result truth. Existing rules still apply: ESPN remains schedule/result identity, UFC Stats enriches stats.

Fight DNA must be able to run incrementally while coverage continues.

---

# PHASE 2 — apply/test the Fight DNA schema safely

Migration: `migrations/004_ufc_fight_dna.sql`.

Do not apply blindly.

First:

- lint/review SQL
- verify all FK/table/enum assumptions against current production schema
- verify nullable round primary-key behavior for `ufc_bout_position_stats`; Postgres primary-key semantics may require a surrogate key or separate round/fight uniqueness indexes because PK columns cannot be null
- patch the migration if necessary before applying
- run on a disposable/dev database or equivalent local/schema proof if available
- only then apply through approved Supabase migration tooling

All tables remain RLS-on, no public policies. API/Workers read with service role.

---

# PHASE 3 — deterministic feature builder

Create a dedicated module, e.g.:

`scripts/dna/build_fight_dna.mjs`

plus tests/fixtures.

Requirements:

## 3.1 Source rows

Read only canonical UFC tables and approved enrichment tables:

- `ufc_fighters`
- `ufc_events`
- `ufc_bouts`
- `ufc_bout_results`
- `ufc_bout_round_stats`
- future `ufc_bout_position_stats`
- future `ufc_bout_finish_enrichment`

Do not use career snapshot fields as historical model inputs.

## 3.2 Per-bout features

For each completed bout create TWO `ufc_fighter_bout_features` rows, one from each fighter's perspective.

Populate:

- fighter/opponent/event ids
- event date
- fighter stance / opponent stance
- stance context (`same`, `open`, `switch_involved`, `unknown`)
- outcome
- method
- scheduled rounds
- title/main-event flags
- short-notice days
- stat coverage
- round rows
- observed seconds
- raw source totals
- derived per-bout features
- provenance/watermark

Per-bout derived features when supported:

- sig landed/attempted
- sig absorbed/attempted by opponent
- sig differential
- head/body/leg attack shares
- distance/clinch/ground attack shares
- knockdown rates
- TD attempts/landed/accuracy
- control seconds / TD landed
- sub attempts
- reversals
- round-specific significant-strike pace
- R2/R1 and R3/R1 pace retention

No denominator -> null, not zero.

## 3.3 Observed time

Use actual elapsed fight time where the result supports it:

`(ending_round - 1) * standard_round_seconds + ending_time_sec`

Validate unusual round formats before assuming 300-second rounds. Do not silently apply a 5-minute denominator to a nonstandard historical format.

Round-specific rates need their own observed-time denominator for a partial final round.

## 3.4 Opponent pairing

Opponent absorbed stats must come from the opponent's rows for the same bout/round, never from a career snapshot.

## 3.5 Idempotence

Same source rows + same feature version = byte-equivalent logical feature values.

Use upserts keyed by the schema contract; reruns must not duplicate rows.

---

# PHASE 4 — as-of snapshots

Build `ufc_fighter_dna_snapshots` from per-bout features.

Generate snapshots at meaningful historical boundaries, at minimum after each fighter's completed event date and a current snapshot.

Historical matchup query rule:

For a bout on `YYYY-MM-DD`, model/matchup features must come from data strictly before that bout. If a stored snapshot includes a bout on the same date, the API/query layer must choose the prior snapshot or rebuild with an exclusive cutoff.

Snapshot families:

- stance
- striking
- pace
- grappling
- finish
- context
- future position

Every metric object must expose evidence such as:

```json
{
  "value": 0.73,
  "unit": "ratio",
  "sample_bouts": 5,
  "sample_rounds": 13,
  "sample_seconds": 3720,
  "confidence": "medium",
  "coverage_status": "medium",
  "definition_version": 1
}
```

Do not strip sample context from API responses.

---

# PHASE 5 — stance splits first flagship output

Stance splits are the first Fight DNA feature that can use broad result coverage even before full round-stat completion.

Build `ufc_fighter_stance_splits` for:

- ORTHODOX
- SOUTHPAW
- SWITCH
- other supported listed stance values

For each:

- appearances
- W/L/D/NC
- KO/TKO wins
- submission wins
- decision wins
- finish rate
- KO rate
- sub rate
- stat-covered bouts/rounds/time
- sig differential/min where covered
- KD/15 where covered
- TD landed/15 where covered
- sample/confidence

Acceptance query examples:

- fighter's record vs SOUTHPAW
- fighters with >= N southpaw appearances sorted by KO/TKO rate
- open-stance versus same-stance result comparison

Do not imply causality from stance splits.

---

# PHASE 6 — Fight DNA API

Extend `workers/ufc-api` additively.

Required routes:

- `GET /v1/ufc/dna/metrics`
- `GET /v1/ufc/fighters/{id}/dna`
- `GET /v1/ufc/fighters/{id}/dna?as_of=YYYY-MM-DD`
- `GET /v1/ufc/fighters/{id}/splits?opponent_stance=SOUTHPAW`
- `GET /v1/ufc/fighters/{id}/round-profile`
- `GET /v1/ufc/fighters/{id}/finish-profile`
- `GET /v1/ufc/fighters/{id}/position-profile`
- `GET /v1/ufc/matchups/{fighterA}/{fighterB}/dna`

Update:

- OpenAPI
- `docs/ufc_api_v1.md` or a versioned DNA API doc
- unit tests
- live smoke

### Matchup DNA

The matchup endpoint should contextualize each fighter against the opponent actually in front of them.

Example when B is southpaw:

- A history vs southpaws
- B history vs A's stance
- A/B pace retention
- target/phase shares
- TD/control mismatch
- finish windows
- coverage caveats

Return structured `insights[]` only when thresholds are met:

```json
{
  "key": "a_vs_southpaw_finish_rate",
  "label": "Finish history vs southpaws",
  "value": 0.60,
  "sample_bouts": 5,
  "confidence": "medium",
  "direction": "contextual",
  "explanation": "..."
}
```

No LLM is required to compute the metric. Explanatory text can be deterministic/template-driven at first.

---

# PHASE 7 — fighter and matchup UI

Integrate into V3 without regressing the accepted design.

## Fighter page

Add a premium `FIGHT DNA` section with tabs/cards:

- Stance DNA
- Striking DNA
- Grappling DNA
- Round Profile
- Finish Profile
- Context Splits

Each card displays sample context.

Use explicit origin labels:

- `PBE DERIVED`
- `SOURCE`
- future `LICENSED`
- future `MODEL`

Never make a derived metric look like an official UFC statistic.

## Matchup page

Add `DNA MATCHUP`:

- stance-history comparison
- pace retention
- target-share mismatch
- phase-share mismatch
- grappling/control mismatch
- finish timing/profile
- strongest supported observations
- counter-case / missing-data warning

This should feed the existing Bettor's Edge module, but Fight DNA is evidence, not a pick by itself.

---

# PHASE 8 — position + finishing-weapon enrichment

Research/licensing work can proceed in parallel.

The database already has placeholders in migration 004 for:

- `ufc_bout_position_stats`
- `ufc_bout_finish_enrichment`

Do not ingest a commercial provider without confirming license/redistribution terms.

When approved, normalize source facts such as:

- back control
- mount
- side control
- guard / half guard
- ground / standing / distance / clinch time
- finishing weapon
- finishing target
- finishing position
- submission technique

Then derive PBE metrics:

- dominant-position share
- back-control share
- ground-control quality
- takedown-to-control yield
- position-to-damage conversion
- finish weapon distribution
- finish position distribution

Raw provider fields and PBE-derived redistribution rights are separate legal questions; document both.

---

# PHASE 9 — action events / technique taxonomy

Do not promise `roundhouse kick` frequency until a source legitimately supports technique-level events.

Future table: `ufc_action_events`.

If licensed action data exists, use its taxonomy exactly and map into the normalized taxonomy conservatively.

If future computer vision is used:

- only on media we have lawful rights to process for this purpose
- preserve source media reference
- model/version
- confidence
- raw label
- normalized label
- human review state
- never include low-confidence model events in public aggregates

Build a labeled validation set before public technique metrics.

Target future metrics may include:

- jab attempts/min
- calf kicks/round
- head-kick attempts/fight
- roundhouse attempts/fight
- setup sequence frequencies
- strike combinations
- attack selection by opponent stance
- technique success by position / round

These are Phase 3+ of Fight DNA, not fabricated v1 fields.

---

# PHASE 10 — archetypes and opponent-adjusted features

Only after historical source coverage is broad enough.

Build explainable as-of vectors and cluster them offline/versioned.

Possible validated labels:

- pressure striker
- kick-heavy distance striker
- counter southpaw
- low-volume power striker
- chain wrestler
- control grappler
- submission hunter
- mixed-phase pressure fighter

Then develop opponent-adjusted residual features.

Do not hand-label the fighter and pretend clustering found it.

---

# QA / acceptance matrix

Fight DNA v1 is acceptable only when:

1. 004 schema passes review and migration proof.
2. Existing UFC product/API remain green.
3. Builder tests use deterministic fixtures.
4. Same input -> same output proof passes.
5. Stance result splits reconcile exactly to canonical results.
6. Opponent absorbed stats reconcile to paired fighter rows.
7. Historical as-of test proves future fight rows are excluded.
8. Partial-round denominator test passes.
9. Zero-denominator metrics return null.
10. Low sample stays visibly low/insufficient.
11. Builder persists build-run status, counts, warnings and errors.
12. API covers high/low/zero-stat fighters.
13. API supports a fighter vs SOUTHPAW split.
14. Matchup endpoint does not fabricate an insight below thresholds.
15. UI labels PBE-derived features as derived.
16. Desktop/mobile screenshots are clean.
17. V3 live wire/newsroom/article modules are unchanged except additive DNA evidence hooks.
18. OpenAPI/docs describe every new route/field.
19. No secrets committed.
20. Nothing merged to main without a final Fight DNA acceptance report.

## First milestone

The first milestone should be demonstrable without licensed third-party data:

> A real UFC fighter page can show record / finish split versus SOUTHPAW opponents plus round-level pace / target / phase metrics from covered fights, with sample sizes, provenance and confidence; the matchup page can contextualize those exact features against the next opponent; the API returns the same structures.

Then expand the historical round-stat universe until those features become broadly useful.

## North star

Build the system so a future query can truthfully answer:

> Show active fighters who retain >=90% of round-one significant-strike attempt pace into round three, have strong covered takedown defense, and historically show a materially different result/finish profile against southpaws — with every denominator, sample and source explainable.

No black box. No fake precision. Own the feature system.
