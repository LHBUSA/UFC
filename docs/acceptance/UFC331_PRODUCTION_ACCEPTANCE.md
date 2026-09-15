# UFC 331 production acceptance: PBE Algo V1 + Road to UFC

Status: **four scheduled acceptance gates, defined by the owner 2026-09-15.**

This document exists so any session can run the identical gates if the session-only timers that were set for them disappear. It schedules nothing and changes nothing.

## Freeze

PBE Algo V1 is armed and frozen (owner, 2026-09-15). The Road to UFC ingestion contract is frozen too.

Nothing below may change unless a scheduled gate reveals a real defect:
- `pbe-fight-model-v1`, its coefficients and the model artifact
- thresholds and eligibility rules
- feature definitions
- `model_scope`
- learning and promotion rules
- market freshness rules
- lock timing, grading behaviour and public performance copy

Rules for every gate:
- Gates are **read-only receipts**.
- Patch nothing during an acceptance run.
- The only permitted production action is Gate 3's rollback, and only if an official invariant fails.
- Main only, existing Cloudflare deploy mechanisms only, no GitHub Actions and no other scheduler.

**Road to UFC contract (frozen):**
- Road to UFC belongs to historical UFC data completeness.
- New Road to UFC bouts stay outside V1 model scope (`ufc_bouts.model_scope = false`).
- Existing V1 rows stay in scope exactly as trained.
- ESPN identity may attach to richer legacy truth but never overwrite it.
- Matched fighters only fill previously missing fields.
- No display-name identity joins and no guessed cards. ESPN does not list Shanghai Episodes 2 and 3 (May 2025), so they stay absent until an authoritative source exists.

**Explicit missing data (do not infer or fabricate).** Two legacy Road to UFC 4.6 results lost their `referee`, `time_format` and `finish_detail` during the first ESPN link on 2026-09-15:
- bout `d336e532-a1f7-48bb-99ac-bcfb61468a85`
- bout `fff60ed9-0a94-4ec0-b766-9821d3f4fd98`

UFC Stats, their source, is blocked. The provenance is in commit `949f94b`.

## Frozen identifiers

| Item | Value |
|---|---|
| Champion | `pbe-fight-model-v1` / `pbe-fight-features-v1`, eligibility `pbe-algo-eligibility-v1.1` |
| spec_sha256 | `75da0a1de14de2e186dea784dcbcfdbd140f592b3719b34bc11988cb52b7155f` |
| Full registry row sha256 (JSON of the PostgREST `select=*` row) | `c040ffbf1f822f07fcadfe1973b119d36d8703e310b8082164c6f536ea884a7b` |
| Artifact / manifest sha256 (R2 `ufc-algo-artifacts/model-releases/pbe-fight-model-v1/`) | `69d8bdf93a5a187812c03f58f4b6c88483241e382685977f3ddf3c2fc1c70c06` / `b592c0847dd4281350aa6b8af15a346cb6129edec448a48ec4a9a1837f633e69` |
| Active challenger (shadow only) | training run `e250a579-2bf4-4915-9b87-c16d2256bfe0`, dataset `c4c4ef78…`; review `42d7d891` = HOLD |
| Training dataset rebuild hash (must stay until new graded in-scope bouts) | `c4c4ef789ee3e70d5a7e06b3d8ec856b1a8dc3b94c9f03c685e95613781472b1`, 9,192 rows |
| UFC 331 | event `221ca353-f623-4b66-98aa-3a504a418236`, `event_date` 2026-09-19 |
| Lock window (DB clock) | opens 2026-09-18 16:00Z, closes 18:00Z; armed passes at **16:41Z** and **17:41Z** |
| First armed run | `a689617a-adef-4844-ba4d-a8ba9a3c178e` (2026-09-15 10:41Z): 29 evaluations, 19 drafts, 10 no-calls, 0 locks, 0 violations |

## Rollback references

| Worker | Live at freeze | Rollback |
|---|---|---|
| ufc-algo | `64263014` (armed, model_scope filter) | dry run: set `ALGO_MODE = "dry_run"` in `workers/ufc-algo/wrangler.toml`, commit and push main, then `npx wrangler deploy --var CODE_SHA:<commit>`. Known dry-run version: `d3a0c899`. Previous armed: `0ffe777d`. |
| ufc-intelligence (Fight DNA) | `d1072095` | `3a7228b2` |
| ufc-stats-ingest | `3862ac86` (v0.9.0) | `7ec87ba3` (v0.8.7) |
| ufc-live-odds | `7391dd2a` (v0.2.1) | `a2eb98b2` |

## Running the scripts

