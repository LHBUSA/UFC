# PBE Fight Simulator — Phase 3B production hardening (2026-09-24)

Scope: Fight DNA build reliability, anchor-strain audit on the live slate, draw calibration, two P2 fixes; and, mid-pass, card truth
(Gall vs Dumas) and the simulator confidence contract. No change to Stripe, Labs access, UFC Pro, All Access, nav, prices or the
model card figures.

## 1. Fight DNA build, 2026-09-24 (P0)

| | |
|---|---|
| Failing run | `d62ef89c` (as_of 2026-09-24), 07:17:40Z to 07:19:10Z, status `failed` |
| Cause | Postgres `57014` statement timeout on one 100-row upsert into `ufc_fighter_dna_snapshots`. `writeBatch` threw on the first non-2xx with no retry. |
| Written before the stop | 18,764 bout-feature rows; 700 of 3,180 snapshots (7 batches); 0 stance rows |
| Why it stayed stopped | The fingerprint gate only marks a day done on success, but nothing re-ran it: the next build was the next day's 07:17 cron (the round-row trigger only fires on new rounds). |
| Last-known-good | 2026-09-23 rows untouched (the key includes `as_of_date`); the simulator's `pickValidSnapshot` served them until the 09-24 build completed. |
| Completion | run `b23d3034` (resume), 23:11:21Z to 23:12:20Z: 700 preserved, 2,480 written, 5,523 stance rows, 18,764 features, 0 retries / splits / failures |
| Reconciliation | expected 3,180 snapshots = present 3,180; stance fighters 3,178 = 3,178; `complete: true` |

Fixes:
- Builder v1.3 (`scripts/dna/build_fight_dna.mjs`): transient write failures (57014, 5xx, 429, network) retry with backoff 1 s / 3 s / 8 s and then split the
  batch in half; `--resume` keeps rows already written for the as-of date; every full run reconciles present vs expected rows and is recorded
  `partial`, never `success`, when they differ. Tests: 13/13 (`node --test scripts/dna/build_fight_dna.test.mjs`).
- ufc-intelligence v0.2.0 (deploy `8b98c214`, rollback `d1072095`): hourly guard `47 * * * *` (`src/dnaGuard.js`, 8 tests) resumes today's build
  when no success is recorded after 08:00Z, at most 3 attempts, then reports `dna_guard_exhausted`. `/health` → `fight_dna.freshness`.

## 2. Anchor strain on the live slate (P1)

31 simulatable upcoming bouts (effective card, next 6 events), 22 with a PBE Fight Model anchor, 9 insufficient.

| | Live slate | Phase 3 (all) | Phase 3 (2026 fold) |
|---|---:|---:|---:|
| median abs tilt | 0.246 | 0.234 | 0.281 |
| p75 | 0.445 | 0.422 | 0.469 |
| p90 | 1.055 | 0.609 | 0.668 |
| p95 | 1.102 | 0.738 | 0.797 |
| over max_tilt | 3 / 22 (13.6%) | 1.0% | 1.7% |

Gate counts (result level): FULL 10, LIMITED 12, INSUFFICIENT 9. Coverage alone would give FULL 11 / LIMITED 11 / INSUFFICIENT 9: one bout
changes tier because of strain, Rosas Jr. vs Barcelos (medium/high coverage; engine 0.373 vs model 0.763, tilt 1.10) → LIMITED. The other two
strained bouts (Demopoulos vs Jauregui, McGee vs Nolan) pair a high-coverage with a low-coverage corner and were already LIMITED.

Investigation: the live production pipeline was replayed on the 98 completed 2026-07-01+ bouts that Phase 3 also scored. Same median (0.281),
p90 0.715 vs 0.668, 2 over max in both, and |live champion − fold champion| median 0.006 (max 0.030). There is no pipeline drift; the slate's
three are a heavy draw from the same distribution (about a 1% event at the 2026 rate). The threshold was not changed.

## 3. Draw calibration (P1)

Trace: `fight.mjs` scores each round once with the published PBE rule (10-9 to the higher weighted total, 10-8 at a margin of 40 or a knockdown
with 14, 10-10 only on an exact tie) and decides a bout on that ONE card. In a 10,000-fight run every simulated draw contained a 10-8 round; no
draw came from a 10-10. With an odd number of rounds, an even card needs a 10-8 won by the fighter who loses the other rounds.

