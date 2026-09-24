# PBE Fight Simulator — Phase 1 report (research / design only)

Repo: LHBUSA/UFC (`D:\Workers\ufc-propbetedge`, main a151df9). Database: Supabase `tkmlnhmylqnttmnsnief`. All counts below were read live on 2026-09-24. Nothing in the repo or the database was changed.

Verdict: **no data-integrity blocker for Phase 2 (engine).** Three items need an owner decision before Phase 4/5 (storage, UI): the same-day DNA cutoff bug, the entitlement seam, and the data-rights review for the official UFC feed in a paid product.

---

## 1. Existing data that supports v1 now

| Asset | Live count | Notes |
|---|---:|---|
| `ufc_bouts` | 9,571 | 9,500 complete, 71 announced; `scheduled_rounds`, `is_title`, `weight_class`, `model_scope` |
| `ufc_bout_results` | 9,496 | `winner_id`, `method` (KO_TKO 3,168 / SUB 1,839 / DEC_U 3,368 / DEC_S 862 / DEC_M 69 / DRAW 67 / NC 98 / DQ 25), `round`, `time_sec`, `time_format`, `finish_detail` |
| results with round stats | 8,912 | 93.8% of results; since 2015: 5,885 of 6,341 completed bouts |
| `ufc_bout_round_stats` | 42,166 rows / 8,965 bouts | per fighter per round: sig landed/att, total, head/body/leg, distance/clinch/ground, KD, TD landed/att, sub att, reversals, control sec |
| `ufc_fighter_bout_features` | 18,764 rows | 17,930 `complete`, 834 `none`, 0 `partial`; `raw_stats.rounds[]` carries self + opponent per round |
| `ufc_fighter_dna_snapshots` | 54,543 | definition_version 1; as-of dated; 700 dated today; coverage tiers stored |
| `ufc_dna_metric_definitions` | 60 | striking / pace / grappling / finish / stance / context |
| `ufc_model_versions` | 1 live | `pbe-fight-model-v1`, family `pbe-fight-model`, spec `75da0a1d…`, Brier 0.2363 on 7,047 scored bouts |
| `ufc_model_backtest_predictions` | 7,047 | out-of-sample champion probabilities 2013–2026, one per walk-forward fold |

Fight DNA inputs available per fighter, as-of any date (all MetricObjects with `value, numerator, denominator, sample_bouts, sample_rounds, sample_seconds, confidence, coverage_status`):
- Striking: `sig_landed_per_min, sig_absorbed_per_min, sig_diff_per_min, sig_accuracy, sig_defense, head/body/leg_attack_share, distance/clinch/ground_attack_share, knockdowns_per_15, knockdowns_absorbed_per_15`.
- Pace: `round_profile.rounds[1..5].{sig_att_per_min, sig_landed_per_min, absorbed_per_min}`, `pace_retention_r2_vs_r1, pace_retention_r3_vs_r1, championship_round_delta, defensive_drift_r3_vs_r1`.
- Grappling: `td_attempts_per_15, td_landed_per_15, td_accuracy, control_seconds_per_td, control_share, sub_attempts_per_15, reversals_per_15`.
- Finish: `finish_rate, ko_finish_rate, submission_finish_rate, finish_round_distribution, finished_by_round_distribution, finish_time_median_sec, finished_by {ko_tko, submission}` (losses by finish = durability).
- Stance: `stance_splits` per opponent stance (record, finish/KO/sub rate, sig diff, KD/15, TD/15).
- Context: `three_round, five_round, title, main_event, short_notice` splits.
- Ladder (from bout-feature rows, date-blocked): opponent-absorbed rounds, TD defence, recent form, layoff.

Champion anchor: `predictOne(x, beta, scale)` over `assembleBoutRow(bout, event, fighters, snapsOf, rowsOf)`. The assembly takes a bout-shaped object and an event date, and bout facts (rounds, title, weight class) are not features, so any fighter pair can be scored as of any date. Canonical corner is the smaller UUID; the model is antisymmetric with no intercept.

