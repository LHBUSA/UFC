# PBE Fight Model — the live record contract

What has to be true for a published pick to mean anything, and where each of
those things is enforced.

Schema: `migrations/011_ufc_model_predictions.sql`
Tests: `migrations/tests/011_ufc_model_predictions.test.sql` (56 assertions)
Commands: `scripts/model/{predict_upcoming,publish_predictions,grade_predictions}.mjs`

Status: **migration not applied, nothing published, no prediction row exists.**

---

## 1. The claim

> This pick was written down before the fight, and has not been touched since.

Everything below exists because that sentence is worthless if the system that
makes it can also fabricate it.

---

## 2. A lock is a database event, not a caller's assertion

The first version of this schema accepted `locked_at` from whoever wrote the
row and only rejected values at or after `event_date + 1 day`. Two forgeries got
through:

- **Same-day late lock.** A card on the 19th has bouts finishing at 21:00. A
  `locked_at` of 23:00 on the 19th passed the check, three hours after the
  result was known.
- **Post-event backdating.** A row inserted a month later carrying
  `locked_at = event_date - 1 day` passed unexamined, because the check only
  looked at the value, and the value was a lie.

Both are now impossible, and not because the code is more careful — because the
caller no longer supplies the timestamp at all.

| Rule | Where |
|---|---|
| `locked_at` cannot be set on INSERT, in any form | write-gate trigger |
| The only way to lock is the NULL → value transition on UPDATE | write-gate trigger |
| On that transition the supplied value is **discarded** and replaced with `clock_timestamp()` | write-gate trigger |
| The transition additionally requires the publishing guard, set only by `ufc_model_publish_prediction()` | write-gate trigger |
| `created_at` is stamped by the server on insert and can never be changed | write-gate trigger |
| `generated_at` may not be in the future | write-gate trigger |

The guard makes the function the front door. The overwrite is what makes the
guarantee hold anyway: a caller who sets `pbe.model_publishing` by hand still
gets a server-stamped time. That case is tested explicitly — a spoofed
`locked_at` of `2001-01-01` comes back as the transaction's own clock.

### The cutoff, and why it is a day early

`ufc_events` has `event_date` and no start timestamp. Without one, no cutoff
inside the event's own day can be proven pre-fight, so the window closes at
**`event_date 00:00:00 UTC`** — before the event's UTC date begins at all.

That is conservative by up to a full day, deliberately. No UFC card in any
timezone has started before its own event date begins in UTC, so a lock that
clears this cutoff cannot be post-fight. The cost is that a genuine same-day
publication is refused. Refusing a real pick is recoverable; accepting a forged
one is not.

`ufc_model_lock_cutoff(bout_id)` is the single function to change when
`event_start_at` exists. Nothing else needs to move.

---

## 3. The prediction is permanent. The grade is not.

The first version made the first result unrevisable forever, which is wrong for
this sport. Results get overturned on appeal, reclassified as no-contests after
a failed test, and corrected when a commission mis-records them. A schema that
cannot represent that forces someone to publish a knowingly wrong record or
break the immutability guarantee to fix it — and they will choose the second.

So the two are separated completely.

**`ufc_model_predictions`** carries no result at all. Once locked there is **no
permitted UPDATE to it, ever** — not the probability, not the pick, not the
versions, not the feature vector, not the market comparison, not `record_class`.
A locked row cannot be deleted either.

**`ufc_model_prediction_grades`** is append-only. No UPDATE, no DELETE, at any
time, for any row.

| Rule | Where |
|---|---|
| `revision` is assigned by the database, starting at 1 | grades trigger |
| `supersedes_grade_id` is assigned by the database to the previous current grade | grades trigger |
| `graded_at` is the server clock | grades trigger |
| Revision 2 and later must carry a `revision_reason` | trigger + CHECK |
| A grade requires the prediction to be locked | grades trigger |
| A grade requires a stored bout result, or a cancelled bout | grades trigger |
| `VOID` is refused when a result exists | grades trigger |
| WIN/LOSS must name the correct winner for the pick | grades trigger |
| WIN/LOSS name a winner; DRAW/NC/VOID do not | CHECK |

