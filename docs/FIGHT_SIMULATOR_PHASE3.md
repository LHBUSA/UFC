# PBE Fight Simulator — Phase 3 report (backtest, calibration, parameter fitting, leakage audit)

Date: 2026-09-24. Branch: `fight-simulator-phase3` from 211fca8 (not merged; nothing deployed; no production writes). Package: `workers/ufc-simulator` (`phase3/` scripts). Evidence: `docs/evidence/fight_simulator_phase3/` (walk-forward report JSON, calibrated and uncalibrated; slice tables; leakage audit; per-fold parameters; frozen v1 provenance; cohort summary).

Data read: the production UFC Supabase project (read-only extract into a gitignored local cache) and the champion's walk-forward predictions regenerated locally with the model's own read-only scripts (`scripts/model/extract_dataset → build_features → backtest`, 7,078 out-of-sample fold predictions, ECE 0.0129). No production row was written, no model promoted, no Worker deployed.

## 1. Cohort and reconciliation

| Disposition | Bouts |
|---|---:|
| Candidates: completed, `model_scope`, event date ≥ 2015-01-01 | 6,326 |
| Excluded: a corner with no Fight DNA snapshot before the bout (debut) | 873 |
| Excluded: round stats incomplete for some round or corner | 376 |
| Excluded: result NC / DRAW / DQ (no winner or method label) | 66 / 48 / 14 |
| Excluded: non-standard time format | 35 |
| Excluded: snapshot provenance lists a bout that no longer exists in `ufc_bouts` (cannot be proven as-of) | 10 |
| Excluded: no stored result / scheduled rounds not 3 or 5 | 4 / 1 |
| **Cohort** | **4,899** |
| Cohort 2015: no earlier training fold exists, used for training only | 380 |
| **Walk-forward target 2016–2026** | **4,519** |
| Rows produced | 4,519 |
| Simulated FULL (both corners medium+ coverage) | 1,570 |
| Simulated LIMITED (a low corner) | 2,579 |
| INSUFFICIENT_DATA (an insufficient corner; no distribution, no projection) | 370 |
| REJECTED_SNAPSHOT | 0 (the extract already replaced the 8 contaminated 2026-09-19 snapshots with the prior valid one; the engine guard stays active) |
| Missing anchor | 0 (every cohort bout has a fold prediction) |

Every candidate bout reconciles to exactly one disposition (`reconciles: true` in the report JSON). Series: 4,896 UFC, 2 Contender Series, 1 Road to UFC (pre-migration `model_scope=true`). Formats: 4,357 three-round, 552 five-round. Methods: 2,457 DEC, 1,588 KO/TKO, 864 SUB.

## 2. Leakage audit (all 4,899 bouts, hard assertions, `phase3/leakage_audit.mjs`)

| Check | Result |
|---|---|
| Snapshot `as_of_date <= D`, every provenance bout dated `< as_of` and `< D` | pass |
| Target bout id anywhere in the inputs (JSON scan) | 0 |
| Ladder rows dated `>= D` | 0 |
| Anchor = champion fold prediction with `fold_year == year(D)`, canonical corner order | pass |
| Truncation: rebuild inputs after deleting every row dated `>= D` (169 sampled bouts) | 0 diffs |
| Closest included prior bout before an event | 7 days |
| Contaminated-snapshot fallbacks applied | 8 corners |
| `params_fold_all` refused for any historical bout (`phase3/guard.mjs`, tested) | pass |

Walk-forward fold Y trains on cohort years < Y only; the champion anchor for year Y is the model's own fold-Y out-of-sample probability, never the live coefficients.

## 3. What was fitted (`phase3/fit.mjs`, deterministic)

Ten component models with one shared feature definition (`src/engine/models.mjs`) used by both the fitter on observed rounds and the simulator on generated rounds: strike attempts (negative binomial), landed given attempts (binomial), takedown attempts (NB), takedown success (binomial), any control (binomial), control length (gamma), knockdowns (Poisson), submission attempts (Poisson), KO/TKO hazard and submission hazard (complementary log-log with exposure offsets). Objective: penalised maximum likelihood (Newton with a deterministic backtracking line search, ridge 1e-2 on non-intercept terms), NB dispersion and gamma shape by moments, finish-time shape by closed-form MLE. Fitter verified on synthetic data with known coefficients (`phase3/glm.test.mjs`).

