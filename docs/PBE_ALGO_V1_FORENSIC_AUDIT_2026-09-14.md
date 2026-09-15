# PBE Algo v1: pre-registration forensic audit (2026-09-14)

**Scope.** The two UFC 331 outputs most likely to expose a pre-launch weakness:
- **Tai Tuivasa:** model 57.2% vs 17.3% de-vigged market.
- **Gable Steveson:** 89.6% with one prior UFC bout and 27 of 33 features.

This was an audit, not tuning. No coefficient, threshold or eligibility rule was changed. The one code change was market-price provenance in the scheduler (a52c124).

**Evidence runs:**
- **Fresh extract:** 2026-09-14T22:56:48Z, then `build_features.mjs`. The leakage audit was clean: target_in_snapshot 0, future_bout_in_snapshot 0, snapshot_after_event 0.
- **Scheduler dry run:** 2026-09-14T22:57:48Z.
- **Walk-forward re-run** on that dataset: n=7,056, Brier 0.23630, ECE 0.0133, slope 1.034.

## 1. Tuivasa vs Despaigne: the market data

- **Bout:** fd39d953-6bc2-49d8-a6ee-12c3b85c76a9 (UFC 331, heavyweight).
- **Fighters:** Tai Tuivasa (d9537bff-cc2b-4c2a-a371-f7bfc2d27abd) vs Robelis Despaigne (d4a0b190-ed52-4005-804e-ce693adb0af1).
- **Market source:** one `h2h` snapshot, source event `35495c892bf6e3997d2725df4ca003df`, commence 2026-09-19T23:45Z, observed 2026-09-08T12:25:03Z. It is the **only market snapshot in the database** (352 rows).

| Book | Tuivasa | Implied | Despaigne | Implied | Overround | Per-book de-vig (Tuivasa) | source_last_update |
|---|---|---|---|---|---|---|---|
| betonlineag | +482 | 0.1718 | −650 | 0.8667 | 1.0385 | 0.1655 | 12:21:28Z |
| betrivers | +400 | 0.2000 | −590 | 0.8551 | 1.0551 | 0.1896 | 12:22:17Z |
| draftkings | +455 | 0.1802 | −625 | 0.8621 | 1.0422 | 0.1729 | 12:22:17Z |
| fanduel | +360 | 0.2174 | −530 | 0.8413 | 1.0587 | 0.2053 | 12:22:41Z |
| williamhill_us | +460 | 0.1786 | −650 | 0.8667 | 1.0452 | 0.1708 | 12:23:09Z |

**Consensus:**
- Median implied: Tuivasa 0.18018, Despaigne 0.86207 (sum 1.04225).
- Proportional de-vig: **Tuivasa 0.17288**, Despaigne 0.82712. Five books per side.

**Checks, all passed:**
- Outcome IDs map to the correct corners, and each `outcome_name` matches its `outcome_fighter_id`.
- The sides are not inverted.
- No observations from other bouts are attached.
- No book appears twice after taking its latest price.
- No malformed American price (nothing between −100 and +100).
- The two de-vigged sides are complementary.

**Parity.** An independent recompute, `market_baseline.consensusForBout` and the Worker all give 0.1729 and a delta of +39.9 pts. Per-book de-vigs range from 16.6% to 20.5%, so the market is consistent across books.

**Finding: market provenance, not mapping.**
- **Problem:** the Worker labelled every comparison `observed_before = run time`. The price was actually taken six days earlier, and nothing refreshes it on a schedule.
- **Fix (a52c124):** the Worker now stores `observed_at`, `oldest_book_update` and `age_hours`, drafts carry `market_snapshot_at`, and the Pro card shows when the price was taken.
- **Production dry run after the fix:** Tuivasa `observed_at 2026-09-08T12:25:03Z`, `age_hours 154.7`.

## 2. Model: identity, features, parity, antisymmetry

