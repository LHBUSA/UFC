# PBE Fight Model V2 — research sprint (2026-10-07)

V1 (`pbe-fight-model-v1`) was not touched: not its coefficients, not its
eligibility, not one locked call. Everything below is research code in
`scripts/model/v2/`, a frozen candidate artifact, and a SHADOW plan. Nothing
was registered, deployed or published.

Reproduce (read-only; GETs only):

```bash
PBE_MODEL_CACHE=<dir> node scripts/model/extract_dataset.mjs
PBE_MODEL_CACHE=<dir> node scripts/model/build_features.mjs   # must report 0 target_in_snapshot
PBE_MODEL_CACHE=<dir> node scripts/model/v2/research.mjs --live <live calls json>
PBE_MODEL_CACHE=<dir> node scripts/model/v2/freeze_candidate.mjs --cutoff 2026-10-07
node --test scripts/model/v2/v2.test.mjs
```

Full output of the run this document reports: `docs/model/data/v2_research.json`.

---

## 0. The learning pipeline blockers (fixed first)

**Provenance failure (FAILED_AUDIT on 2026-09-30 and 2026-10-04).** The
"8 corner snapshots contain the bout" were exactly eight
`ufc_fighter_dna_snapshots` rows dated `as_of_date = 2026-09-19`, written by
`ufc-intelligence/build_fight_dna@v1.1` at 2026-09-19T23:31Z — after UFC 331's
results landed. v1.1 selected bouts with an **inclusive** cutoff
(`event_date <= as_of`), so those rows absorbed the UFC 331 bout they were
supposed to precede. Commit `211fca8` (2026-09-24, v1.2) restored the exclusive
cutoff, but the rows v1.1 had already written were never rebuilt. Because no
learning run has produced a new parent dataset since challenger `e250a579`,
every LearnDaily increment re-includes the UFC 331 bouts and would have failed
the audit indefinitely.

A full scan of all 95,278 definition-1 snapshots found these eight and no
others. Repair (2026-10-07 ~20:54Z): the eight rows were backed up, then
rebuilt in place with the current builder (`--as-of 2026-09-19 --fighter <id>`,
upsert on the versioned key). Re-scan: 0 leaking rows; the audit reproduction
over the failed run's bouts: 0 target-in-snapshot. The leakage audit was not
changed.

**WAITING_FOR_DATA (2026-10-07).** The 2026-10-07 full Fight DNA build was
started four times by `ufc-intelligence` (07:24, 08:56, 09:52, 10:54Z) and
never finished: four `ufc_dna_build_runs` rows stuck in `running`, zero
`as_of 2026-10-07` snapshots written. The same build completes locally in
~14 s with no error, so the Worker isolate is being killed by a runtime limit
(no error is recorded because the process dies before it can close the row).
The exact limit needs the Worker's own logs, which this sprint could not read.
The build was run once locally (`--as-of 2026-10-07`, run `6a7b8b66`, 3,203
snapshots, reconciliation complete): the 2026-10-06 card now has 0 missing
snapshots and 0 missing bout-feature rows, so the next LearnDaily gate passes.
**The Worker-side failure is still open** and will recur on a future day until
it is diagnosed.

The research below uses a provenance-clean extract (the eight rows excluded,
those corners fall back to their previous valid snapshot);
`build_features.mjs` reports 0 / 0 / 0 for target-in-snapshot,
future-bout-in-snapshot and snapshot-after-event.

---

## 1. Protocol (fixed before results were read)

- Chronological walk-forward, expanding window, refit per calendar year,
  folds 2013–2026, the unchanged V1 recipe (`walkforward_core.fitFold`: ridge
  logistic, no intercept, λ from an inner chronological 80/20 split).
- Headline window **2015–2026 (6,243 scored bouts)**, the years where every
  candidate including the shrinkage layer (which needs earlier out-of-sample
  years to fit) is defined. 2022–2026 reported separately.
- Elo K and the opponent-metric centring are chosen on bouts **before 2013**
  only. A test proves later results cannot move K.
- Shrinkage for year Y is fitted only on walk-forward predictions of years < Y.
- Selection policy tuned on folds 2015–2021, scored once on 2022–2026.
- Event-cluster paired bootstrap (2,000 resamples) for every comparison.
- Market prices are never an input. The only market numbers below are the 22
  live calls with a lock-time FRESH price (the market extract starts
  2026-09-08, so no historical market benchmark exists).
