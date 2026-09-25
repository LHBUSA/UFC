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

Gate evaluation (walk-forward, fold parameters, n_sims 2,000, `phase3/compare_rho.mjs`). PARTIAL: the run was stopped by the host for low memory
after 1,053 of 2,598 bouts; 947 are paired with the Phase 3 rows (folds 2021, 2022 and part of 2023). Not restarted.

| slice | n | winner Brier base / ρ | method LL base / ρ | distance Brier base / ρ | predicted draw % base / ρ | over-max % base / ρ |
|---|---:|---|---|---|---|---|
| all | 947 | 0.2332 / 0.2332 | 1.0014 / 0.9998 | 0.2455 / 0.2450 | 2.78 / 0.94 | 0.42 / 0.84 |
| 3 rounds | 829 | 0.2332 / 0.2331 | 0.9978 / 0.9975 | 0.2427 / 0.2426 | 2.74 / 0.95 | 0.48 / 0.97 |
| 5 rounds | 118 | 0.2336 / 0.2337 | 1.0273 / 1.0160 | 0.2648 / 0.2615 | 3.05 / 0.92 | 0 / 0 |
| fold 2021 | 412 | 0.2383 / 0.2383 | 0.9788 / 0.9766 | 0.2536 / 0.2526 | 2.67 / 0.94 | 0.97 / 1.70 |
| fold 2022 | 418 | 0.2296 / 0.2296 | 1.0125 / 1.0100 | 0.2392 / 0.2388 | 2.82 / 0.94 | 0 / 0 |
| fold 2023 (partial) | 117 | 0.2279 / 0.2279 | 1.0418 / 1.0454 | 0.2393 / 0.2400 | 3.04 / 0.98 | 0 / 0.85 |

Observed: 0.77% of all bouts are draws. Gates on the paired set: winner Brier not degraded, method log loss not degraded, distance Brier not
degraded. Determinism: the engine suite (26/26, incl. pinned simulation ids) passes with the hook absent; the hook draws from the fight's own
stream only when `persistence.rho` is set.

Status: NOT SHIPPED. The frozen v1.0-rc1 engine still runs in production unchanged (`persistence` absent). Shipping requires (1) finishing the
2023-2026 folds, (2) a new simulator version and engine spec hash, and (3) updating the model card figures, which this pass was told not to touch.
Until then the draw share shown on /simulator is the v1.0-rc1 figure, about three times the historical rate.

## 4. P2

- TUF hub: the stats block's aria-label used a retired card term ("coverage"); renamed. The test is unchanged. 175/175.
- /pro at 320px: the PBE Picks actions sat in a non-wrapping row inside an `overflow: hidden` card; the row now wraps (`app/pro-gate.css`). Prices,
  links, entitlements unchanged. Verified on production at 320 and 390: no clipped button, no horizontal scroll.