Historical (2015+, decisions incl. draws): three-round 1.56% draws (0.77% of all bouts), five-round 1.70%. Judge cards: 10-8 in at most 4.96% /
7.49% of judge-rounds (upper bound, deductions included), even cards 1.47% / 1.70%. The simulator predicted 2.49% / 2.66% of ALL fights
(4.95% / 8.12% of its decisions).

Card shapes locate the source (three-round, 2016-2020, single card):

| card | real | engine | engine + persistence ρ 0.7 |
|---|---:|---:|---:|
| 29-28 | 49.4% | 64.1% | 49.6% |
| 30-27 | 34.8% | 19.2% | 36.0% |
| 30-26 | 7.2% | 3.0% | 6.9% |
| 29-27 | 4.1% | 7.9% | 4.7% |
| 28-28 | 1.5% | 4.5% | 1.6% |

Round winners barely persist inside a simulated fight: the fitted attempt models are negative binomial per round, so all of their extra-Poisson
variance is redrawn every round. Two alternatives were measured and rejected: raising the 10-8 thresholds (matching real draws needs a 10-8 rate
far below the real one) and three noisy judges (cards from one fight are correlated; draws track the even-card rate).

Fix candidate (structural, no fitted coefficient changes): a share ρ of the same fitted dispersion moves to a per-fighter, per-fight gamma
frailty drawn once; the round-level dispersion is re-solved, k' = (k + ρ)/(1 − ρ), so every round's marginal mean and variance equal the fitted
ones exactly. ρ = 0.7 was fitted on 2016-2020 card shapes only; the gate evaluation below is 2021-2026 walk-forward.

### 3.1 Full 2021-2026 holdout (candidate `pbe-fight-simulator-v1.0-rc2`)

Run: `phase3/evaluate.mjs --n 2000 --rho 0.7`, fold parameters (`params_fold_<year>`, walk-forward guard on every bout), the Phase 3 seed and
determinism contract, resumed in bounded chunks (2023 remainder, 2024, 2025, 2026; peak RSS under 700 MB per chunk). 2021, 2022 and the first
145 bouts of 2023 were kept from the interrupted run (file validated: 0 bad lines, 0 duplicates). Holdout rows: 2,598 of 2,598, the identical set
to the Phase 3 baseline, with an identical gate partition (939 FULL, 1,397 LIMITED, 262 insufficient); 2,336 simulated bouts paired bout for bout.
rho was fixed at 0.7 from 2016-2020 card shapes before any holdout row existed and was not revisited.

| slice | n | winner Brier rc1 / rc2 | method LL rc1 / rc2 | distance Brier rc1 / rc2 | draw % rc1 / rc2 | over-max % rc1 / rc2 |
|---|---:|---|---|---|---|---|
| all 2021-2026 | 2,336 | 0.2285 / 0.2285 | 0.9823 / 0.9808 | 0.2405 / 0.2405 | 2.77 / 0.93 | 0.86 / 1.28 |
| 3 rounds | 2,047 | 0.2275 / 0.2276 | 0.9811 / 0.9801 | 0.2389 / 0.2389 | 2.74 / 0.93 | 0.98 / 1.47 |
| 5 rounds | 289 | 0.2352 / 0.2353 | 0.9906 / 0.9859 | 0.2524 / 0.2516 | 3.00 / 0.90 | 0 / 0 |
| 2021 | 412 | 0.2383 / 0.2383 | 0.9788 / 0.9766 | 0.2536 / 0.2526 | 2.67 / 0.94 | 0.97 / 1.70 |
| 2022 | 418 | 0.2296 / 0.2296 | 1.0125 / 1.0100 | 0.2392 / 0.2388 | 2.82 / 0.94 | 0 / 0 |
| 2023 | 382 | 0.2297 / 0.2298 | 1.0022 / 0.9998 | 0.2369 / 0.2369 | 2.90 / 0.97 | 0.26 / 0.52 |
| 2024 | 420 | 0.2258 / 0.2259 | 0.9550 / 0.9571 | **0.2362 / 0.2380** | 2.85 / 0.94 | 0.95 / 0.95 |
| 2025 | 411 | 0.2266 / 0.2268 | 0.9578 / 0.9587 | 0.2368 / 0.2371 | 2.74 / 0.90 | 1.46 / **2.68** |
| 2026 | 293 | 0.2176 / 0.2178 | 0.9916 / 0.9857 | 0.2405 / 0.2387 | 2.62 / 0.87 | 1.71 / 2.05 |

