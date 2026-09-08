# PBE Fight Model v1 — methodology

An independent win-probability model for UFC bouts.

Two constraints shaped every decision below, and they are not negotiable in v1:

1. **The model never sees a sportsbook price.** Odds are not a feature, not a
   prior, not a tiebreak, and not a target. A market price is read only after a
   probability exists, and only to compare against it. A model that consumes the
   line is a line-repackager; whatever it produces cannot disagree with the
   market in a way anyone should act on.
2. **The model only sees what was knowable before the bout started.** Not the
   result, not the round stats, not the fighter's career totals as they stand
   today, not a ranking published afterwards, not a price that moved later. The
   enforcement of this is in `docs/model/LEAKAGE.md`, and it is enforced by
   tests rather than asserted by comment.

Results: `docs/model/BACKTEST_v1.md`. Leakage proof: `docs/model/LEAKAGE.md`.
Live record contract and schema: `docs/model/LIVE_CONTRACT.md`, `migrations/011_ufc_model_predictions.sql`.

---

## 1. The data

The temporal feature source is the **repaired historical Fight DNA layer** built
by `scripts/dna/build_fight_dna.mjs` and regenerated across all of history by
`scripts/dna/repair_historical_snapshots.mjs`.

That repair is what makes this model possible. It writes one
`ufc_fighter_dna_snapshots` row per fighter per *day after each of their bouts*,
containing only bouts with `event_date < as_of_date`. There are 21,747 such
snapshots across 876 distinct dates and 3,159 fighters. Selecting the latest
snapshot with `as_of_date <= event_date` therefore yields a fighter as they
stood walking into that specific fight, not as they stand now.

Also read:

| Source | Used for |
|---|---|
| `ufc_fighter_dna_snapshots` | as-of striking, grappling, pace, finishing, durability, sample quality |
| `ufc_fighter_bout_features` | the chronological ladder: recent form, layoff, takedown defence, strength of schedule |
| `ufc_fighters` | date of birth, height, reach, stance — and nothing else |
| `ufc_bouts` / `ufc_events` | who fought whom, when, in what division |
| `ufc_bout_results` | **labels only**, never features |
| `ufc_market_observations` | **comparison only**, never features |

`ufc_fighters` also carries `record_w`, `career_slpm`, `career_str_def` and
their siblings. Those describe a fighter **as they are today**. Applied to a
2015 bout they are a direct statement of what happened after it. The extractor's
`select` list omits them, so no later stage can reach them even by accident;
`scripts/model/feature_spec.mjs` names them in `BANNED_FIGHTER_COLUMNS` and the
leakage audit asserts their absence.

### Physical constants, and the one caveat

Date of birth, height and reach are physical facts that do not change with a
result, so reading them from the current profile is not leakage. Stance is the
one soft edge: it is stored as a present-day profile field, and a fighter who
switched stance mid-career is described by their final stance throughout.
That is a documented approximation, not a hidden one. It is a style label rather
than an outcome accumulator, it is rare to change, and it enters the model
through exactly one antisymmetric feature (`southpaw_edge`). Fixing it properly
means a stance-as-of history, which is a Fight DNA task rather than a model one.

---

## 2. Orientation, and the trap in this dataset

**In this database the fighter listed first wins 93.5% of completed bouts.**

That is not a fact about fighting. The UFCStats ingest lists the winner first, so
`fighter_a_id` is the winner in almost every historical row. Any model with an
intercept, or with a single non-differential feature, learns that instantly and
reports something like 93% accuracy while knowing nothing at all. It is the
single easiest way to produce an impressive and worthless UFC model, and it would
survive a naive walk-forward validation untouched, because the artifact is
present in the future as well as the past.

Two design decisions kill it:

- **Canonical orientation.** Every bout is oriented by sorting the two fighter
  UUIDs lexicographically. UUIDs are random and outcome-independent, so the base
  rate under this orientation is 50.45% over the full history and 50.83% over
  the scored period — a coin, as it should be.
- **Antisymmetric features and no intercept.** Every feature is a difference
  between the two corners. Swapping the corners negates the vector, and with no
  intercept the probability becomes exactly complementary. The model is
  structurally incapable of learning a corner bias.

A consequence worth stating: bout-level facts that are identical for both corners
— weight class, scheduled rounds, title status — cannot be v1 inputs, because a
symmetric term carries no information about *which* fighter wins. They are still
recorded, and they slice the reporting.

---

## 3. Features

33 features, all differences, grouped by family. Full definitions with their
documented expected signs are in `scripts/model/feature_spec.mjs`; the fitted
coefficients ship in `web/lib/generated/model-v1.json`.