Learning infrastructure already generic enough to reuse: `ufc_model_versions` (partial unique index: one `live` row per `model_family`), `ufc_model_training_runs`, `ufc_model_shadow_predictions/grades`, `ufc_model_promotion_reviews`, `ufc_model_promote()`, R2 `ufc-algo-artifacts`, `LearnDaily` Workflow, weekly review with named thresholds, owner-token promote.

Fighter-selection readiness on the 71 announced bouts (141 fighters): 124 have a snapshot dated after their last completed bout (0 stale), 17 are debutants with no snapshot. Per bout, the weaker corner's tier is: high 5, medium 20, low 32, insufficient 3, debut 11. So 57 of 71 announced bouts can be simulated at "low or better", 25 at "medium or better".

Empirical per-round dispersion (42,166 fighter-rounds), which fixes the sampling families:

| Stat | mean | variance | var/mean |
|---|---:|---:|---:|
| sig strikes landed | 15.8 | 146 | 9.3 |
| sig strikes attempted | 35.2 | 612 | 17.4 |
| TD attempts | 1.20 | 2.62 | 2.2 |
| TD landed | 0.45 | 0.64 | 1.4 |
| sub attempts | 0.16 | 0.22 | 1.4 |
| knockdowns | 0.09 | 0.10 | 1.1 (7.6% of fighter-rounds have at least one) |
| control sec | 55.8 | 5,438 | zero-heavy |

Strikes are far too overdispersed for Poisson: negative binomial (gamma-Poisson) for attempts, binomial for landed given attempts, Poisson/NB for TDs, Bernoulli-Poisson for KDs, zero-inflated gamma for control.

Round-winner truth: judges' cards are totals only (`ufc_bout_scorecards.score_first/score_second`). 782 of 4,089 three-card decisions are unanimous clean sweeps (30-27 / 50-45 with the same favoured fighter), which is the only subset where every round's winner is known.

Compute proof (Node, scratchpad benchmark): a seeded xoshiro128** engine with NB/Poisson/gamma sampling, 10,000 fights × 5 rounds, ran in 16–24 ms and two runs produced byte-identical aggregates.

## 2. Missing fields (never invent these)

| Need in the brief | Status | Consequence |
|---|---|---|
| Round duration per stat row | not stored; derive: 300 s for full rounds, `time_sec` for the ending round; `ufc_time_format_structure()` exists for odd formats | fine; builder currently assumes 300 s and ignores `time_format` |
| Per-round judge scores | none (totals only; `combat_scorecards` empty) | round winners are a PBE-derived output; graded only on the 782 sweep bouts |
| Position time (distance/clinch/ground seconds) | `ufc_bout_position_stats` = 0 rows | "position share" must be attack-share by position (strike counts), labelled as such |
| Damage / finish weapon / target | `ufc_bout_finish_enrichment` = 0, `ufc_action_events` = 0; only `finish_detail` free text | "accumulated damage" is a proxy: sig strikes absorbed + KDs absorbed; say so on the page |
| Fatigue | no direct measure | pace retention + defensive drift from DNA, applied per round |
| Method / round probabilities in the champion | none anywhere (METHODOLOGY item 6 lists it as future) | the simulator adds HOW; the champion owns WHO |
| Stance as-of history | present-day `ufc_fighters.stance` only | documented approximation, inherited from the model |
| TD defence in DNA | not a snapshot metric; computed in the model from `raw_stats.opp_totals` | compute the same way in the engine |
| Late-round pace at snapshot level | per-bout only | use `round_profile.rounds[3..5]` |
| `archetype`, `position_profile`, composites | always null / `{}` | not used |
| Event start time | none; lock cutoff is `event_date 00:00Z` | simulator lock inherits the same cutoff |
| Data-rights review of the official UFC feed (CloudFront JSON) and ESPN for a paid product | no ToS review exists in the repo | owner item; existing UFC Pro already sells DNA from the same rows |