- The 27 live calls are replayed for reporting only; they choose nothing.

---

## 2. V1 failure analysis

### Low sample: the 27 live calls point one way, the history points another

Live (27 calls): `<3` prior bouts n=6 Brier **0.282**, `3–5` n=7 **0.242**,
`6+` n=14 **0.199**. Six fights cannot separate a pattern from noise, so the
same slices were measured on 6,243 out-of-sample historical fights:

| min prior UFC bouts | n | Brier | AUC | mean conf | hit rate | recal slope |
|---|---|---|---|---|---|---|
| 0 (debut) | 1284 | 0.2470 | 0.564 | 55.1% | 53.2% | 0.85 |
| 1–2 | 1776 | 0.2328 | 0.652 | 60.2% | 61.2% | 1.01 |
| 3–5 | 1469 | 0.2306 | 0.663 | 59.0% | 62.6% | 1.31 |
| 6–9 | 1040 | 0.2340 | 0.650 | 58.3% | 61.0% | 1.29 |
| 10+ | 674 | 0.2349 | 0.642 | 57.7% | 60.8% | 1.35 |

(recal slope = fitted *a* in `y ~ sigmoid(a·logit p)`; < 1 overconfident, > 1 underconfident.)

- **Thin samples are not systematically overconfident.** The 1–2 bucket is
  calibrated (slope 1.01; 61.2% hit at 60.2% claimed). Its ≥75% calls hit
  77.4% at 80.7% claimed (n=93): a 3-point lean, inside noise.
- **V1 is underconfident on established fighters** (slopes 1.29–1.35 at 3+
  prior bouts). The ridge penalty pulls everything toward 50%.
- **Debut fights are near-blind** (AUC 0.564). Eligibility already no-calls them.
- **Steveson, the motivating example, was not a model-vs-information failure.**
  V1 said 89.6% with one prior UFC bout; the lock-time market said **92.0%**.
  It was a consensus upset. The live thin-sample miss where V1 disagreed with
  the market was **Tuivasa** (V1 57.2% vs market 18.0%).

### Where V1 has almost no signal or is overconfident

| slice | n | Brier | recal slope |
|---|---|---|---|
| five-round **non-title** | 362 | 0.2467 | **0.62** (overconfident, near coin) |
| three-round | 5656 | 0.2353 | 1.18 |
| title | 225 | 0.2270 | 1.24 |
| age gap < 2y | 1832 | 0.2421 | 0.96 |
| age gap 8y+ | 836 | 0.2175 | 1.35 |
| corner(s) with no takedown stats ("unknown" archetype) | 1307 | 0.242–0.252 | 0.34–1.57 |

The one clear overconfidence pocket is **five-round non-title main events**.
It persists in every candidate (C2 slope 0.48). It was found on the full
2015–2026 window, so it is a hypothesis to watch prospectively, not a
validated rule.

### Feature families behind the nine live misses

V1 logit contribution toward the pick, from each bout's canonical vector and
the registered artifact (top three families):

| miss | V1 | market | drivers |
|---|---|---|---|
| Pitbull v Choi | 73.3% | 70.5% | form, age, sample size |
| Steveson v Sharaf | 89.6% | 92.0% | striking, form, age |
| Menifield v Baraniewski | 65.5% | 68.5% | age, experience, form |
| Tuivasa v Despaigne | 57.2% | 18.0% | sample size, age, stance |
| Castaneda v Alatengheili | 58.6% | — | reach, striking, form |
| Gautier v Kopylov | 71.0% | 68.5% | age, form, reach |
| Rodriguez v Coria | 55.6% | 43.7% | form, sample size, reach |
| Walker v Parkin | 55.5% | — | age, form, takedowns |
| Dos Anjos v Hernandez | 55.6% | — | experience, stance, sample size |

Age and raw form (win rate, streak) recur. Raw form is exactly what an
opponent-quality rating corrects: a 6-1 record against weak opposition is not
a 6-1 record against strong opposition.

---

## 3. Candidates and full walk-forward metrics (2015–2026, n = 6,243)