In-fold hazard intercept recalibration: the hazard fits condition on partial ending-round counts while the simulator evaluates hazards on full generated rounds, which inflated finish rates (36% KO simulated vs 32% observed on training bouts). The KO and SUB intercepts are shifted by log(observed/simulated) over four deterministic iterations on each fold's own training bouts (never the evaluation year). Training bouts per fold: 380 (2016) → 4,568 (2026); the all-data fit uses 4,899.

## 4. Winner (anchored)

| Probability source | n | Brier | Log loss | ECE | Accuracy |
|---|---:|---:|---:|---:|---:|
| Champion fold prediction (anchor) | 4,149 | 0.2328 | 0.6581 | 0.0238 | 0.614 |
| Engine pre-anchor (tilt 0, Fight DNA only) | 4,149 | 0.2409 | 0.6745 | 0.0220 | 0.564 |
| Simulator post-anchor | 4,149 | 0.2327 | 0.6579 | 0.0233 | 0.614 |
| Coin | | 0.2500 | 0.6931 | | |

The anchored winner reproduces the champion by construction (mean |post − champion| 0.0012). The engine on its own beats the coin (Brier 0.2409) but is weaker than the champion; the tilt closes exactly that gap. Reliability is monotone from 0.26 (n 147) to 0.84 (n 21).

Tilt |θ| (max_tilt 1.0):

| Slice | n | median | p75 | p90 | p95 | max | at/over max |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 4,149 | 0.234 | 0.422 | 0.609 | 0.738 | 2.25 | 1.0% |
| FULL | 1,570 | 0.234 | 0.410 | 0.569 | 0.680 | 1.45 | 0.5% |
| LIMITED | 2,579 | 0.252 | 0.429 | 0.633 | 0.773 | 2.25 | 1.4% |
| min coverage high | 438 | 0.223 | 0.398 | 0.539 | 0.633 | 1.04 | 0.2% |
| min stat bouts 1–2 | 1,421 | 0.258 | 0.469 | 0.668 | 0.820 | 2.25 | 1.9% |
| min stat bouts 10+ | 598 | 0.234 | 0.398 | 0.547 | 0.633 | 1.13 | 0.3% |

Tilt falls with evidence (the state engine agrees more with the champion when Fight DNA is rich), no weight class exceeds 2.2% at max, and no year exceeds 1.9%. Phase 2 priors needed a median 0.375 and p90 0.96 on the same bouts; fitting halved that. The state engine is not structurally at odds with the champion.

## 5. Method, distance

| Metric | Simulator | Global frequency | Weight-class frequency |
|---|---:|---:|---:|
| Multiclass log loss | **0.9729** | 1.0153 | 1.0034 |
| Top-1 accuracy | 0.528 | | 0.511 |

| Class | n true | sim mean p | observed | sim Brier | WC-baseline Brier | ECE | precision / recall (top-1) |
|---|---:|---:|---:|---:|---:|---:|---|
| KO/TKO | 1,327 | 0.346 | 0.320 | 0.2068 | 0.2119 | 0.026 | 0.47 / 0.35 |
| SUB | 726 | 0.172 | 0.175 | 0.1389 | 0.1450 | 0.008 | 0.44 / 0.06 |
| DEC | 2,096 | 0.482 | 0.505 | 0.2394 | 0.2459 | 0.023 | 0.55 / 0.80 |
| Goes distance | | 0.482 | 0.505 | **0.2394** | 0.2459 | 0.023 (baseline 0.022) | |

KO-heavy behaviour: Phase 2 priors over-predicted KO badly (method log loss 1.0705); the uncalibrated fit still over-predicted KO by 5.5 points (mean p 0.375 vs 0.320, ECE 0.056); the recalibrated fit is +2.6 points (0.346 vs 0.320, ECE 0.026), with SUB now on rate and DEC 2.3 points under. Per-class reliability for KO is within 3 points up to p 0.5 and over-confident above it (0.54 → 0.47 observed, n 346; 0.65 → 0.53, n 116). SUB is almost never the top-1 class (recall 6%) because it rarely exceeds 40%; that is a property of the sport, not a defect, but a UI must not present the top-1 method as a "prediction" of SUB fights. By gate: FULL log loss 0.936 vs baseline 0.977; LIMITED 0.995 vs 1.020, similar relative gains.

## 6. Finish round and timing (2,053 finishes)