- Requirements: Node 20+ and the repo checkout (D:\Workers\ufc-propbetedge).
- Credentials are read, never printed, from `web/.env.production.local`, `.env` or `D:\Workers\secrets\ufc-propbetedge.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
- Every script in `scripts/acceptance/` is GET-only.

## Schedule (UTC)

| Gate | Production event | Receipt window |
|---|---|---|
| 1 Fight DNA natural build | ufc-intelligence cron `17 7 * * *`, first after the scope-filter deploy: 2026-09-16 07:17Z | 2026-09-16 08:47Z or later |
| 2 UFC 331 market capture | ufc-live-odds hourly pre-fight band from 2026-09-17 18:00Z (captures at :25) | 2026-09-17 21:12Z or later |
| 3 First real lock pass | armed passes 2026-09-18 16:41Z and 17:41Z | 2026-09-18 18:07Z or later |
| 4 First grading lifecycle | UFC 331 results (evening of 2026-09-19 US), hourly armed grading, then LearnDaily `17 12 * * *` on 2026-09-20 | 2026-09-20 14:13Z or later |

If a receipt window has passed and the gate was never run, run it now. The scripts read history, not only the current state.

---

## Gate 1: Fight DNA natural build

**Baseline**, committed at `docs/acceptance/data/dna-baseline-2026-09-15.json`, captured 2026-09-15T11:49:03Z:
- 18,720 `ufc_fighter_bout_features` rows (feature_version 1)
- 0 rows from out-of-scope bouts
- set sha256 `7c2486740bcf002ccb6b01c568f3fe0c742b369b7ef19a6ba671fb4b220ae0e1`

A re-run of `check` at 12:02Z reproduced the same hash.

**Hash procedure.**
- Each row hash is sha256 of `JSON.stringify` over the columns `fighter_id … features`, in the script's select order, truncated to 24 hex characters. `generated_at` and `provenance` are excluded.
- The set hash is sha256 of the sorted `fighter_id|bout_id:hash` lines.

```
node scripts/acceptance/gate1_fight_dna.mjs check docs/acceptance/data/dna-baseline-2026-09-15.json .cache/dna-after-2026-09-16.json --as-of 2026-09-16
```

The receipt carries **two separate verdicts, never mixed**.

**A. ROAD TO UFC SCOPE: PASS / FAIL**
- `after_out_of_scope_rows = 0`: no `model_scope = false` bout feeds Fight DNA.
- Baseline rows `removed = 0` and `changed = 0`.
- Rows added for newly graded bouts are listed; every one must be `model_scope = true`.
- Report row counts and set hashes before and after.

**B. FIGHT DNA BUILD LIFECYCLE: PASS / FAIL — PRE-EXISTING DEFECT**
- Show every `ufc_dna_build_runs` row since the baseline: mode, started_at, finished_at, status, errors, input_counts.
- The full build for `--as-of` must reach `status = success` with `finished_at` set.
- `snapshots_written` (`ufc_fighter_dna_snapshots`, as_of_date, definition_version 1) must equal `snapshots_expected` (fighters with at least one feature row).

**Pre-existing defect baseline.** The 2026-09-15 07:17Z full build (`7f3f4866`) stayed `running` with `finished_at` null and wrote 1,400 of 3,163 snapshots. The 2026-09-14 11:21Z build (`250d7a6b`) also never closed.

If scope passes and only the lifecycle fails, report exactly:

```
ROAD TO UFC SCOPE: PASS
FIGHT DNA BUILD LIFECYCLE: FAIL — PRE-EXISTING DEFECT
```

Then **stop**. Give the owner the exact root-cause evidence and change nothing until the owner decides. Evidence to gather, read-only:
- the ufc-intelligence 07:17 cron path (`workers/ufc-intelligence/src/index.js`, `scripts/dna/build_fight_dna.mjs`)
- Worker CPU, wall-clock and subrequest limits against the build's work
- `wrangler tail` / observability logs
- run-row timing
- which fighters' snapshots were written before it stopped

## Gate 2: UFC 331 market capture

```
node scripts/acceptance/gate2_market.mjs --since 2026-09-17T12:00:00Z
```

Market freshness rule (frozen):
- FRESH means at most 60 minutes old, using only observations with `observed_at` at or before the cycle clock.
- STALE or UNAVAILABLE never blocks a model call.
- STALE or UNAVAILABLE carries no current PBE delta, no market-edge language and no elite tier, and shows the actual age.

Prove each of these:
1. **Fresh snapshots arrive.** List the pre-fight runs in `ufc_market_runs` (`notes.lane = 'prefight'`) with band, lock deadline, status, cost and quota. List the UFC 331 `ufc_market_run_quotes` snapshot times with bout and book counts. Expect one capture per hour at about :25 from 18:25Z.
2. **Stale → fresh transitions are correct.**
   - For every armed `ufc_model_runs` row, record the UFC 331 `ufc_model_bout_evaluations.market` status and age.
   - STALE is expected before the hourly band, FRESH after it.
   - Every FRESH market must be at most 60 minutes old, with `observed_at <= run started_at`.
3. **Official market columns only when fresh.** `market_implied_prob_pick`, `market_books`, `model_edge_pts` and `market_snapshot_at` are non-null only when `sample_context.market.status = 'FRESH'`. Otherwise they are null and `pbe_delta_pts` is null.
4. **No post-lock snapshot alters a locked call.** For a locked row, `market_snapshot_at <= locked_at`. Cite the guards:
   - `ufc_model_predictions_write_gate_trg` (migration 011) refuses any change to a locked row.
   - The cycle reads quotes with `observed_at <= clock`.
5. **No unsupported elite designation.** `elite_candidate` requires a FRESH market and disagreement of at most 15 points. Report `elite_total`.

## Gate 3: first real lock pass

```
node scripts/acceptance/gate3_lock.mjs --since 2026-09-18T15:30:00Z
```

Run it after the 17:41Z pass. Before the lock window it correctly reports NOT ACCEPTED with "no armed run inside the lock window yet".

**Official lock invariants** (any failure means immediate rollback to dry run, then report; never patch around it):
- Only ELIGIBLE armed drafts lock. Each locked prediction's bout is ELIGIBLE in the armed run that locked it.
- NO_MODEL_CALL stays NO_MODEL_CALL, with no locked row.
- Stale or unavailable markets fail closed: no official market columns, no PBE delta, no elite.
- Model, version and spec hashes match V1 exactly (table above). There is exactly one `ufc_model_versions` row, and it is live.
- Locked `pick_fighter_id` and `pick_probability` equal the locking run's latest valid pre-lock evaluation.
- `locked_at` falls within [2026-09-18 16:00Z, 18:00Z).
- One lock per eligible bout: the eligible bouts in the last armed run inside the window equal the locked bouts, with no duplicate bout.
- No challenger or promotion side effect: no new model version, and no `owner_decision` or `promoted_model_version` on any review.
- The public Pro surface reflects locked truth: the `/pro` eyebrow shows `N locked call(s)`, and `/algo` and a UFC 331 fight page are consistent.

**Shadow isolation invariant** (owner-approved 2026-09-15; a nonzero shadow-lock count is **not** a failure):
- Challenger shadow calls may lock in `ufc_model_shadow_predictions` during the same window. The shadow-lock count is reported separately.
- Shadow locks never create, modify, supersede, withdraw or grade an official PBE Algo prediction.
- Shadow failures (`counts.shadow.errors`) never block or fail official champion processing: the armed run status stays `ok`.
- No shadow prediction appears on public Pro surfaces: no challenger run id and no shadow/challenger content in `/pro`, `/algo` or the fight page.
- No shadow result affects the official record: `ufc_model_live_record` counts only official locked predictions.
- No challenger or promotion action occurs outside the owner-approval path (`POST /admin/promote` with the owner token, via `ufc_model_promote()`).

If every official and shadow-isolation invariant passes, declare:

```
PBE ALGO V1 — PRODUCTION LOCK LIFECYCLE ACCEPTED
```

## Gate 4: first grading lifecycle

```
node scripts/acceptance/gate4_grading.mjs
```

The receipt reports PENDING until results and grades are in. Re-run after the 2026-09-20 12:17Z LearnDaily run.

Prove each of these:
1. **Result ingestion.** UFC 331 `ufc_bout_results`: winner, method, round, time, `result_source`, `captured_at`, plus the event's `card_status`.
2. **One deterministic grade** per locked call. Revision 1 is bound to the stored result (WIN/LOSS by winner, DRAW, NC, and VOID only without a result on a cancelled bout or completed card), with `graded_by = 'ufc-algo'`.
3. **No duplicate grade.** Exactly one revision 1. A later revision exists only when the stored result changed, with its `revision_reason`.
4. **Append-safe corrections.** Cite the guards: `ufc_model_grades_append_only_trg`, and `ufc_model_predictions_write_gate_trg` plus `ufc_model_predictions_no_delete_trg` (migration 011). Locked rows stay unchanged.
5. **Learning eligibility follows the existing contract** (`docs/PBE_ALGO_LEARNING_DESIGN.md` §3.1):
   - LearnDaily on 2026-09-20 may use UFC 331's graded `model_scope = true` bouts dated before its run date, after the freshness and locked-grade gates pass.
   - It may create at most one CHALLENGER, with a passing leakage audit, that supersedes `e250a579`.
   - No out-of-scope bout may be used.
   - No `ufc_model_versions` change and no promotion. **Do not retrain or promote merely because new data exists.**
   - Also report the challenger's shadow locks and shadow grades.