Per fold and format (3 rd / 5 rd), from `phase3/compare_rho.mjs`: 2024 5-round bouts (n 54) distance 0.2490 -> 0.2525, method LL
1.0192 -> 1.0302; 2023 5-round (n 48) method LL 1.0002 -> 0.9912, distance 0.2578 -> 0.2587; among the other fold x format cells the largest
degradations are +0.0019 method LL (2025 3-round) and +0.0016 distance Brier (2024 3-round); every larger move is an improvement (2021
5-round method LL 1.0543 -> 1.0385, 2026 3-round 0.9998 -> 0.9934, 2021 5-round distance 0.2959 -> 0.2913). Full grid in `.cache/phase3/compare_rho0.7_n2000.json`.

Paired bootstrap, 95% CI of the per-bout change (rc2 minus rc1; negative is better; 2,000 resamples, fixed seed):

| slice | winner Brier | method log loss | distance Brier |
|---|---|---|---|
| all | +0.00006 [-0.00005, +0.00017] | -0.00146 [-0.00347, +0.00066] | -0.00008 [-0.00074, +0.00061] |
| 3 rounds | +0.00006 [-0.00006, +0.00017] | -0.00100 [-0.00306, +0.00110] | +0.00003 [-0.00069, +0.00074] |
| 5 rounds | +0.00004 [-0.00028, +0.00038] | -0.00469 [-0.01183, +0.00183] | -0.00088 [-0.00297, +0.00110] |
| 2021 | -0.00001 [-0.00025, +0.00023] | -0.00216 [-0.00680, +0.00262] | -0.00095 [-0.00252, +0.00062] |
| 2022 | -0.00008 [-0.00033, +0.00017] | -0.00252 [-0.00726, +0.00226] | -0.00041 [-0.00202, +0.00117] |
| 2023 | +0.00007 [-0.00019, +0.00032] | -0.00241 [-0.00720, +0.00251] | -0.00001 [-0.00172, +0.00172] |
| 2024 | +0.00010 [-0.00017, +0.00037] | +0.00203 [-0.00284, +0.00693] | **+0.00188 [+0.00026, +0.00340]** |
| 2025 | +0.00012 [-0.00015, +0.00038] | +0.00086 [-0.00463, +0.00600] | +0.00028 [-0.00149, +0.00206] |
| 2026 | +0.00019 [-0.00014, +0.00050] | **-0.00596 [-0.01156, -0.00043]** | -0.00180 [-0.00354, +0.00001] |

Findings:
- The partial-2023 degradation (method LL 1.0418 -> 1.0454, distance 0.2393 -> 0.2400 on 117 bouts) does not survive the full fold: 2023
  method LL improves (1.0022 -> 0.9998) and distance Brier is unchanged (0.2369). It was noise in a partial slice.
- Five-round winner Brier (+0.00004) is noise: its CI is about seven times wider than the change. Winner Brier moves +0.00006 overall, inside its
  CI, with small positive point estimates in 2023-2026. The anchor pins the winner split to the champion by construction; the residual is the draw
  renormalisation (fewer draws), below the model card's four-decimal precision.
- One fold degrades significantly: 2024 goes-distance Brier +0.0019 (CI excludes zero), method LL +0.0020 (CI spans zero). 2024 five-round bouts
  carry most of it. 2026 improves significantly on method LL. Overall distance Brier is unchanged (-0.00008).
- Anchor strain rises: over-max 0.86% -> 1.28% overall, 2025 1.46% -> 2.68%; median tilt 0.234 -> 0.246. Persistence adds fight-level variance,
  which flattens the engine's own pre-anchor probabilities, so the anchor needs slightly more tilt. Under the unchanged strain rule about 0.4 points
  more bouts would show LIMITED.

Draw realism (holdout, walk-forward params, each variant with its own calibrated tilts; 800-bout sample x 300 fights):

