# TUF 5 / TUF 6 matrix verifier correction — 2026-09-13

This supersedes only the **matrix simulation / generic verifier observation** in `nsac_tuf5_tuf6_reconciliation_audit_2026-09-13.md`. The commission evidence audit itself is unchanged. No TUF 5 or TUF 6 canonical changes are applied here.

## Root cause

The old completeness matrix built `dbPairing` from any professional `ufc_bouts` rows between the two canonical fighter IDs and then used:

`dbVerified = dbPairing.some(row => row.winner_matches_archive)`

That answered **“did these fighters ever have a professional bout with the same winner?”**, not **“is this exact TUF bout verified?”**.

As a result, later professional rematches could verify earlier TUF house exhibitions. The same pair-level boolean could also make a final classification repairable.

## Correct rule

### House bouts

A house bout can be `result_verified` only from evidence tied to that house bout:

- an explicit athletic-commission result (`hasCommissionResult()`),
- an applied official-source repair explicitly covering `winner`, or
- an official/network episode recap for the same TUF pairing whose winner agrees and is not contradicted.

Professional fight-database rows are never house-result evidence.

### Professional finals

A professional final first resolves one `actualFinaleDbBout`:

1. explicit `ufc_bout_id` / scheduled `ufc_bout_id` / recorded `ufc_bouts:<uuid>` link; otherwise
2. legacy fallback: one unique DB row for the exact canonical pair on the exact finale **event and date**.

Only that row can set `dbFinaleVerified`, `dbFinaleScheduled`, or `classificationRepairable`.

Pair-level DB rows remain diagnostic only.

## False positives under the old rule

Nine house bouts were falsely verified across six seasons:

| Season | TUF house pairing | TUF winner | Professional DB row(s) that satisfied old pair rule | Why invalid |
|---|---|---|---|---|
| TUF 5 | Nate Diaz vs Gray Maynard | Nate Diaz | `868820d3-f69d-4cfb-ac5d-0be1eb03c369` — TUF Rousey/Tate Finale, 2013-11-30, Nate Diaz | later professional rematch |
| TUF 6 | Dan Barrera vs Ben Saunders | Ben Saunders | `70a3ef04-253a-4d13-97f1-fd007e364574` — TUF Hughes/Serra Finale, 2007-12-08, Ben Saunders | separate professional finale bout |
| TUF 7 | Amir Sadollah vs C. B. Dollaway | Amir Sadollah | `21bdd837-d7cb-4c4b-8d0b-668a6cd4d4c4` — TUF Rampage/Forrest Finale, 2008-06-21, Amir Sadollah | separate professional rematch |
| TUF 11 | Court McGee vs Nick Ring | Nick Ring | `2db46009-af04-46df-babd-c41ef7d281fe` — UFC 149, 2012-07-21, Nick Ring | later professional fight |
| TUF 11 | Brad Tavares vs Seth Baczynski | Brad Tavares | `9b703460-fe98-419c-87a5-218cc817c8ac` — TUF Liddell/Ortiz Finale, 2010-06-19, Brad Tavares | separate professional finale bout |
| TUF 24 | Alexandre Pantoja vs Kai Kara-France — house meeting 1 | Alexandre Pantoja | `ca2ac578-6ceb-42ed-a9e3-05975d9ffac7` — UFC 317, 2025-06-28, Alexandre Pantoja | nine-years-later professional bout |
| TUF 24 | Alexandre Pantoja vs Brandon Moreno | Alexandre Pantoja | `e3f32807-87a7-4740-81ff-18dd9a127c85` — UFC Fight Night Maia/Usman, 2018-05-19; `eefd181c-c3cc-47cf-a5c5-b137ccbcc9bf` — UFC 290, 2023-07-08; both Pantoja | either later pro fight made `.some()` true |
| TUF 24 | Alexandre Pantoja vs Kai Kara France — house meeting 2 | Alexandre Pantoja | `ca2ac578-6ceb-42ed-a9e3-05975d9ffac7` — UFC 317, 2025-06-28, Alexandre Pantoja | one later pro bout falsely verified a second distinct house meeting |
| TUF 26 | Roxanne Modafferi vs Sijara Eubanks | Sijara Eubanks | `4992c0b7-366e-4858-bf0d-9bb7c19292ce` — UFC 230, 2018-11-03, Sijara Eubanks | later professional fight |

TUF 1–4 have **zero** false positives from this defect.

## Corrected all-season impact

Strict verified result count falls **206 → 197**. This is the expected correction of nine false pieces of evidence.

| Season | Verified before → after | House secondary-only before → after | Score before → after | Status | Blockers |
|---|---:|---:|---:|---|---|
| TUF 5 | 2 → 1 | 13 → 14 | 71 → 70 | PARTIAL | OPEN_SOURCE_CONFLICT; HOUSE_RESULTS_SECONDARY_ONLY |
| TUF 6 | 2 → 1 | 13 → 14 | 70 → 69 | PARTIAL | ROSTER_MISSING; CLASSIFICATION_UNRESOLVED; BRACKET_NAME_NOT_IN_ROSTER; HOUSE_RESULTS_SECONDARY_ONLY |
| TUF 7 | 2 → 1 | 29 → 30 | 66 → 65 | PARTIAL | unchanged |
| TUF 11 | 27 → 25 | 2 → 4 | 91 → 90 | PARTIAL | unchanged |
| TUF 24 | 3 → 0 | 14 → 17 | 67 → 63 | PARTIAL | unchanged |
| TUF 26 | 2 → 1 | 14 → 15 | 71 → 70 | PARTIAL | unchanged |

No affected season changes matrix status or blocker array. Fingerprints are data fingerprints, so they do not change from this evidence-rule repair.

## Hub invariants

Hub structural completeness is independent of the strict evidence verdict and remains:

- Complete seasons: **43 → 43**
- Season ongoing: **1 → 1**
- Partial structural seasons: **0 → 0**
- Verified badge: **1 → 1**
- Total: **44 → 44**

TUF 2 remains the sole `COMPLETE + VERIFIED` season. TUF 1, TUF 3 and TUF 4 remain structurally Complete with their existing strict evidence gaps. `Research gaps` does not return to hub cards.

Because every changed season remains `PARTIAL` with the same blocker array and no season data/fingerprint changed, regeneration of `web/data/tuf/status.generated.json` is **byte-equivalent in season verdict content**; there is intentionally no status-artifact diff from this rule repair.

## Corrected TUF 5 / TUF 6 pre-apply baseline

The old BEFORE counts were contaminated.

### TUF 5

- status: PARTIAL
- score: **70**
- strict verified: **1/15** — the professional final only
- house secondary-only: **14/14**
- house commission verified: **0/14**
- blockers: OPEN_SOURCE_CONFLICT; HOUSE_RESULTS_SECONDARY_ONLY

### TUF 6

- status: PARTIAL
- score: **69**
- strict verified: **1/15** — the professional final only
- house secondary-only: **14/14**
- house commission verified: **0/14**
- blockers: ROSTER_MISSING; CLASSIFICATION_UNRESOLVED; BRACKET_NAME_NOT_IN_ROSTER; HOUSE_RESULTS_SECONDARY_ONLY

If the separately reviewed commission batch is later approved, both simulations still reach 15/15 verified because each house bout would then have its **own** commission evidence. That future apply is explicitly outside this PR.

Machine-readable corrected simulation: `scripts/tuf/evidence/nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json`.

## Scope confirmation

No TUF 5/6 canonical season edits, commission ledger additions, winner corrections, timeline changes, identity changes, Workers, Actions, or hub UX changes were made by this repair.