| Family | Features |
|---|---|
| Age | age at the event date |
| Reach / height | reach, height |
| Experience | prior bouts (log), five-round appearances, title appearances |
| Recent form | smoothed prior win rate, last-five win rate, signed streak, layoff |
| Striking pace | strikes landed and absorbed per minute, differential |
| Accuracy / defence | significant strike accuracy, significant strike defence |
| Striking damage | knockdowns scored and conceded per 15 |
| Takedown offence | takedowns landed per 15, takedown accuracy |
| Takedown defence | one minus opponent takedown accuracy across prior bouts |
| Control / grappling | control share, submission attempts per 15 |
| Finishing | finish rate, KO rate, submission rate |
| Durability | share of prior appearances ending in a stoppage or a submission loss |
| Pace retention | round-three vs round-one pace, championship-round delta |
| Stance | southpaw-versus-orthodox asymmetry |
| Opponent-adjusted | mean pre-fight win rate of prior opponents, count of quality wins |
| Sample quality | log stat-covered prior bouts |

Two of these deserve their reasoning stated.

**Opponent adjustment.** Strength of schedule is computed by walking the fight
history in strict date order and recording, for each past bout, the opponent's
win rate *as it stood on that date*. A fighter who beat a 12-2 opponent in 2019
gets credit for a 12-2 opponent, not for whatever that opponent's record became
by 2026. Doing it the easy way — today's record — is a textbook case of
present-day totals applied backwards, and it would leak in exactly the direction
that flatters the model.

**Sample quality as a feature, not a filter.** `stat_sample_log_diff` carries how
much evidence each corner actually has. When one corner is a debutant, most
features are unavailable, the differences collapse to zero, and the model
produces something close to 50%. That is the desired behaviour: the model reports
its own ignorance in the probability rather than in a footnote, which is why the
calibration in `BACKTEST_v1.md` survives including debut fights rather than being
computed on a flattering subset.

### Missing values

Null on either side of a difference yields zero, and availability is tracked
separately. Under an antisymmetric no-intercept model, zero is precisely "no
evidence either way" — it is not an imputed average, and it is not a claim that
the two corners are equal.

---

## 4. The model

Ridge logistic regression, no intercept, fitted by Newton–Raphson (IRLS) with a
Cholesky solve. Thirty-three features makes the exact second-order method both
affordable and reproducible to the last bit: there is no random initialisation,
no shuffling, and no early-stopping heuristic, so two runs of the same data
produce identical coefficients. `model.test.mjs` asserts it.

Something more expressive — gradient boosting, a neural net — is a reasonable v2
question. It is the wrong v1 answer. With roughly 9,000 labelled bouts, 33
features and a signal this modest, the binding constraint is evidence, not model
capacity, and a model whose coefficients can be printed in a table and argued
with is worth more right now than two extra points of AUC that nobody can
interrogate.

**Scaling is RMS, not z-scoring.** Dividing by a root-mean-square commutes with
negation; subtracting a fitted mean does not, and would break the antisymmetry
the whole design rests on. Features are differences centred on zero by
construction, so RMS is also the correct scale measure rather than a compromise.

**The ridge penalty is chosen, not tuned.** For each fold, the last 20% of the
training window (chronologically, never randomly) is held out, each λ in a fixed
grid is fitted on the remainder, and the λ with the lowest validation log loss is
used to refit on the full training window. The scored year is never consulted.
The grid was fixed before the first result was looked at and has not been
touched since.

---

## 5. Validation

**Chronological walk-forward, expanding window, refit per calendar year, folds
2013 through 2026.**

A random train/test split of fight data is not a hard problem made easy — it is a
different problem. Fighters recur: a random split puts a fighter's 2019 bout in
training and their 2018 bout in test, so the model is told how the career turned
out before being asked to predict its middle. The number that comes back is not
obtainable in production, where the future is genuinely absent.

Every fold trains only on bouts that had already happened and is scored only on
bouts that had not. `model.test.mjs` asserts that the latest training event in
each fold is strictly earlier than the earliest scored event, and that no bout is
scored twice across the whole walk-forward.

Draws, no-contests and ungraded bouts carry no binary label and are excluded from
both training and scoring. They are not silently counted as half a win.

### Benchmarks

- **50/50.** Brier 0.25, log loss ln 2. The floor.
- **Historical win-rate baseline.** Each corner's Laplace-smoothed pre-fight win
  rate, normalised into a probability. No fitting, no coefficients — the number a
  reasonable person would produce with a pen. This is the bar v1 has to clear to
  have earned its complexity, and it is a much harder bar than the coin.
- **Market implied.** Median implied probability across books, proportionally
  de-vigged, from observations recorded strictly before the bout. **Currently
  N=0**: the market ingest began recently and no bout it has priced has yet been
  fought and graded. The comparison is implemented and reports zero rather than
  being estimated from a closing line pulled after the fact, which would be a
  different and much easier problem than the one the model is asked to solve.