| Check | Tuivasa bout | Steveson bout |
|---|---|---|
| Canonical corner 1 (smaller UUID) | Despaigne | Sharaf |
| Snapshot as_of | 2026-09-14 (both corners) | 2026-09-14 (both corners) |
| Prior / stat bouts | Despaigne 3/3, Tuivasa 18/18 | Sharaf 2/2, Steveson 1/1 |
| Last completed bout | Despaigne 2024-10-19, Tuivasa 2026-05-02 | Sharaf 2025-12-14, Steveson 2026-07-11 |
| Record reconciles / stale | yes / no (both corners) | yes / no (both corners) |
| Bout history vs DB | Despaigne: W Parisian, L Cortes Acosta, L Lane. Tuivasa: 7 straight losses since 2022. | Steveson: W Ellison (KO). Sharaf: L Tafa, L Asplund (both KO). |
| Worker vs Node batch: feature vector | max \|Δ\| = 0, availability identical | max \|Δ\| = 0, availability identical |
| Worker vs Node batch: p(corner 1) | 0.42808051 vs 0.42808051078…, equal at 1e-8 | 0.10376544 vs 0.10376544232…, equal at 1e-8 |
| Antisymmetry (negated vector, and rebuild with corners swapped) | 0.5719195 = 1 − p, error 1.1e-16 | 0.8962346 = 1 − p, error 0 |
| Features outside training min/max | none | none |
| Features beyond training p99 of \|z\| | reach +9 in (z 2.94); southpaw (binary ±1, always at its bound) | sig. strike differential per minute (z −7.13), SApM (z 5.12), KO-loss rate (z 4.54), last-5 win rate (z −3.28) |
| \|logit\| percentile vs training rows | 44th (an ordinary-strength call) | 99.8th (an extreme call) |

**Tuivasa: largest contributions.**
- **Toward Tuivasa:**
  - age (Despaigne 38.0 vs Tuivasa 33.5): +0.29
  - five-round experience: +0.19
  - southpaw: +0.13
  - Despaigne's 23-month layoff: +0.10
  - quality wins: +0.10
- **Against Tuivasa:**
  - reach (−9 in): −0.28
  - streak (Despaigne −2 vs Tuivasa −5, clamped): −0.11
- **Cancelling terms:** experience-log (−0.34) and stat-sample-log (+0.31).
- **Net:** logit +0.29 for Tuivasa, p = 57.2%.

**Steveson: the call rests on one short fight per corner.**
- Main contributions: sig. strike differential per minute +0.57 (z −7.13), win rate +0.44, age +0.44, SApM +0.34, KO-loss rate +0.27.
- Six features are missing: TD defence, finish rate, KO rate, sub rate, pace retention and championship-round pace.

**Refit stability.** Refitting the same recipe on today's database moves every upcoming UFC probability by at most 0.54 pts (22 bouts). Tuivasa goes from 57.19 to 56.97 / 57.07; Steveson from 89.62 to 89.80 / 89.88.

**Provenance finding.** The v1 artifact cannot be reproduced exactly from today's database:
- Its training window now holds 9,174 rows versus 9,175 at release.
- λ selection picks 5 instead of 2.
- The largest coefficient difference is 0.012.

The artifact's own spec hash still re-verifies. Re-training is deterministic: two runs on the same data both produced spec 225edbda….

## 3. Is 57.2% vs 17.3% an outlier?

- **Versus the other priced bouts:** Tuivasa's |delta| is 39.9. The median across UFC 331's 10 priced bouts is 4.98 and the next largest is 12.6. That puts it about 8 SD above the other nine, but the reference set is tiny.
- **Market:** stable across all 5 books (16.6–20.5%), but six days old at the time of the audit.
- **Inputs:** all within training range. The only features beyond the 99th percentile are a genuine 9-inch reach gap and the binary southpaw flag. The probability's logit magnitude sits at the 44th percentile.
- **Missing evidence:** there is no timestamp-compatible historical market sample. The release artifact has market n=0 and the re-run has n=13, so there is no evidence about how disagreements of this size resolve.

**Conclusion: LEGITIMATE MODEL/MARKET DISAGREEMENT — NO DEFECT FOUND.** The model sees a 38-year-old with a 1-2 UFC record and a 23-month layoff, facing a younger opponent on a losing streak. The market is pricing Despaigne's size and ceiling. The call is not suppressed.

