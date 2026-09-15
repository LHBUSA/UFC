# PBE Algo: daily learning and controlled promotion

Status: **APPROVED 2026-09-15 and IMPLEMENTED** (migration 027 applied; `ufc-algo` learning code in `workers/ufc-algo/src/learning/`). `ALGO_MODE` stays `dry_run`; shadow writes, like every official write, happen only when armed. Implementation notes are in section 12.

Author context: written during the 2026-09-14 pre-launch forensic pass, when `pbe-fight-model-v1` was unregistered, `ufc-algo` was in `dry_run`, and no prediction was locked.

## 1. Three processes, kept apart

| Process | Question it answers | Cadence | Writes | Can change a model? |
|---|---|---|---|---|
| **Live regeneration** (exists: `ufc-algo` cycle) | What does the *champion* say about upcoming bouts, given today's pre-fight data? | hourly `:41` | evaluations, champion drafts, locks, grades | No |
| **Model learning** (new) | Given every result verified before the cutoff, what coefficients does the same recipe produce? | daily | one training run (+ R2 artifacts); at most one challenger | No: it creates a *challenger*, never a champion |
| **Model promotion** (new) | Has a challenger earned production, on prospective evidence? | weekly review, **owner decides** | a review row; on owner approval, a new immutable version | Only through the owner-approved promote action |

A newer model is never better simply because it is newer. Coefficients reach production only through promotion.

## 2. Where it runs (Cloudflare-native)

Everything lives in the existing `ufc-algo` Worker. There is no GitHub Actions scheduler and no new Worker. The account already has R2 and Workflows (`nfl-replay-ingest` runs on them).

- **Cron `41 * * * *`** (unchanged): live regeneration, plus shadow scoring for the single active challenger (section 6).
- **Cron `17 12 * * *`** (new): starts the `LearnDaily` Workflow. The time is chosen after `ufc-stats-ingest`'s daily maintenance window, which ran at about 11:00–11:20Z on 2026-09-14.
- **Cron `23 13 * * 1`** (new): the weekly `PromotionReview`.
- **R2 bucket `ufc-algo-artifacts`** (new): datasets, walk-forward predictions and audit evidence, addressed by SHA-256.
- **Workflow steps**, each durable and retried independently:
  - `gate`
  - `extract_increment`
  - `assemble`
  - `hash`
  - `train`
  - `walk_forward`
  - `audit`
  - `compare`
  - `store`

**Measured feasibility.** On the fresh 2026-09-14 dataset (9,192 graded rows × 33 features), the full 14-fold walk-forward, including the λ grid, took **4 s** in Node. Training fits easily inside a Workflow step's CPU budget.

The expensive part is the dataset. The raw snapshot extract is about 49 MB of JSON, which is too large to hold in one Worker isolate. The design below therefore avoids a full in-isolate extract on the daily path.

## 3. Daily learning (`LearnDaily`)

### 3.1 Gate: learn only from finished, verified data

The Workflow proceeds only if all of these hold:

1. **Results are final.** Every bout from events dated before `cutoff = today 00:00Z` has a stored result, or has been cancelled or replaced.
2. **The run has a reason.** At least one such bout was graded after the parent run's cutoff.
3. **Derived data is current.** `ufc-stats-ingest` has a successful run that finished after the latest such event. `ufc_fighter_dna_snapshots` has `as_of_date >= latest event date` for every fighter in the newly graded bouts. `ufc_fighter_bout_features` contains those bouts.
4. **Predictions are graded.** The champion's locked predictions on those bouts are graded, using the existing `gradeLocked`.

If conditions 1, 3 or 4 fail, the run is recorded as `WAITING_FOR_DATA` with the failing condition and retried on the next day.

If condition 2 fails, the run is recorded as **`NO_NEW_TRAINING_DATA`**. No challenger and no artifact are created.

**Never used as training data:**
- upcoming or unresolved bouts;
- bouts whose event date is on or after the cutoff;
- any row whose features were assembled with data dated on or after its own event (the existing leakage audit enforces this).

### 3.2 Dataset: incremental daily, full weekly

**Daily (incremental).**
- Append one row per newly graded bout, built with `assembleBoutRow`: the exact targeted assembly the scheduler already uses, proven byte-identical to the batch builder (807/807 parity).
- Prior rows are read from the parent dataset in R2.
- This is sound because a historical row depends only on data from before its own event.

**Weekly (full rebuild).**
- The Sunday `LearnDaily` run rebuilds every row, sharded by event year across Workflow steps, and hashes the result.
- If the rebuilt dataset differs from the incremental one, the run records **`DATA_REPAIR_DRIFT`** with the affected bout IDs. That run's challenger is then trained on the full rebuild.
- This is necessary because the database is repaired over time. Today's audit found the v1 release window at 9,174 rows versus 9,175 at release, with λ selected as 5 versus 2. A dataset that is never re-derived drifts silently.