| candidate | Brier | log loss | AUC | acc | ECE | recal | ΔBrier vs V1 [95% CI] 2015+ | ΔBrier vs V1 [95% CI] 2022+ |
|---|---|---|---|---|---|---|---|---|
| coin | 0.2500 | 0.6931 | 0.500 | 50.0% | — | — | +0.01437 | +0.01998 |
| win-rate baseline | 0.2447 | 0.6825 | 0.586 | 55.7% | 0.0156 | 1.01 | +0.00907 | +0.01109 |
| **V1** (reproduced) | 0.2356 | 0.6638 | 0.638 | 59.8% | 0.0155 | 1.15 | — | — |
| C1 V1 + shrinkage | 0.2356 | 0.6636 | 0.637 | 59.8% | 0.0177 | 1.15 | −0.00002 [−0.00030, 0.00027] | −0.00048 [−0.00099, 0.00015] |
| **V1 + Elo (chosen)** | 0.2334 | 0.6591 | 0.649 | 60.4% | 0.0184 | 1.07 | **−0.00228 [−0.00317, −0.00157]** | **−0.00214 [−0.00338, −0.00097]** |
| V1 + opp-DNA only | 0.2355 | — | — | — | — | — | −0.00015 [−0.00064, 0.00027] | −0.00064 [−0.00132, 0.00000] |
| C2 V1 + Elo + opp-DNA | 0.2334 | 0.6592 | 0.649 | 60.4% | 0.0154 | 1.08 | −0.00224 [−0.00300, −0.00133] | −0.00255 [−0.00390, −0.00125] |
| C2 + shrinkage | 0.2336 | 0.6595 | 0.648 | 60.4% | 0.0172 | 1.14 | −0.00202 [−0.00283, −0.00105] | −0.00241 [−0.00380, −0.00110] |
| C3-only V1 + interactions | 0.2354 | 0.6633 | 0.639 | 59.9% | 0.0167 | 1.13 | −0.00022 [−0.00075, 0.00044] | −0.00012 [−0.00126, 0.00117] |
| C3 C2 + interactions | 0.2332 | 0.6587 | 0.649 | 60.6% | 0.0152 | 1.09 | −0.00241 [−0.00323, −0.00124] | −0.00280 [−0.00413, −0.00103] |
| C4 GBM on C3 features | 0.2331 | 0.6583 | 0.649 | 60.7% | 0.0104 | 1.11 | −0.00251 [−0.00393, −0.00128] | −0.00292 [−0.00512, +0.00067] |

Increments on the same bootstrap: C2 (adding opp-DNA) over V1 + Elo +0.00004 [−0.00044, 0.00046]; C3 over C2 −0.00017 [−0.00066, 0.00039];
GBM over ridge C3 −0.00010 [−0.00105, 0.00079]. Neither is distinguishable
from zero.

**Candidate 1, shrinkage.** A learned, symmetric logit multiplier
`m(q) = c0 + c1/(1+min prior) + c2/(1+min stat bouts) + c3·(share missing)`,
fitted only on earlier out-of-sample years. It learns the right *shape*
(2026 fit: c0 = 1.41 expands established-fighter calls, c1 = −0.91 shrinks
thin records) but the gain does not transfer out of sample: ΔBrier ≈ 0. A
probability cap was not tried; the evidence does not call for one.

**Candidate 2, opponent adjustment.** Two parts. Elo: a chronological rating
(start 1500, K = 48 chosen on pre-2013 bouts, provisional K boost for early
bouts, a date's results applied only after that date's bouts are read).
Opponent-adjusted Fight DNA: each prior opponent measured by **their own
snapshot as of the date they were fought** — striking differential, control
share, durability, performance against the opponent's expected strike rates,
and quality wins by as-of DNA. Elo carries all of the significant gain. The
DNA terms are weakly positive in 2022+ only.

**Candidate 3, interactions.** Twelve antisymmetric terms: age × five rounds,
age × older pairing, layoff × age, cardio and championship-round pace ×
five rounds, reach × distance share, reach × heavyweight, grappling,
power and striking cross-matchups, experience × thin sample, title experience
× title bout. No measurable gain. **Short-notice × experience could not be
tested**: `short_notice_days` is null on all 18,832 bout-feature rows.

