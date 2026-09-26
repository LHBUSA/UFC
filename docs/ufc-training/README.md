# UFC Training & Corner — runbook

LIVE 2026-09-26. Owner decision (Justin Erickson, 2026-09-26): ESPN athlete `association` (id + name) is the UFC
current-camp signal. `association.location` is never a location. Customer attribution: "Data source · PropSports".
Source/rights history: `docs/UFC_TRAINING_SOURCE_MATRIX.md` (do not reopen unless the source changes or breaks).

## Pieces
| Piece | Where | Production |
|---|---|---|
| Schema | `migrations/032_ufc_training_corner.sql` (mirror `supabase/migrations/20260926120000_*`) | applied to tkmln; proof `pwsh scripts/db/prove_032.ps1` (17 checks, rolled back) |
| Change detector | `workers/ufc-stats-ingest/src/training.mjs` | ufc-stats-ingest v0.9.5 `d392be27` (rollback `cce0a0aa`) |
| API | `GET /v1/ufc/fighters/{id}/training`, `?include=training` | propbetedge-ufc-api `17070230` (rollback `e52a752b`) |
| Profile module / fight page | `web/components/TrainingCorner.tsx`, `web/lib/training.ts` | Vercel main 6d54960 |
| Backfill | `node scripts/training/backfill_current_camp.mjs [--dry]` | 2026-09-26: 746 eligible, 734 camps (98.4%), 365 camps |
| Manual facts | `node scripts/training/enrich.mjs help` | cited facts only |

## Semantics
- Every ESPN athlete read (new fighter, record refresh, daily camp sweep) calls `ufc_training_record_association`:
  same id = re-confirmation stamp; new id = new OBSERVED row + `AFFILIATION_CHANGED_OBSERVED`; no association = nothing.
- Daily sweep (06:00Z lane): active roster (UFC bout in 18 months or booked), booked-in-21-days first (2-day recheck),
  others 14-day, max 40 athlete docs/run, athlete document only. Reads recorded in R2 `ufc-raw/_state/camp_sweep.json`.
- Run notes: `ufc_ingest_runs.notes.training_capture` (every ESPN lane) and `notes.camp_sweep` (daily).
- UI wording: observed = "First observed <Mon YYYY>"; "Joined" only with a stated date; observed change =
  "Camp affiliation changed"; "Switched camps" only for `CAMP_CHANGED_CONFIRMED` (manual `switch`, which supersedes
  and keeps the observed event). NEW CAMP SINCE LAST UFC BOUT only when `newCampSinceLastBout` proves it.

## Manual enrichment (examples)
```
node scripts/training/enrich.mjs show --fighter natalia-silva-4054605
node scripts/training/enrich.mjs coach --fighter 5144008 --coach "Rick Collup" --role HEAD --create --source <url> --published 2025-08-29 --note "<quote>"
node scripts/training/enrich.mjs fighting-out-of --fighter <ref> --city Miami --region Florida --country USA --source <url>
node scripts/training/enrich.mjs switch --fighter <ref> --to "Kill Cliff FC" --from "American Top Team" --effective 2026-05-01 --source <url>
```
Source rules for manual facts: gym sites, reputable journalism, verified announcements. Not ufc.com, espn.com,
tapology, sherdog (incl. syndicated), wikipedia, content farms. Role only as stated (else OTHER). `--dry` writes nothing.

## Rollback
Consumers first: redeploy ufc-api `e52a752b`, ufc-stats-ingest `cce0a0aa`, Vercel previous production deployment;
then (destroys the ledger — export first) `supabase/migrations/rollback/20260926120000_ufc_training_corner.down.sql`.