| Slice | CRPS sim | CRPS historical | method | CRPS historical any | E[round] MAE sim | E[round] MAE hist | exact method+round hit |
|---|---:|---:|---:|---:|---:|---:|
| all | 0.4437 | **0.4367** | 0.4344 | 0.730 | **0.722** | 16.6% |
| KO set | 0.4495 | 0.4391 | | 0.744 | 0.727 | 22.8% |
| SUB set | 0.4333 | 0.4323 | | 0.703 | 0.712 | 5.4% |
| 3-round | 0.4025 | 0.3921 | | | | |
| 5-round | 0.6955 | 0.7091 | | | | |

The simulator's finish-round distribution does NOT beat the historical conditional distribution (given format and method) on three-round fights and is only level on five-rounders. Elapsed-time MAE of the median finish time is 226 s: no second-level precision exists. Consequence for the product: finish round is shown as a distribution with the round of the representative path labelled as such, and no time window is shown in v1 (the Phase 2 FULL-tier time bucket is withdrawn).

## 7. Round statistics (full rounds only; 12,334 fighter-rounds; simulator point = per-round median)

| Stat | truth mean | sim MAE | sim RMSE | sim bias | naive DNA MAE | naive RMSE | opp-adjusted MAE | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| sig strikes landed | 18.35 | 8.53 | 11.32 | −1.20 | 8.78 | 11.44 | **8.39** | beats naive, not the opponent-adjusted average |
| sig strikes attempted | 40.54 | **17.57** | **22.70** | −2.69 | 18.22 | 23.40 | 18.22 | beats both |
| takedown attempts | 1.17 | **0.95** | 1.48 | −0.30 | 1.07 | 1.43 | 1.07 | MAE better, RMSE level |
| takedowns landed | 0.43 | 0.41 | 0.85 | −0.34 | 0.56 | **0.76** | 0.56 | MAE win is the zero median; RMSE worse |
| control seconds | 52.65 | 47.0 | 73.6 | −27.4 | 54.9 | **69.0** | 54.9 | zero-heavy median; RMSE worse |
| knockdowns | 0.05 | 0.05 | 0.24 | −0.05 | 0.15 | 0.26 | 0.15 | median is zero; not a point estimate |
| submission attempts | 0.09 | 0.09 | 0.36 | −0.09 | 0.23 | 0.37 | 0.23 | median is zero; not a point estimate |
| pace retention R3/R1 (attempts) | 1.385 | MAE 0.601 | | sim mean 1.205 | | | | under-predicts late-round volume |

Head/body/leg and distance/clinch/ground shares are the fighter's as-of DNA shares by construction (no learned component), so they are exactly the baseline and add nothing yet. By gate, strike and takedown errors are essentially the same for FULL and LIMITED.

## 8. Round winners (auxiliary; 347 clean-sweep decisions, 1,079 rounds)

Simulator round-win share picks the sweep winner in 68.1% of rounds; the trivial baseline "champion favourite wins every round" scores 71.5%. The PBE round rule is not yet better than the fight-level favourite. No judge-round labels were manufactured.

## 9. Slices

- By year: the simulator's method log loss is at or below the weight-class baseline in every year (closest: 2024, 0.955 vs 0.961); distance Brier is below baseline every year but 2016 (0.2443 vs 0.2455). Winner Brier follows the champion (2016 0.244 is the champion's weakest fold, trained on 1994–2015 with thin round data). Tilt medians run 0.19–0.28 with no era trend.
- By weight class: every class beats the method baseline except STRAWWEIGHT (0.913 vs 0.904 baseline; distance 0.237 vs 0.232) and CATCHWEIGHT (n 47). Heavyweight has the best distance skill (0.220 vs 0.236).
- By format: five-round bouts match the champion on winner, beat the method baseline (0.977 vs 1.026) and the finish-round baseline (CRPS 0.696 vs 0.709); three-round bouts do not beat the finish-round baseline (0.403 vs 0.392).
- By coverage: method and distance skill are similar for FULL and LIMITED; the high-coverage slice (n 438) has the best finish-round result (CRPS 0.520 vs 0.559). LIMITED is not measurably worse than FULL on the outputs that are ready, so the gate thresholds are kept as they are; INSUFFICIENT (8% of the target) stays refused. There is no evidence to loosen the gate.

## 10. Parameter stability (folds 2016–2026; tables in the evidence file)