Two defects found on the way, both pre-existing:
- `scripts/dna/build_fight_dna.mjs:583,601` filters `event_date <= AS_OF` (inclusive). The contract, the API note and the model docs all say exclusive. The daily 07:17Z cron is unaffected in practice, but `DnaTrigger.refreshFightDna` fires when round rows land, so a same-UTC-day rebuild writes a snapshot dated D that contains D's bout. The algo cycle catches this via `target_in_snapshot`; the simulator must carry the same guard.
- The builder never reads `ufc_dna_metric_definitions`; confidence tiers are hard-coded and differ from the contract text.

## 3. How the champion probability anchors the simulation

- `p_anchor = P(canonical corner 1 wins)` from the live `pbe-fight-model` version, computed with the frozen registry coefficients and the same as-of assembly the algo cycle uses. The artifact stores `model_version`, `model_spec_sha256`, `p_anchor` (8 dp) and the feature availability count.
- The engine has one free scalar, the tilt θ, added to corner 1's per-round log-odds (round win, finish hazard ratio). θ is found by deterministic bisection under common random numbers (same seed stream every evaluation) until simulated `P(corner 1 wins)` equals `p_anchor` within 0.25 pt. Result: the 10,000-fight winner split equals the champion by construction. Method, round, distance and stat distributions are then conditional structure on top of it.
- If the champion is `NO_MODEL_CALL` for the pair (eligibility rules: at least 1 prior bout each, at least 20 features), the simulator still runs on the raw probability but the artifact is stamped `LIMITED SIMULATION` with the eligibility reasons; it never invents a different winner.
- For historical replay the anchor is the walk-forward out-of-sample probability from `ufc_model_backtest_predictions` for that bout, never the live coefficients (see section 8).
- Deviations are impossible by design, so no "documented reason" path is needed in v1. A v2 that lets the engine move the winner would be a new model family with its own promotion evidence.

## 4. Deterministic seed and fingerprint

Identity (canonical JSON, sorted keys, fighters in UUID order):

```
{
  simulator_version:   "pbe-fight-simulator-v1.0",
  engine_spec_sha256:  sha256 of canonical {simulator_version, coefficients, dispersion, calibration, rules},
  model_version:       "pbe-fight-model-v1",
  model_spec_sha256:   "75da0a1d…",
  dna_definition_version: 1,
  feature_version:     1,
  fighter_1_id, fighter_1_as_of (resolved snapshot as_of_date),
  fighter_2_id, fighter_2_as_of,
  scheduled_rounds:    3 | 5,
  scenario:            { weight_class, is_title, is_womens },
  n_sims:              10000
}
simulation_id = sha256(identity)            -- the public receipt id
inputs_sha256 = sha256(the two snapshot rows + ladder rows + p_anchor as fetched)
seed          = first 16 bytes of sha256("pbe-sim-seed|" + simulation_id)
```

- PRNG: xoshiro128** (public domain, 32-bit integer ops, identical in Node and workerd) seeded from the digest through splitmix32. Per-fight sub-stream: `seed_i = sha256(seed || i)`, so fight i is identical whether n_sims is 10,000 or 20,000 and shards can run in parallel deterministically.
- Never seeded from time, `Math.random`, request, session, user.
- Cross-runtime caveat, measured by the algo team: a fit in Node vs workerd agrees only to ~2e-15. So: the official artifact is generated once, in one runtime, stored, and served; every reported number is rounded (probabilities 4 dp, seconds and counts integers) before hashing; the byte-identical test runs 100 reruns in the same runtime and one Node-vs-Worker parity test at the rounded precision.
- First artifact wins. A later request with the same identity returns the stored artifact. If `inputs_sha256` differs on a recompute (DB repair, the inclusive-cutoff bug), the engine writes a new revision under the same identity with `revision+1` and `supersedes`, never an overwrite.

## 5. State-transition model (round N feeds round N+1)