**Dataset hash.**
- `dataset_sha256` is SHA-256 over newline-joined `JSON.stringify([bout_id, event_date, label, x, available])`, ordered by `(event_date, bout_id)`.
- The dataset itself is stored in R2 under its hash. Anyone can re-train from it.

### 3.3 Train, validate, audit

1. **Train.** Same recipe as v1: ridge logistic, 33 antisymmetric features, no intercept, canonical corner by UUID, λ chosen on an inner chronological 20% split. The expanding window is the default. **No recency weighting.** A decay or rolling-window model would be a separate model family (section 9).
2. **Walk-forward.** Chronological, refit per calendar year, pooled out-of-sample metrics:
   - Brier, log loss, accuracy, AUC
   - ECE and calibration slope
   - by confidence band
   - by sample quality (minimum prior bouts 1, 2, 3–5, 6+)
   - the high-confidence tail (≥ 80%)
3. **Leakage audit.** The existing checks: target in snapshot, future bout in snapshot, snapshot dated after the event, banned columns. **Any failure makes the run `FAILED_AUDIT`, and such a run can never be promoted.**
4. **Comparison with the champion.** The champion is re-scored on the same dataset, and both are compared on:
   - all pooled metrics;
   - coefficient drift: per-feature Δβ, sign flips, and the L2 norm of Δβ;
   - prediction drift on the **fixed benchmark set**: the v1 release's 2024-01-01 → 2026-09-05 out-of-sample rows, frozen in R2 under its own hash, reporting max and mean |Δp| and flipped picks;
   - prediction drift on the current upcoming card.

### 3.4 Provenance: every run is immutable

`ufc_model_training_runs` (migration 027, append-only, service-role only) holds one row per run:

- **Identity:** `training_run_id`, `parent_model_version` (the champion at run time), `parent_run_id`.
- **Status:** `NO_NEW_TRAINING_DATA`, `WAITING_FOR_DATA`, `FAILED_AUDIT`, `DATA_REPAIR_DRIFT`, `CHALLENGER` or `SUPERSEDED`.
- **Window:** `training_cutoff_at`, `training_window_start`, `training_window_end`, `training_bouts`, `newly_graded_bouts`.
- **Dataset and code:** `dataset_sha256`, `dataset_uri`, `feature_version`, `eligibility_version`, `code_sha`, `worker_version`.
- **Model:** `coefficients`, `feature_scale`, `hyperparameters` (λ, λ scan), `spec_sha256`. The spec hash uses the same canonical serialisation as `ufc_model_versions` and the scheduler.
- **Evidence:** `leakage_audit`, `walk_forward`, `calibration`, `sample_quality`, `coefficient_drift`, `benchmark_drift`, `upcoming_drift`.
- **Time:** `generated_at`.

**Idempotency.** There is a unique index on `(parent_model_version, dataset_sha256, code_sha)`. Re-running the same day with the same data and code returns the existing row. Two parallel runs cannot produce divergent artifacts, because the spec is a pure function of the dataset and code; determinism was verified today, with the same rows twice giving the same `spec_sha256`.

**Never overwritten.** A challenger is not a `ufc_model_versions` row. `pbe-fight-model-v1` is never touched.

## 4. Versioning

- A challenger's identity is its `training_run_id` and `spec_sha256`. It carries no public name.
- **Promotion** registers a new immutable `ufc_model_versions` row. The version scheme is `pbe-fight-model-v<major>.<minor>`:
  - **minor** (`v1.1`, `v1.2`, …): same recipe, `feature_version` and eligibility contract; new coefficients from more data.
  - **major** (`v2`): any change to features, recipe, eligibility contract or model family.
- The version row stores `parent_model_version` and `training_run_id` in `hyperparameters.provenance` and `notes`. It stays immutable under the existing 011 trigger.
- Locked predictions keep their foreign key to the version that made them, and `ufc_model_versions` rows are never deleted. The official record therefore always resolves through the historical version, including after that version is retired.

## 5. Champion and challenger

- **Exactly one live champion.** Migration 027 adds a partial unique index on `ufc_model_versions (model_family) WHERE status = 'live'`. Promotion is one DB function, `ufc_model_promote(p_review_id)`, that in a single transaction:
  - verifies the review is `APPROVED`;
  - inserts the new version as `live`;
  - sets the previous champion to `retired`.
- **At most one active challenger.** It is the latest `CHALLENGER` run that passed audit. A newer passing run marks the previous one `SUPERSEDED`, but that run's shadow record is kept.
- **Scope of a promotion.** It affects only future *unlocked* evaluations. On its next cycle the scheduler resolves the new champion, withdraws the old version's unlocked drafts (the existing delete, `locked_at IS NULL`) and drafts under the new version. The database already refuses any change to a locked row.