### Reporting

Brier and log loss lead, because they are proper scoring rules — only the true
probability minimises them, so a model cannot improve them by being confidently
wrong. Accuracy is reported because people ask for it, but it is not the
headline: a model that says 51% and is right is not the same product as one that
says 80% and is right, and accuracy cannot tell them apart.

Everything is also broken out by confidence band, by division, by evidence
available and by fold, with sample sizes attached, because a pooled number hides
exactly the places where a model is worthless.

---

## 6. What v1 is and is not

**It provides real signal.** Brier 0.2363 against 0.2500 for a coin and 0.2447
for the win-rate baseline; 59.58% accuracy; AUC 0.634; every one of 14 folds
beats the coin. Calibration is close to honest out of the box — ECE 0.0139,
slope 1.035 — with observed hit rates rising monotonically across the confidence
bands from 53.0% to 86.9%.

**The signal is modest, and that is the accurate description.** Roughly a five
percent Brier improvement over a coin. A well-priced closing line typically does
considerably better. v1's claim is that it is an independent, calibrated,
leakage-audited probability that owes the market nothing — not that it beats it.
Whether it does is a question the market comparison will answer once there is
timestamp-compatible data to answer it with, and the answer might be no.

**It is close to blind on debut fights.** With one corner making their promotional
debut (1,518 of 7,047 scored bouts), AUC is 0.559 and Brier 0.2477. There is
almost nothing to read beyond age, reach and stance. The model handles this
correctly by predicting near 50%, but the honest summary is that it has little to
say about those fights, and it is 22% of the card.

**Three coefficients contradict their fight-sense prior**
(`kd_per15_diff`, `pace_retention_diff`, `sub_att_per15_diff` all learned a
negative weight). These are almost certainly collinearity artifacts — a knockdown
rate sitting beside a strike differential and a finish rate has little
independent variance left to explain. They are reported rather than corrected.
Pinning a sign to match intuition would be fitting the report, not the fights.

**Nothing is published.** `status: candidate`. No live prediction has been
locked or written to a database, and migration 011 has not been applied. The
`/model` page shows backtest output labelled as backtest output, and a live
record that says it has not started.

**The model disagrees with the market far more than its skill justifies.** Over
the 31 upcoming bouts that currently carry a price, the median absolute
disagreement is 10.7 percentage points. A model with a 5.5% Brier improvement
over a coin, facing a line that does considerably better, should sit close to
the market and differ occasionally. Differing by double digits on the typical
fight is far more likely to be v1's own error than a discovered edge, and the
generator prints that as a warning rather than as a feature.

---

## 7. Reproducing it

```bash
node scripts/model/extract_dataset.mjs    # read-only pull; GETs only
node scripts/model/build_features.mjs     # as-of assembly + leakage counters
node scripts/model/backtest.mjs           # walk-forward folds
node scripts/model/leakage_audit.mjs      # six independent checks
node scripts/model/train_release.mjs      # release artifact for the web app
node scripts/model/report.mjs             # regenerates BACKTEST_v1.md
node --test scripts/model/model.test.mjs  # unit and invariant tests
```

The extract is ~85 MB; set `PBE_MODEL_CACHE` to keep it off the repo volume.
Nothing in `scripts/model/` writes to the database.

Live pipeline, all dry-run by default and all requiring `--apply` to write:

```bash
node scripts/model/predict_upcoming.mjs               # score upcoming bouts
node scripts/model/publish_predictions.mjs --event X  # lock, behind six gates
node scripts/model/grade_predictions.mjs              # grade from stored results
```

Schema tests run against a throwaway Postgres with 001, 009 and 011 applied:

```bash
psql -d <throwaway> -v ON_ERROR_STOP=1 -f migrations/tests/011_ufc_model_predictions.test.sql
```

---

## 8. Next, in order of expected value

1. **Add `ufc_events.event_start_at`.** The lock window is currently a full day
   earlier than it needs to be, because there is no trustworthy bout start time
   to close it against. See `docs/model/LIVE_CONTRACT.md`.
2. **Let the market comparison populate.** It is the only benchmark that tells us
   whether v1 is worth publishing against a line rather than merely worth
   publishing. Until then the question is open.
3. **Stance as-of history** in the Fight DNA layer, closing the one documented
   approximation in section 1.
4. **Opponent-adjusted metric quality, not just win rate.** Strength of schedule
   currently uses the opponent's record; using their as-of DNA metrics is
   defensible and better, and the snapshots already support it.
5. **Bout-context interactions** — five-round bouts, short notice, layoff-by-age —
   as antisymmetric interaction terms rather than symmetric main effects.
6. **Method and round distributions**, which is where prop pricing actually
   lives; a win probability is the least interesting thing a fight model can say.