Per-fighter state carried across rounds: sig absorbed cumulative (damage proxy), KDs taken, TDs landed/absorbed cumulative, control accrued/suffered, sub attempts faced, fatigue multiplier, defensive drift, round-win tally, current phase (distance-led vs grappling-led).

Per round r, per fighter, in order:
1. Pace: `mu_att = round_profile.rounds[r].sig_att_per_min` (fallback overall), × pace retention chain (r>1), × fatigue(state), × opponent pressure term. Attempts ~ NB(mu_att × round_sec/60, k_r) with k_r fitted per round from history.
2. Accuracy: p = blend(own `sig_accuracy`, 1 − opp `sig_defense`) shifted by opp defensive drift in r ≥ 3. Landed ~ Binomial(attempts, p).
3. Targets: multinomial over head/body/leg from attack shares; position of attack over distance/clinch/ground, shifted toward ground when a TD landed this round.
4. Takedowns: attempts ~ NB(`td_attempts_per_15` × min/15 × pressure); landed ~ Binomial(att, blend(`td_accuracy`, 1 − opp TD defence from ladder)); control ~ zero-inflated gamma keyed on `control_seconds_per_td`; sub attempts ~ Poisson(`sub_attempts_per_15` × control share).
5. Knockdowns: Poisson(blend(`knockdowns_per_15`, opp `knockdowns_absorbed_per_15`) × damage multiplier).
6. Finish hazard (evaluated within the round, with time sampled from the finish-time profile): KO hazard = f(KD this round, cumulative absorbed, opp `finished_by.ko_tko`/appearances, own `ko_finish_rate`); SUB hazard = f(sub attempts, control, opp `finished_by.submission`, own `submission_finish_rate`). Tilt θ from section 3 enters here and in step 7.
7. Round score: PBE 10-9 / 10-8 from landed-by-target weights, KDs, TDs, control. A published rule, not a judge model.
8. Carry-over: fatigue ×= pace retention; damage accumulates; a KD raises next-round hazard; nothing resets.
9. Decision: if no finish, winner = rounds tally; draws allowed only when the rule produces a tie (kept as `DRAW` share in the distribution).

Coefficients and dispersion parameters are learned in Phase 3 by walk-forward fits; the recipe above is the v1 major version, the fitted numbers are the minor.

## 6. Canonical representative path

1. Winner = the distribution leader (equals the champion pick by section 3).
2. Method = argmax of P(method | winner) from the 10,000.
3. Ending round / window = the modal cell of (winner, method, round, time-tercile) for finishes; "decision" otherwise.
4. Trajectory = the **medoid** of that modal cell: the actual simulated fight minimising standardised L1 distance to the cell's per-round medians. A real sampled path is always internally coherent (a KO in R2 comes with R2 stats that produced it); pure per-stat medians are not. Fallback when the cell has fewer than 300 fights: medoid of (winner, method).
5. Round winners, stats and the "ROUND READ" facts come from the medoid's state; narrative sentences are templates that verbalise those facts only. No LLM produces or edits numbers.
6. Deterministic: same distribution → same cell → same medoid (ties broken by fight index).

## 7. Backtest / calibration plan (Phase 3)