## 6. Shadow predictions

The prospective evidence the owner asked for comes from a shadow track.

- `ufc_model_shadow_predictions` (027), one row per (challenger run, bout):
  - challenger probability and pick;
  - eligibility decision and reasons, from the same eligibility module;
  - `generated_at` and `market_snapshot` (observation time included, see section 10);
  - `spec_sha256`;
  - `locked_at`, stamped by a separate DB function `ufc_model_lock_shadow` in the same lock window as the champion.
- `ufc_model_shadow_grades` (027): append-only, the same grade semantics as the official grades, using the same result binding and VOID rules.
- **Never public.** No public view, no RLS read policy, not exposed by the API or Pro pages. It is never joined into `ufc_model_live_record` and never alters the official record.
- **Paired comparison.** Every shadow lock has a champion lock on the same bout when both are eligible, so champion and challenger are compared on identical bouts.

## 7. Weekly promotion review (deterministic, owner decides)

`PromotionReview` runs every Monday and writes one `ufc_model_promotion_reviews` row: champion, challenger, every criterion with its value and pass or fail, the verdict and the reasons. The initial contract is below; each threshold is a named constant, and changing any of them is itself a versioned contract change.

| Criterion | Rule | Evidence |
|---|---|---|
| Leakage audit | must pass | run audit |
| Feature/data integrity | no `DATA_REPAIR_DRIFT` left unresolved; the dataset re-hashes | R2 plus hash |
| Brier (walk-forward) | challenger − champion ≤ **+0.002** | walk-forward |
| Log loss (walk-forward) | challenger − champion ≤ **+0.005** | walk-forward |
| Calibration | ECE ≤ champion + **0.010**; slope within **[0.85, 1.15]** | walk-forward |
| High-confidence tail | pick-rate ≥ 80%: observed − mean predicted ≥ **−0.05**, or fewer than 50 rows (reported as insufficient) | walk-forward |
| Sample-quality slices | no slice with n ≥ 300 regresses on Brier by more than +0.005 | walk-forward |
| Coefficient stability | max \|Δβ\| ≤ **0.05**; no sign flip on any feature with \|β\| ≥ 0.02 | drift |
| Benchmark stability | mean \|Δp\| ≤ **1.0** pt, max ≤ **5** pts, or improvement shown on the same rows | benchmark |
| **Prospective evidence** | **≥ 50** paired graded shadow bouts, **and** paired shadow Brier ≤ champion Brier on those bouts | shadow grades |

**Verdicts:**
- **`REJECT`**: any hard rule fails (leakage, integrity, material regression). The challenger stays shadow-only.
- **`HOLD`**: nothing fails, but prospective evidence is insufficient. This is the expected state for the first 4–6 weeks of any challenger.
- **`PROPOSE`**: every rule passes. The owner is notified, and the promote action becomes available.

**Owner approval.** Promotion requires `POST /admin/promote` with the review ID and the owner token. There is no ownerless promotion. Whether to allow automatic promotion is a later, separate decision, made once the review history exists.

**Market criteria** (closing-line value, de-vigged model-vs-market Brier, ROI) are added to the table only when timestamp-compatible odds at lock *and* at close are stored for graded bouts. Until then they are reported as "not yet observable", never estimated.

## 8. Internal learning report

`GET /admin/learning` on `ufc-algo` (token) returns the data. An owner-only `/algo/admin/learning` page renders it later. It shows:
- the champion → latest challenger;
- last learned, newly graded bouts, total training bouts;
- coefficients changed, the largest moves, and sign flips;
- validation and calibration deltas;
- the shadow record: paired n, W-L, Brier and log loss against the champion;
- promotion status and the exact reason from the latest review.

**Public claim** once live: "PBE Algo retrains continuously as new verified UFC results enter the dataset. Production models are versioned and promoted only after validation." PropBetEdge does not claim it "gets smarter every day" unless shadow evidence shows improvement.

## 9. Not overlearning

- The default is the expanding window, and the daily learning run uses the same recipe.
- Twelve fights from one night are 0.13% of the training set. They move coefficients negligibly by construction, and the stability criteria catch anything that moves more.
- Recency weighting, exponential decay and rolling windows are **separate challenger families**. Each gets its own `model_family`, its own shadow track and the same promotion contract, and must show *temporal* evidence of improvement before it can replace the expanding-window family.

## 10. Prerequisites the forensic pass found