Stable (range over the 2021–2026 folds under 0.15 on every coefficient): strike attempts, accuracy, takedown attempts, control length, knockdowns, submission attempts, KO hazard, SUB hazard, finish-time shapes (0.65 / 0.96–1.13). Flagged:
- `ctrl_any`: `td_l` and `td_landed_any` are collinear (fold sd 1.0 and 1.1, min/max −0.06/3.62 and 0.49/4.62); the sum is stable, the split is not. Keep, merge in v1.1.
- `td_acc.logit_tdacc`: sign flip in the 2016 fold (−0.20) then 0.13–0.19; the opponent's takedown defence carries the signal (0.55–0.59).
- `ko_haz.opp_absorbed_cum` (damage proxy): drifts from 2.0 (2016) to 0.76 (all data) as folds grow; the late-fold range is 0.22. Watch.
- `att.r4plus`: −0.14 to −0.37 across folds (few five-round rounds early).

## 11. Determinism after fitting (frozen `pbe-fight-simulator-v1.0-rc1` parameters)

See the gate log recorded in section 15 below (100 same-process runs, fresh processes, corner swap, Node vs workerd parity, benchmark). Nothing in the engine reads a clock, `Math.random` or request data; the identity, seed and medoid rules are unchanged from Phase 2.

## 12. Parameters changed from the Phase 2 priors

All ten component models were replaced by fitted GLM coefficients (`src/engine/params_fitted_v1.mjs`, provenance embedded: fit version `pbe-sim-fit-v1`, source fold `all`, training window 2015-01-03 → 2026-09-19, 4,899 bouts, 24,146 fighter-round observations, dataset SHA-256, code base SHA, objective, hazard-calibration trace, generated timestamp). Finish-time shapes were fitted (0.651 / 0.957 vs prior 0.9 / 1.4). Kept as structural priors, unfitted: tilt weights (hazard 1.0, round 1.5, efficiency 0.15, takedown 0.15), the PBE round-score rule, ground-share boost per control minute, control cap 85% of the round, knockdown cap 3, snapshot shrinkage weights (6 rounds / 4 bouts) and the gate thresholds. Target and position shares remain the DNA shares.

Same bouts, three parameter sets:

| Metric | Phase 2 priors | Fitted, uncalibrated | Fitted, calibrated (frozen) | Simple baseline |
|---|---:|---:|---:|---:|
| Method log loss | 1.0705 | 0.9779 | **0.9729** | 1.0034 (weight class) |
| KO mean p vs observed 0.320 | — | 0.375 | 0.346 | — |
| Distance Brier | 0.2637 | 0.2399 | **0.2394** | 0.2459 |
| Finish-round CRPS | 0.4354 | 0.4417 | 0.4437 | **0.4367** (historical | method) |
| Sig strikes landed MAE | 8.79 | 8.53 | 8.53 | 8.78 naive / **8.39** opp-adjusted |
| Tilt median / p90 | 0.375 / 0.961 | 0.234 / 0.609 | 0.234 / 0.609 | — |
| Winner Brier | 0.2327 | 0.2327 | 0.2327 | 0.2328 (champion) |

## 13. WHAT FAILED / WHAT IS NOT READY

| Subsystem | Classification | Evidence |
|---|---|---|
| Winner | READY FOR V1 | equals the champion (Brier 0.2327 vs 0.2328), ECE 0.023, tilt median 0.23, 1% at max |
| Method (KO/SUB/DEC distribution) | LIMITED / NEEDS LABEL | beats both frequency baselines (0.973 vs 1.003); KO still +2.6 pts over-predicted and over-confident above 50%; SUB never top-1. Show as a distribution with "model view", never as a single called method |
| Goes distance | LIMITED / NEEDS LABEL | Brier 0.2394 vs 0.2459, ECE 0.023; 2.3 pts under the observed distance rate |
| Finish round | NOT READY | CRPS 0.444 vs 0.437 for the historical conditional distribution; E[round] MAE 0.73 vs 0.72; no time precision (median-time MAE 226 s) |
| Finish time window | NOT READY | withdrawn from all tiers |
| Strike volume (attempts, landed) | LIMITED / NEEDS LABEL | attempts beat both baselines; landed beats naive but not the opponent-adjusted average; medians run 1–3 strikes low. Show as a range, not a number |
| Takedown attempts | LIMITED / NEEDS LABEL | MAE better than naive, RMSE level |
| Takedowns landed | NOT READY as a point estimate | MAE win comes from a zero median; RMSE 0.85 vs 0.76 naive |
| Control time | NOT READY as a point estimate | RMSE 73.6 vs 69.0; median 27 s low |
| Knockdowns, submission attempts | NOT READY as point estimates | zero medians; only the rates are meaningful |
| Pace retention | NOT READY | simulated R3/R1 1.21 vs observed 1.39 |
| Round winner (PBE round rule) | NOT READY | 68.1% on sweeps vs 71.5% for "favourite wins every round" |
| Canonical narrative (medoid path) | LIMITED / NEEDS LABEL | coherent by construction and deterministic, but its exact method+round matches 16.6% of finishes; must be labelled "PBE's representative path", never a prediction of the round-by-round stats; round scores inside it inherit the round-winner verdict above |
| Head/body/leg and position shares | NOT MODELLED | identical to the DNA average by construction |
| Coverage gate | READY (kept) | LIMITED not measurably worse than FULL on ready outputs; INSUFFICIENT refused |