## 4. Steveson: how reliable is 89.6% on one prior bout?

The data is out-of-sample walk-forward rows only: `backtest_predictions.jsonl`, where each row was scored by a model trained on earlier years. Rows are folded onto the pick, and confidence intervals are Wilson 95%.

| Slice | n | Mean predicted | Observed hit rate | 95% CI | Brier | Log loss | ECE |
|---|---|---|---|---|---|---|---|
| All out-of-sample | 7,056 | 0.583 | 0.595 | 0.583–0.606 | 0.2363 | 0.6651 | 0.013 |
| Min prior = 1, pick ≥ 80% | **28** | 0.856 | 0.821 | 0.644–0.921 | 0.147 | 0.468 | n<100 |
| Min prior = 1, pick 70–80% | 105 | 0.740 | 0.667 | 0.572–0.750 | 0.229 | 0.653 | 0.118 |
| Min prior = 1, pick 60–70% | 391 | 0.641 | 0.645 | 0.596–0.690 | 0.229 | 0.650 | 0.037 |
| Min prior = 2, pick ≥ 80% | 20 | 0.846 | 0.900 | 0.699–0.972 | 0.110 | 0.437 | n<100 |
| Min prior ≥ 2, pick ≥ 80% | 37 | 0.835 | 0.892 | 0.753–0.957 | 0.108 | 0.407 | n<100 |
| Min prior ≥ 3, pick ≥ 80% | 17 | 0.822 | 0.882 | 0.657–0.967 | 0.106 | 0.372 | n<100 |
| Any striking-rate \|z\| > 4, pick ≥ 80% | 23 | 0.858 | 0.870 | 0.679–0.955 | 0.115 | 0.392 | n<100 |

**What the slices show:**
- **The slice Steveson falls in** (one prior bout, pick ≥ 80%) hit 82% against a mean prediction of 86%. That is consistent with good calibration, but n=28 (CI 64–92%) cannot confirm a figure of 89.6%.
- **The only credible miscalibration signal** is the one-prior-bout, 70–80% slice: 7.3 pts overconfident on n=105, with the CI's upper bound at 75.0%.
- **Extreme small-sample striking rates** do not degrade the ≥ 80% tail (n=23, 87% hit rate).
- **The market agrees with Steveson's number:** 89.4% de-vigged.

**Verdict for Steveson's numeric probability: INSUFFICIENT EVIDENCE.** This is not a defect. The MEDIUM confidence cap is correct and stays.

**No new eligibility rule is proposed.** Shrinking probabilities for sparse samples is a candidate for a separate challenger model family (see PBE_ALGO_LEARNING_DESIGN.md), not a v1 rule change.

## 5. Go / no-go

| Bout | Identity | Features | Market mapping | Model parity | OOD | Calibration evidence | Verdict |
|---|---|---|---|---|---|---|---|
| Tuivasa vs Despaigne | reconciled, fresh, correct orientation | 31/33, no future data | correct; price 6 days old (provenance now fixed) | Worker = Node at 1e-8; exact antisymmetry | in range; reach and southpaw at the tail | no market history exists to test the disagreement | **CLEAN** |
| Steveson vs Sharaf | reconciled, fresh, correct orientation | 27/33, no future data | correct; price 6 days old (provenance now fixed) | Worker = Node at 1e-8; exact antisymmetry | in range; 4 rate features beyond p99 | n=28 in its slice: consistent but unconfirmable | **INSUFFICIENT EVIDENCE** (for the 89.6% figure only) |

**Recommendation: REGISTER V1.** No data, identity, market-mapping or model defect was found. The one real weakness, market-price provenance, is fixed in the scheduler. The Steveson figure reflects a sample-size limit that the existing MEDIUM cap already expresses.

**Owner decision needed before arming: market freshness.** The only odds stored are one snapshot from 2026-09-08. Every PBE delta at the UFC 331 lock would therefore be about ten days old. The card now shows when the price was taken, but a scheduled odds capture before the lock would make the delta current.