1. **The market data is one stale snapshot.** `ufc_market_observations` has exactly one h2h snapshot, taken 2026-09-08T12:25Z, and no scheduled refresh. The scheduler now records the true price time (commit a52c124). Any market or CLV criterion needs a scheduled, quota-safe odds capture before lock and at close, which requires an owner decision on odds API quota.
2. **The v1 training dataset is not reproducible.** The v1 artifact predates dataset hashing. Its training dataset cannot be re-derived from today's database (row count and λ differ). Its coefficients are still fully verifiable (the spec hash re-verifies), and re-fitting today moves the upcoming UFC 331 and 26 Sep predictions by at most 0.54 pts. The registration notes will record this; section 3.2 prevents it from recurring.
3. **Fighter records are not model features.** `ufc_fighters.record_*` does not feed features; the features use DNA snapshot provenance and the bout ladder. The stale-record fix in `ufc-stats-ingest` therefore cannot leak into training, but training still requires the DNA snapshots to be current (gate 3).

## 11. Tests that must exist before any of this deploys

| Property | Test |
|---|---|
| Today's result cannot affect yesterday's locked prediction | DB test: a grade or re-train after lock leaves the locked row byte-identical (existing trigger) and the scheduler never PATCHes `locked_at IS NOT NULL` |
| A challenger cannot rewrite champion predictions | shadow writes only reach shadow tables (grant test plus a static import-graph test) |
| The training cutoff prevents future leakage | a fixture with a bout on the cutoff date and one after: neither enters the dataset; the leakage audit fails on an injected future snapshot |
| Identical dataset → identical model/spec | train twice from the same R2 dataset → identical `spec_sha256` (verified manually on 2026-09-14) |
| A duplicate daily run creates no divergent artifact | a second run with the same parent, dataset and code → the unique index returns the existing run |
| No new fights → no fake learning event | gate test → `NO_NEW_TRAINING_DATA`, no challenger, no R2 write |
| A failed leakage audit prevents promotion | review test: `FAILED_AUDIT` → `REJECT`; `ufc_model_promote` refuses |
| A worse challenger stays shadow only | review test with a Brier regression → `REJECT`/`HOLD`; promote refuses |
| A newly promoted champion affects only future unlocked evaluations | cycle test: locked v1 rows untouched, unlocked v1 drafts withdrawn, v1.1 drafts created |
| The prior official record resolves through its historical version | view test: after promotion, the v1 locked row still joins its retired, immutable `ufc_model_versions` row |

## 12. Implementation notes (2026-09-15)

| Design element | Where | Notes |
|---|---|---|
| Champion resolution | `src/champion.js` `resolveChampion` | the single `live` row of `pbe-fight-model`, re-hashed every cycle; two live rows block |
| Gate | `learning/daily.js` `gateStep`, `core.decideGate` | new = graded bouts after the champion window and before today that the parent dataset lacks |
| Genesis dataset | R2 `model-releases/pbe-fight-model-v1/genesis-dataset-b466d86b….jsonl` + manifest (locked prefix) | the 9,174-row release-window rebuild; **not** V1's original dataset, which cannot be regenerated |
| Increment assembly | `learning/assemble.js` `assembleEvents` | batched reads into `assembleBoutRow`; verified 18/18 byte-identical to the Node builder on 2026-09-15 |
| Weekly rebuild | Sunday `LearnDaily`: `rebuild_plan` → `rebuild_shard_N` (12 events each) → `rebuild_compare` | skipped while the gate is `WAITING_FOR_DATA`; drift → `DATA_REPAIR_DRIFT` run trained on the rebuild |
| Train / audit / drift | `core.trainChallenger`, `core.leakageAudit`, `daily.trainStep` | same `walkforward_core` as V1; baseline = same recipe on the champion's dataset (cached in R2); benchmark = champion dataset rows ≥ 2024-01-01 |
| Challenger spec hash | `specCanonical` under the fixed label `pbe-fight-model-challenger` | depends only on coefficients, scale, λ; promotion re-hashes under the new version name |
| Shadow | `learning/shadow.js`, wired into `cycle.js` | armed only; never reads or writes `ufc_model_predictions` (import-graph test) |
| Review | `learning/review.js` `runReview`, cron `23 13 * * 1` | thresholds in `core.REVIEW_THRESHOLDS` (`pbe-algo-review-v1`) |
| Owner decision | `POST /admin/promote`, `OWNER_PROMOTE_TOKEN` (distinct from the admin token) | calls `ufc_model_promote()`; nothing else can create a version |
| Cross-version safety | `cycle.js` | a locked call of any version blocks drafting; unlocked drafts of a non-champion version are withdrawn |

**Before any promotion is approved:** the web read path (`web/lib/algo.ts`) still resolves calls and drivers through the V1 artifact. It must resolve each prediction through its own `model_version` row before a second version can be live. This does not affect V1 operation.