## 14. Proposed frozen v1 parameter set

`src/engine/params_fitted_v1.mjs`, engine version `pbe-fight-simulator-v1.0-rc1` (release candidate; not registered in `ufc_model_versions`, not promoted). It is the all-data fit (`params_fold_all`) with the in-fold hazard calibration; it never scored a historical bout (guard-tested). Its provenance block records fit version, source fold, training window and counts, dataset hash, code base SHA (211fca8), objective, calibration trace and generation time.

## 15. Determinism gate log (frozen parameters)

Gate log (`workers/ufc-simulator/.cache/phase3/gates_frozen.log`, reproduced with `npm test`, `npm run parity:worker`, `npm run bench`):

| Gate | Result |
|---|---|
| Test suites (engine + primitives + determinism + GLM + guard) | 28 tests, 28 pass, 0 fail |
| 100 same-process runs, n_sims 10,000 (Volkanovski vs Evloev) | byte-identical artifacts |
| Fresh processes (3 child processes, Pitbull vs Choi) | identical `artifact_sha256` |
| Corner swap: simulate(A,B) vs simulate(B,A) | identical `simulation_id` and bytes |
| Node 24 vs workerd (wrangler dev, local) on all four fixtures | PASS: same `simulation_id`, same `artifact_sha256`, same distribution, same medoid |
| Raw engine throughput | 16 µs per fight (3 rounds), 21 µs (5 rounds); the fitted feature vectors cost ~30% more than the priors |
| Full anchored `simulate()` | 0.7–1.0 s in Node, 0.8–1.3 s in workerd |

Fixture projections under the frozen set: Volkanovski vs Evloev (FULL): pre-anchor 0.520 vs champion 0.521, tilt 0, projection Evloev by decision (58% distance). Steveson vs Sharaf (LIMITED, one stat bout): tilt −1.22 flagged `excessive_tilt`, exactly the case the diagnostic exists for. Aswell vs Yoo and Pitbull vs Choi (LIMITED): tilts −0.29 and +0.45, `ok`.

Determinism lines from the run: ✔ 100 same-process runs are byte-identical (n_sims 10,000, runs=100) (77739.6504ms) · ✔ all fixtures: two runs each are byte-identical and the envelope clock is outside the hash (6907.9566ms) · ✔ fresh processes agree: three child processes produce the same artifact hash as this process (3853.3006ms) · ✔ swap symmetry: simulate(A,B) and simulate(B,A) return the same artifact bytes and id (1089.4071ms)

## 16. Recommendation on Phase 4

Proceed with Phase 4 for the READY and LIMITED outputs only: storage, receipt, lock and grading tables, and an API contract that exposes the winner distribution, the method and distance distributions with the labels above, the representative path labelled as such, and the coverage gate. Do not build the finish-time window, round-winner claims or point estimates for control, knockdowns, submissions or takedowns landed into the contract; keep them internal until a Phase 3b iteration beats the baselines. Phase 3b work items, in order of expected value: (1) a finish-round model that conditions on the historical conditional distribution rather than replacing it; (2) a distribution-level score (CRPS) for the per-round stats instead of median MAE, and mean/quantile outputs in the artifact; (3) a fitted round-score rule evaluated on the sweep set; (4) the late-round pace term; (5) merge the collinear control terms.