- Universe: completed `model_scope` bouts 2015–2026 with complete round stats for both corners, excluding draws/NC/DQ from winner/method scoring: about 5,885 bouts. Contender Series stays as history only, matching eligibility.
- Strictly as-of: snapshots with `as_of_date <= event_date`, ladder rows `event_date < D`, date-blocked; anchor = `ufc_model_backtest_predictions.prob_1` (walk-forward), never live coefficients.
- Walk-forward: refit engine coefficients per calendar year on prior years only (same folds as the champion, 2013–2026 where stats exist).
- Metrics (simulator-specific, stored in `release_metrics`):
  - winner Brier / log loss (must equal the anchor's; a difference is a bug),
  - method log loss vs two baselines: weight-class base rate, and per-fighter finish-rate naive,
  - goes-distance Brier; finish-round MAE and CRPS,
  - per-round sig strikes landed MAE and calibration (median vs observed), TD MAE, control-sec MAE, KD rate calibration, vs a naive "fighter's DNA average per round" baseline,
  - round-winner accuracy on the 782 sweep bouts,
  - all sliced by coverage tier and by 3/5 rounds.
- Determinism gates: 100 reruns byte-identical; corner-swap produces the mirrored artifact (antisymmetry); truncation test on 250 sampled bouts as in `LEAKAGE.md`.
- Register the run in `ufc_model_backtest_runs` under the new family.

## 8. Leakage risks

1. Anchor leakage: live v1 coefficients were fitted through 2026-09-05; using them on 2019 bouts leaks. Use fold predictions.
2. Inclusive same-day DNA cutoff (section 2). Guard: reject any snapshot whose `provenance.bouts` contains a bout dated on or after as_of.
3. Engine coefficients fitted on the full history then replayed on it: walk-forward only.
4. Dispersion parameters (k, gamma shapes): also fitted per fold.
5. Target bout's own round stats: read only as labels after the artifact exists.
6. Orientation artifact (fighter_a wins 93.5% in this DB): canonical UUID corner + swap test.
7. DB repairs move history (`DATA_REPAIR_DRIFT` exists for a reason): `inputs_sha256` in every artifact; a repaired input yields a new revision.
8. Market data: never read by the engine.
9. Same-card leakage: date-blocked ladder.
10. Present-day stance, DOB, reach: inherited, documented.

## 9. Database / schema additions (UFC project only, service-role, one writer)

Reuse: `ufc_model_versions` with `model_family = 'pbe-fight-simulator'` (immutability trigger and one-live-per-family index already apply; `coefficients` holds the engine coefficients, `hyperparameters` the dispersion/calibration, `spec_sha256` the engine spec). The promote path's version regex in `review.js` is family-specific and needs generalising before a second family can be promoted.

New, additive, with rollbacks and `migrations/tests` proofs:
- `ufc_sim_runs` (append-only, immutable): `simulation_id text pk` (sha256), `revision int`, `supersedes text`, `simulator_version fk`, `engine_spec_sha256`, `model_version fk`, `model_spec_sha256`, `dna_definition_version`, `feature_version`, `fighter_1_id`, `fighter_2_id`, `fighter_1_as_of`, `fighter_2_as_of`, `scheduled_rounds`, `scenario jsonb`, `n_sims`, `seed_sha256`, `inputs_sha256`, `code_sha`, `worker_version`, `anchor_prob_1`, `probabilities jsonb`, `methods jsonb`, `finish_distribution jsonb`, `distribution_stats jsonb`, `canonical_projection jsonb`, `evidence jsonb`, `confidence`, `coverage jsonb`, `artifact_uri` (R2 full aggregate), `generated_at`. Unique on `(simulation_id, revision)`; lookup index on the identity columns.
- `ufc_sim_bout_projections`: `(bout_id, simulation_id, locked_at)` with the same DB-clock lock gate as predictions (`event_date 00:00Z` cutoff, publishing GUC).
- `ufc_sim_grades` (append-only, revisioned like prediction grades): winner, method, ending round error, per-round sig MAE, TD MAE, control MAE, round-winner hits where truth exists, log-loss components.
- `ufc_sim_training_runs`, `ufc_sim_shadow_projections`, `ufc_sim_shadow_grades`: mirror the algo tables; `ufc_model_training_runs` has model-specific check constraints (feature/eligibility versions) so a sibling is cleaner than widening it.
- `ufc_sim_requests`: `(account_id, simulation_id, requested_at)` for metering; no entitlement data here.
- Add each table to `docs/ufc_autopilot_ownership.md` with `ufc-simulator` as the single writer.

## 10. Worker / API architecture

- Engine: pure ES module (a `simulator/` package shared like `features_core.mjs`): no I/O, inputs in, artifact out; unit-tested in Node and imported by the Worker.
- New Worker `ufc-simulator` (own `[limits] cpu_ms`, R2 binding `ufc-algo-artifacts` under `simulator/`, no KV): keeps the frozen `ufc-algo` untouched and isolates CPU budget and deploy cadence. Routes: `POST /v1/simulate` (idempotent by identity; returns the stored artifact when it exists), `GET /v1/simulations/{id}`, `GET /v1/simulations/lookup`, admin `POST /admin/backtest`, `POST /admin/learn`, `POST /admin/review`; cron for locking scheduled-bout projections and grading after results; `OWNER_PROMOTE_TOKEN` pattern reused. Auth: internal key from the web server only; the Worker never sees end users.
- Web: `/simulator` server component + client playback, `.sim-*` CSS prefix (route-CSS guard), preservation baseline updated additively, server-only `lib/simulator.ts`. Entitlement is checked in the web layer (section 12) before calling the Worker.
- Caching: artifacts are immutable, so `GET /v1/simulations/{id}` is cacheable indefinitely; lookup is `no-store`.
- Commercial API exposure later via `ufc-api` premium paths, unchanged now.

## 11. Expected compute cost per 10,000 sims

- Measured: toy engine 16–24 ms per 10,000 × 5 rounds in Node.
- Production engine (about 6 sampling sites per fighter-round, scoring, medoid reservoir): estimate 100–300 ms CPU. Anchor bisection (about 12 evaluations at 2,000 fights, then the final 10,000): 0.5–1.5 s CPU worst case. Set `cpu_ms = 60000` for headroom; the default 30 s is already ample.
- Memory: compact per-fight trajectory for medoid selection ≈ 5 rounds × 2 fighters × 12 ints ≈ 480 B × 10,000 ≈ 5 MB; well under the 128 MB isolate.
- Cost: Workers CPU billing at about $0.02 per million CPU-ms → about $0.00003 per simulation; artifact ≈ 50–100 KB in R2. Backtest of 5,885 bouts ≈ 1–2 CPU-hours: run locally in Node or in sharded Workflow steps.

## 12. Entitlement boundary

Findings: the billing Worker derives `PRODUCT_KEYS` from Stripe price ids (unknown key → 400), `pbe_has_sport_entitlement` grants any key to an active `pbe_all_access`, owners get any key, and the `sport` check constraint has no labs value. The membership contract (`pbe-membership.js` 1.1.0) has closed enums (`free | sport_pro | all_access | owner`). Public copy promises "every current and future PropBetEdge Pro **sport**", not "product", so a non-sport Labs add-on is not promised to All Access by the wording.

Design (no Stripe objects):
- New ledger on the UFC project: `pbe_labs_entitlements(email or account_id, product_key = 'fight_simulator', status, starts_at, expires_at, source in ('manual','stripe','bundle'), granted_by, notes)` + predicate function; service-role only.
- Web: `lib/labsAccess.ts` → `getLabsAccess()` parallel to `getUfcAccess()`, reusing the `pbe_ufc_session` account lookup; a `LABS_PRODUCT_KEYS` constant; a separate guard registry in the paywall test so Labs reads can never pass on `access.pro`.
- One explicit policy switch, default off: `LABS_INCLUDED_IN_ALL_ACCESS`. Whether All Access bundles Labs is an owner decision; the code must make it a one-line change, never implicit.
- Login: the paid-only magic-link gate and the session-revoke rule both key on `ufc_pro`; a Labs-only customer would get no session. Both need a Labs branch before Phase 6.
- Owner: same canonical owner check (`UFC_OWNER_EMAIL` + owner row).

## Build order confirmation

Phase 2 (engine, pure functions, seeded RNG, fingerprint, 10k distribution, medoid selector, no frontend) can start now with no production change. Phase 3 needs read-only DB access already in hand. Phases 4–6 wait on: the DNA cutoff fix (owner approval to touch the frozen intelligence Worker), the entitlement seam, and the data-rights decision.
