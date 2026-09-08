# PBE Fight Model v1 — leakage proof

A fight model that has quietly read the result is easy to build, scores
beautifully, and is worth nothing. This document is the argument that this one
has not, and the argument is made in tests rather than in prose.

Run it:

```bash
node scripts/model/build_features.mjs    # emits the per-bout audit counters
node scripts/model/leakage_audit.mjs     # six independent checks; exits non-zero on any failure
node --test scripts/model/model.test.mjs # invariants, including synthetic leakage traps
```

Latest build: **all six checks passed.**

---

## The rule

> A bout on date **D** may only see facts whose own date is strictly before **D**.

Everything below is a different way of testing that one sentence.

---

## What "leakage" means here, item by item

The brief named five specific failure modes. Each maps to a mechanism and a test.

### 1. No future bout outcomes

Two mechanisms.

**The as-of snapshot.** The repaired Fight DNA build writes one snapshot per
fighter dated the day *after* each of their bouts, containing only bouts with
`event_date < as_of_date`. Feature assembly selects the latest snapshot with
`as_of_date <= event_date`. Because a fighter's snapshots are dated
`previous_fight + 1`, the selected one contains bouts up to and including their
previous fight and nothing after it.

**The date-blocked ladder.** Everything computed from the per-bout DNA rows —
recent form, layoff, takedown defence, strength of schedule — is built by walking
history in strict date order and updating state **in date blocks**: every bout on
a given date is featurised from the state as it stood *before* that date, and
only then does that date's results enter the ladder. Without the block, two
fighters on the same card could see each other's result from that card.
`model.test.mjs` builds exactly that trap synthetically and asserts the second
fighter's ladder is still empty.

### 2. No present-day career totals applied backward

`ufc_fighters` carries `record_w`, `record_l`, `record_d`, `record_nc`,
`is_active`, `fight_history_count`, `career_slpm`, `career_str_acc`,
`career_sapm`, `career_str_def`, `career_td_avg`, `career_td_acc`,
`career_td_def` and `career_sub_avg`. Every one of them describes the fighter as
they are **today**.

They are not filtered out downstream — they are **never selected**. The
extractor's `select` list is `id, name, dob, height_in, reach_in, stance`. The
audit reads the cached extract back and asserts that no banned column is present
in it, so the pipeline could not use one even by mistake.

The same discipline covers opponent adjustment: strength of schedule uses each
opponent's win rate *as it stood on the date they were fought*, reconstructed
from the chronological ladder, not their record today.

### 3. No post-fight stats

`ufc_bout_round_stats` for the bout under prediction is never read. Round stats
enter only through Fight DNA snapshots and per-bout DNA rows dated strictly
earlier. The audit greps the feature-building functions themselves for
`results.get`, `winner_id`, `price` and `implied` and asserts none appears —
results enter the pipeline downstream of the vector, as the label.

### 4. No future rankings

`ufc_rankings` is not in the extractor's table list at all. No ranking, current
or historical, is a feature in v1. A rankings snapshot is published weekly and
reflects results already known; using one as of a fight date is defensible but
needs a snapshot-history guarantee this model does not yet lean on.

### 5. No odds movement after the prediction timestamp

Odds are not a model input in any form. Where the market appears — the
comparison, and only the comparison — only observations with
`observed_at <= cutoff` count, where the cutoff defaults to midnight UTC on the
event date. `model.test.mjs` asserts an observation recorded after the cutoff is
rejected.

---

## The six checks

### 1. Source allowlist — PASS

Asserts no banned `ufc_fighters` column appears in the cached extract, and that
no result or price symbol appears inside the functions that produce features.

Columns actually extracted from `ufc_fighters`: `dob`, `height_in`, `id`,
`name`, `reach_in`, `stance`.

### 2. Snapshot provenance — PASS

Every Fight DNA snapshot selected for every bout is checked against its own
`provenance.bouts` list:

| Assertion | Violations |
|---|---|
| Snapshot dated after the event it was used for | **0** |
| Bout under prediction found inside its own snapshot | **0** |
| A bout dated on or after the event found inside the snapshot | **0** |

Across every snapshot selected for every one of 9,421 bouts, the closest bout
inside any of them was **4 days before** the event it was used to predict.
Strictly positive is the proof: nothing same-day, nothing later.

**Independent cross-check:** the chronological ladder is built from a different
table by different code than the snapshot builder. Comparing the ladder's running
appearance count against the `record` embedded in each selected snapshot, at
every point in time: **0 mismatches in 15,610 comparisons.** Two independent
reconstructions of "what had happened by this date" agree exactly.

### 3. Truncation — PASS

The decisive test, because it does not trust any of the reasoning above.

For 250 randomly sampled bouts (deterministic seed), **every row in the dataset
dated on or after that bout is deleted** — other bouts, their results, their DNA
feature rows, and every snapshot generated after it — and the bout's feature
vector is rebuilt from what remains.

If any future fact were reaching the vector by any route, the truncated vector
would differ.

**250 bouts rebuilt. 0 feature vectors changed.**

### 4. Permutation — PASS

Train on data through 2023, score 2024 onward. Then shuffle the training labels
and refit. A pipeline that has smuggled the answer in through a feature keeps
performing; one that has not collapses to the coin.

| | Brier skill vs coin |
|---|--:|
| Real labels | **8.33%** |
| Shuffled labels | **0.13%** |

### 5. Antisymmetry — PASS

Swapping the corners returns exactly the complementary probability; maximum
observed error 1.1e-16, which is floating-point noise.

This matters more than it sounds. **In this database the fighter listed first
wins 93.5% of completed bouts**, because the UFCStats ingest lists the winner
first. A model with an intercept would learn that artifact and report ~93%
accuracy while knowing nothing. Antisymmetric features plus no intercept make it
structurally unlearnable, and the canonical orientation (sort the two fighter
UUIDs, which are random and outcome-independent) restores a 50.45% base rate.

### 6. Fold boundaries — PASS

In each of the 14 walk-forward folds, the latest training event is strictly
earlier than the earliest scored event. `model.test.mjs` additionally asserts
that no bout is scored more than once across the whole walk-forward.

---

## What is *not* claimed

Three honest caveats. None of them is a hidden assumption; all three are stated
so a reader can weigh them.

**Stance is a present-day field.** `ufc_fighters.stance` describes a fighter's
stance now, so a fighter who switched mid-career is described by their final
stance throughout. It is a style label rather than an outcome accumulator, it
changes rarely, and it feeds exactly one feature (`southpaw_edge`). A proper fix
is a stance-as-of history in the Fight DNA layer.

**Date of birth, height and reach are also read from the current profile.** They
are physical constants that do not change with a result, so this is not leakage —
but if a source ever *corrects* a reach figure after a fight, the corrected value
would apply retroactively. The effect is small and the direction is unpredictable
rather than flattering.

**Market timestamps are day-resolution.** No bout row currently carries a precise
start time, so the market cutoff is midnight UTC on the event date. A price
observed on fight day but after the bout started would slip in. This affects the
comparison only, never the model, and today it affects nothing at all: **no
completed bout in this database has a market observation, so N=0.**

---

## Files

| File | Role |
|---|---|
| `scripts/model/feature_spec.mjs` | the feature contract, the banned-column list |
| `scripts/model/extract_dataset.mjs` | the column allowlist; GETs only |
| `scripts/model/build_features.mjs` | as-of selection, date-blocked ladder, per-bout audit counters |
| `scripts/model/leakage_audit.mjs` | the six checks |
| `scripts/model/model.test.mjs` | invariants and synthetic leakage traps |