`ufc_model_prediction_current_grade` is the highest revision per prediction, and
it is what every reporting view reads. `ufc_model_live_record` additionally
exposes `revised_grades`, so the tracker can say how many results have been
corrected rather than silently restating them.

Proven end to end in the schema tests: WIN → overturned to NC → vacated back to
WIN → NC again, four revisions, each superseding the last, the record following
each one, all four readable, and the prediction's probability and pick unchanged
throughout.

---

## 4. The three commands

All default to a dry run. All require `--apply` to write. A dry run builds the
exact rows it would send and stops before the request, rather than taking a
shorter path and printing an optimistic summary.

### `predict_upcoming.mjs` — generate

Scores upcoming bouts from the cached extract using the same feature builder,
the same as-of Fight DNA snapshots and the same leakage audit that produced the
walk-forward backtest. A live prediction assembled by a second, subtly different
code path would inherit none of that evidence.

`--apply` inserts **unlocked drafts**. A draft is not a pick: every reporting
view excludes it, and it can still be revised or deleted.

It also prints how far the model is from the market where both exist, as a
warning. Given v1's measured skill — about 5.5% Brier improvement over a coin,
where a closing line does considerably better — a double-digit disagreement on
the typical priced fight is far more likely to be model error than an
opportunity. The current run shows a **median 10.7-point disagreement**, which
is a reason to treat the edge column as a diagnostic rather than a signal.

### `publish_predictions.mjs` — lock

Six gates, all of which must pass:

1. `--apply` is required.
2. A scope must be named: `--event` or `--bout`. There is no "publish
   everything", by design.
3. The model version must be registered, **live**, and its `spec_sha256` must
   match the artifact on disk. Publishing picks from coefficients that differ
   from the registered ones would make the stored `model_version` a lie, and
   both halves would look fine on their own.
4. The extract must be fresh (default 12h). Stale features are the quiet
   failure: a fighter who fought last weekend would otherwise be scored on the
   snapshot from before that bout.
5. The stored draft must still match what current data produces — no pick flip,
   and no probability drift beyond `--max-drift-pts` (default 0.5).
6. The lock window must be open with `--min-lead-hours` of margin (default 6).
   The database enforces its own floor regardless.

The command never sends a timestamp. It calls
`ufc_model_publish_prediction(id, min_lead)` and the database stamps the clock.

### `grade_predictions.mjs` — grade

Reads `ufc_bout_results` and nothing else, so a grade can never be influenced by
what was predicted. Appends a first grade where none exists; where the stored
result disagrees with the grade in force, appends a **revision** whose reason is
generated from the observed difference rather than typed by whoever ran the
command. Never edits or deletes.

---

## 5. What the public page may say

The tracker shows the live record and, separately, the backtest. It never sums
them and there is no view that reads both.

The empty state says the live programme has not begun. It does **not** say which
migration has or has not been applied: that is an operational fact about a
deployment, indistinguishable to a reader from "the model has not started", and
the second is the sentence that actually means something. The detail goes to the
server log. A test asserts the public string contains no deployment vocabulary.

No invented number appears anywhere on the page. The card's populated market row
has no real example yet — no completed bout in the database carries a price
recorded before it started — so the example lives in `web/lib/model.fixtures.mjs`
and is reachable only from the test runner.

---

## 6. What is still open

- **`ufc_events.event_start_at`.** The one change that lets the lock window
  relax from "before the event's UTC day" to "before the bout", safely.
- **Registering the model version.** `ufc_model_versions` is empty. Publishing
  requires a row there with `status = 'live'` and a matching spec hash, and
  creating it is a deliberate decision, not a deployment step.
- **The market comparison.** Still N=0 over completed bouts. Until it populates,
  whether v1 is worth publishing *against a line* is an open question, and the
  10.7-point median disagreement above is the reason to ask it seriously.