| | real 2021-2026 | rc1 | rc2 |
|---|---:|---:|---:|
| 3-round draws, all bouts / decisions | 0.68% / 1.41% | 2.74% / 5.39% | 0.94% / 1.86% |
| 5-round draws, all bouts / decisions | 0.68% / 1.43% | 2.81% / 8.25% | 0.92% / 2.70% |
| mean predicted draw, full holdout evaluation | 0.77% (2015+ all bouts) | 2.77% | 0.93% |

Card shapes (single PBE card, holdout):

| 3-round card | real | rc1 | rc2 | 5-round card | real | rc1 | rc2 |
|---|---:|---:|---:|---|---:|---:|---:|
| 29-28 | 54.6% | 61.8% | 47.9% | 48-47 | 31.2% | 42.8% | 32.0% |
| 30-27 | 35.9% | 18.0% | 35.8% | 49-46 | 30.5% | 19.9% | 27.2% |
| 30-26 | 3.5% | 3.5% | 7.9% | 50-45 | 19.8% | 3.6% | 16.2% |
| 29-27 | 3.0% | 9.4% | 5.0% | 48-46 | 3.1% | 12.5% | 5.7% |
| 28-28 | 1.5% | 5.4% | 1.9% | 47-47 | 1.4% | 8.1% | 2.7% |

rc2 overshoots 10-8 sweeps (30-26: 7.9% vs 3.5% real). With persistence a dominant round is now usually won by the fighter who wins the others,
as in real fights, but the unfitted 10-8 margin (40) awards 10-8s more often than modern judges (real <= 5.0% of judge-rounds; rc2 6.0%). That is a
separate, unfitted score-rule parameter and was deliberately left unchanged.

Model card (same 2,336 holdout bouts; the published card is Phase 3, 2016-2026, 4,149 bouts):

| metric | rc1 holdout | rc2 holdout | baseline |
|---|---|---|---|
| Winner Brier | 0.2285 | 0.2285 | 0.2286 (PBE Fight Model alone) |
| Method log loss | 0.9823 | 0.9808 | 1.0084 (weight-class frequency) |
| Goes-distance Brier | 0.2405 | 0.2405 | 0.2455 (weight-class frequency) |
| Winner ECE | 0.0306 | 0.0304 | |
| KO/TKO mean p vs observed | 0.352 vs 0.319 | 0.353 vs 0.319 | |
| Finish-round CRPS (not shown in product) | 0.4273 | 0.4283 | 0.4206 historical |
| Clean-sweep round-winner accuracy (not shown) | 0.686 | 0.695 | 0.722 favourite every round |

Candidate: `pbe-fight-simulator-v1.0-rc2` = rc1 + `persistence { rho: 0.7, applies_to: [att, td_att] }` (`PARAMS_V1_0_RC2` in
`src/engine/params.mjs`). Engine spec SHA-256: rc1 `c0a4c915329c183ced7c673ec7069d69b1e943efd6c2f2d76373eb2ef32db73d` (unchanged, still the
default), rc2 `e91467694a97c94cb276423cd2a4b4df1f7f5e2ecdc3559a353c8fd7ed256dc6`. Proofs (`src/engine/rc2.test.mjs`, 6 tests): rc1 default and
hash pinned; rc2 = rc1 plus one frozen block; determinism (two in-process runs and a fresh process give identical artifact bytes); corner swap
(identical id and bytes on two fixtures); aggregate antisymmetry inside the engine; anchored winner equals the champion. Leakage: Phase 3 audit
(`.cache/phase3/leakage_audit.json`: 4,899 checked, 0 failures, 0 truncation diffs); every holdout bout passed `assertWalkForwardParams`; rho
selected on 2016-2020 only. Engine suite 32/32.

Recommendation against the predefined gates: the three overall gates pass (winner, method and distance not degraded), and draw and card-shape
realism improve materially. Two findings sit outside those gates and are the owner's call before release: the significant 2024 distance
degradation (+0.0019, concentrated in five-round bouts) and the higher anchor-strain rate (0.86% -> 1.28%). Production stays on rc1.

## 4. P2

- TUF hub: the stats block's aria-label used a retired card term ("coverage"); renamed. The test is unchanged. 175/175.
- /pro at 320px: the PBE Picks actions sat in a non-wrapping row inside an `overflow: hidden` card; the row now wraps (`app/pro-gate.css`). Prices,
  links, entitlements unchanged. Verified on production at 320 and 390: no clipped button, no horizontal scroll.