**Candidate 4, nonlinear.** Gradient-boosted trees, depth 3, trained on
mirrored data and served as `(F(x) − F(−x))/2`, so they are exactly
antisymmetric (tested). Tree count chosen per fold on an inner chronological
split. Best ECE (0.0104), but Brier and log loss are tied with ridge C3, and
the 2022+ CI crosses zero. Not chosen.

---

## 4. Best candidate: V1 + Elo

`pbe-fight-model-v2-candidate-elo` — V1's 33 features plus one Elo difference,
the unchanged V1 training recipe. Frozen in
`scripts/model/v2/artifacts/pbe-fight-model-v2-candidate-elo.json` (hashes in
§8).

Why this one:
- It captures essentially all of the improvement any candidate found:
  −0.0023 Brier and −0.0047 log loss versus V1, with CIs excluding zero in
  both windows. That is about 16% more skill over a coin than V1 has
  (0.0144 → 0.0166 Brier).
- Everything richer (opp-DNA, interactions, GBM, shrinkage) is statistically
  indistinguishable from it.
- It is the cheapest to run in production: one rating per fighter, updated
  once per card, with no per-opponent snapshot walk.

What it changes by evidence level: debut AUC rises from 0.564 to about 0.62
(the debutant's opponent now carries a rating), and the 3+ prior-bout
underconfidence shrinks.

**Live replay (27 calls, report only — trained on bouts before 2026-09-19):**

| | Brier | log loss | hit rate |
|---|---|---|---|
| V1 as stored (locked) | 0.2288 | 0.6651 | 66.7% |
| V1 replayed by this harness | 0.2287 | 0.6653 | 66.7% |
| V1 + shrinkage | 0.2255 | 0.6559 | 66.7% |
| **V1 + Elo (chosen)** | **0.2195** | 0.6449 | 70.4% |
| C2 | 0.2122 | 0.6230 | 74.1% |
| C3 | 0.2059 | 0.6066 | 74.1% |

On the 22 calls with a FRESH lock-time price: market **0.2016**, V1 0.2245,
V1 + Elo 0.2153, C2 0.2085, C3 0.2059. V1 + Elo flips one pick (Dos Anjos,
a V1 loss). C2 and C3 look better on these 27 than the chosen model does.
That is **not** a reason to choose them: 27 fights, and the historical
bootstrap says they are tied with V1 + Elo. Choosing on the live record would
be fitting the record.

**The honest size of this.** About 0.002 Brier is a modest, real gain. It
does not make the model a market-beater. On the 22 paired live calls, the
best candidates move from V1's 0.2245 toward the market's 0.2016. Twenty-two
fights cannot establish more than that.

---

## 5. Low-sample calibration, and why no shrinkage ships

On 6,243 historical fights, the thin-sample buckets are calibrated or close
to it under both V1 and the candidates. The learned shrinkage, fitted only on
past years, does not improve future years. The risk that remains is the tail:
thin-record calls at ≥75% hit 3–5 points below their claimed probability
(V1 77.4% at 80.7%, n=93; V1 + Elo 76.3% at 80.7%, n=131). That is handled in the
**publication policy** (§6), not by bending the probability.

---

## 6. Selection policy: does a stricter no-call help? Yes, mostly through the threshold

Eligible universe: non-DWCS, both corners ≥ 1 prior UFC bout, ≥ 20 features.
Tuned on 2015–2021 (objective fixed in advance: maximise the Wilson lower
bound of the published hit rate, subject to publishing at least 35% of
eligible bouts). Scored once on 2022–2026 (1,980 eligible bouts).

Held out, 2022–2026 (1,980 eligible bouts):

| model | rule | published | coverage | hit rate | Wilson 95% low | Brier (published) |
|---|---|---|---|---|---|---|
| V1 | V1 rule (≥55%) | 1366 | 69.0% | 67.1% | 64.5% | 0.2171 |
| V1 | uniform ≥60% (tuned) | 779 | 39.3% | 72.3% | 69.0% | 0.1997 |
| V1 | tiers 57.5 / 65 / 60% (tuned) | 710 | 35.9% | 72.4% | 69.0% | 0.1979 |
| V1 | no thin samples (min prior ≥3, ≥55%) | 1001 | 50.6% | 68.1% | 65.2% | 0.2152 |
| **V1 + Elo** | V1 rule (≥55%) | 1370 | 69.2% | 67.2% | 64.7% | 0.2158 |
| **V1 + Elo** | **uniform ≥60% (tuned) — frozen primary** | 825 | 41.7% | **72.5%** | 69.3% | 0.1989 |
| **V1 + Elo** | tiers 62.5 / 65 / 60% (tuned) — frozen variant | 626 | 31.6% | 74.3% | 70.7% | 0.1909 |
| **V1 + Elo** | no thin samples (min prior ≥3, ≥55%) | 1009 | 51.0% | 68.2% | 65.2% | 0.2139 |
| C2 | uniform ≥60% (tuned) | 830 | 41.9% | 72.3% | 69.1% | 0.1987 |
| C2 | tiers 65 / 60 / 60% (tuned) | 746 | 37.7% | 73.6% | 70.3% | 0.1940 |

Tiers are min prior UFC bouts 1–2 / 3–5 / 6+.

- **Raising the bar from 55% to about 60% is the real improvement.** For V1
  it lifts the held-out hit rate from 67.1% to 72.3% while publishing about
  40% of eligible bouts instead of about 69%.
- **Sample-aware tiers add little over a single 60% cutoff.** The tuned tiers
  for V1 + Elo are non-monotone (the 3–5 tier is stricter than 1–2), and on the
  holdout they fall below the 35% coverage floor they were tuned under. That
  is the signature of noise-fitting.
- **No-calling every thin-sample fight is the wrong lever**: 68.1% hit at 51%
  coverage, versus 72%+ for a threshold.
- **Frozen policy:** primary = debut no-call + one uniform ≥60% cutoff; the
  tier rule is frozen beside it as a pre-registered variant. Both are recorded
  in the artifact and must be tested prospectively on the shadow track before
  anything public changes. Neither has been applied to V1's public calls.

---

## 7. Tests

`node --test scripts/model/v2/v2.test.mjs`:
- Elo reads a date's ratings before that date's results; K selection is
  immune to post-2013 results (this caught and fixed a same-date bout-count
  bug).
- Opponent quality is point-in-time: deleting every row and snapshot dated on
  or after D leaves it bit-identical.
- Every V2 feature is exactly antisymmetric under a corner swap.
- GBM: `p(x) + p(−x) = 1` to 1e-12; fitting is deterministic.
- Shrinkage keeps complementarity and refuses to fit on fewer than 300 rows.
- No V2 file reads a market price.

Parity: the harness's V1 replay reproduces the stored live probabilities to
about 0.005 (the difference is the four extra weeks of training data), and a
refactor rerun reproduced every metric exactly.

---

## 8. Frozen artifact

`scripts/model/v2/artifacts/pbe-fight-model-v2-candidate-elo.json`

| | |
|---|---|
| model_version | `pbe-fight-model-v2-candidate-elo` |
| feature_version | `pbe-fight-features-v2-elo` (V1's 33 + `elo_diff`) |
| training | 9,249 graded bouts, 1994-03-11 → 2026-10-06 (cutoff exclusive 2026-10-07) |
| λ / Elo K | 20 / 48 |
| dataset_sha256 | `c174ca8f76a090f6f9f4ec9cc40321125125441a98777c59f2b6e3412f55c73b` |
| spec_sha256 | `cc84aa7c2ece16e5b499b9e1f0a7cee6863193d3078adaaaccc0584de518d029` |
| status | FROZEN_RESEARCH_CANDIDATE — not registered, not deployed, not published |

The artifact's `code_sha` is the commit it was generated from. The spec hash
covers the version strings, feature list, coefficients, scales, λ, K and the
Elo rule.

---

## 9. SHADOW deployment plan (not executed; stop before promotion)

UFC Workers are frozen. Every step below that touches `ufc-algo` or
`ufc-intelligence` needs explicit owner approval naming the Worker.

1. **Elo source of truth.** Rather than replay the whole archive on every
   cycle, compute the ladder once per card. It can live in R2
   (`ufc-algo-artifacts/learning/elo/<as_of>.json`, no migration), or in a new
   table, which needs a migration and therefore owner approval. It must use the
   same date-block rule and K as the artifact, with a parity test against
   `features_v2.eloLadder` over the full history.
2. **Shadow scoring.** In `ufc-algo`, score every bout V1 scores with the
   frozen candidate, in the same cycle, against the same feature row plus
   `elo_diff`. Write to `ufc_model_shadow_predictions` under a dedicated
   `training_run_id` row whose `spec_sha256` is the artifact's. Lock at the
   same lock pass as V1. The shadow-isolation invariant is unchanged: shadow
   rows never touch official predictions, grades, record or Pro.
3. **Selection shadow.** Record, for each bout, whether the frozen V2 policy
   would have published it. Report the published subset separately.
4. **Prospective evidence before any promotion recommendation:** at least 150
   paired graded bouts (about 3–4 months of cards). Paired event-cluster
   bootstrap ΔBrier < 0 with the upper CI below zero, ECE ≤ 0.03, and no
   prior-bout bucket worse than V1 by more than its CI.
5. **Before promotion:** `web/lib/algo.ts` must resolve per-prediction
   `model_version` (still V1-only). Promotion stays owner-only via
   `POST /admin/promote`.

Open, separate from V2: the `ufc-intelligence` full-build kill (§0) needs the
Worker's logs.

---

## 10. SHADOW deployment (2026-10-07, owner-approved; no promotion)

**Live:** `ufc-algo` version `8fa120a2` (rollback `50945947`). Deploy source:
`d9a9916` (byte-identical to the previously live build) + the V2 shadow files
only, tag `deploy/ufc-algo/2026-10-07-v2-shadow` (`bd3f026` = main `d978b7d`).
The undeployed 2026-09-19 grade-refresh commits and minute cron stay undeployed.

- **Registration:** `ufc_model_training_runs` `a98335e1` (status `RESEARCH_SHADOW`,
  spec `cc84aa7c…`, dataset `c174ca8f…`; the dataset and artifact are in R2 under
  `learning/research/v2/pbe-fight-model-v2-candidate-elo/`, round-trip re-hashed).
  Migration 036 applied 2026-10-07 22:4xZ (`20261007220000`). The row is immutable.
- **Elo source:** `ufc-algo-artifacts/learning/elo/<as_of>.json`, built once per
  day by the first armed cycle, sha256 in R2 metadata, never overwritten. Parity
  with research: 9,507 bouts, 894 dates, bit-identical (`elo_parity.test.mjs`).
- **Scoring:** every bout V1 evaluates; paired universe = every V1 gate passes
  except possibly the 55% threshold; locks in V1's lock pass; graded by the
  existing shadow grader. Each row freezes the V1/V2 probability pair and the
  V1 ≥55%, V2 ≥60% (primary) and tier-variant (research only) decisions.
- **V1 parity:** fake-DB test (official writes identical with and without V2)
  and a production dry run on live data (29 bouts, 3 cards, every V1 field
  identical between the baseline and V2 code).
- **Isolation:** V2 writes only `ufc_model_shadow_predictions` and
  `ufc_model_lock_shadow`. No learning, review or promotion query selects
  `RESEARCH_SHADOW`; both tables are service-role only (anon 401); a test scans
  every public web and Worker surface for V2 identifiers.
- **Public:** the UFC Picks threshold stays 55%; the ≥60% rule is a frozen shadow
  policy, not a production policy.

Evaluate prospectively (read-only):
`node scripts/model/v2/shadow_report.mjs` — paired Brier and log loss, ECE, hit
rate, coverage under each policy, event-cluster bootstrap, prior-bout and
five-round non-title slices, the frozen gate, then market as a benchmark. It
reports `INSUFFICIENT EVIDENCE` until 150 paired graded bouts exist.

### ufc-intelligence daily build fix (same day)

Root cause, from Cloudflare invocation analytics: the four 2026-10-07 builds
ended `internalError` at 900.0 s wall time (the Cron Trigger limit) with
1.0–1.7 s CPU. Database saturation stretched one all-or-nothing invocation past
the limit. v0.4.0 (`a2a38c50`, then `43b4b41f`; rollback `316eaa30`) bounds each
build to 12 min, closes it `partial` with a cursor, resumes only on identical
inputs, adds single flight, and reaps `running` rows older than the wall limit.
The reaper closed the four orphaned rows at 21:47:02Z.
