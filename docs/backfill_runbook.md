# Historical backfill runbook (Wayback source)

Decisions: ESPN is primary for events/bouts/results; UFC Stats enriches with
round stats via Internet Archive captures. Never run the full 14,000-request
job as the first scale test. Ramp, verify, ramp.

## Start a run (detached)

Claude Code's harness kills background tasks when the host is low on memory,
so anything longer than a minute runs as a detached Windows process:

```powershell
cd C:\Workers\ufc-propbetedge\scripts\backfill
$p = Start-Process python -ArgumentList 'backfill_ufcstats.py','--phase','fights','--since','2026-01-01','--limit','10' `
     -RedirectStandardOutput logs\run10.out -RedirectStandardError logs\run10.err -WindowStyle Hidden -PassThru
$p.Id | Set-Content logs\run10.pid
```

Monitor:

```powershell
Get-Process -Id (Get-Content logs\run10.pid) -ErrorAction SilentlyContinue   # running?
Select-String logs\run10.out -Pattern '^\[(event_done|fighter_linked|bout_linked|RESULT_MISMATCH|wayback_missing|SOURCE_UNAVAILABLE|ASSERTION_FAILURE|end)\]' | Select -Last 20
```

Every run writes one `ufc_ingest_runs` row. A failed row carries
`notes.last_error` (class, message, url, http_status, retries, last source
response class, JSONL log path) and schema assertions in `assertion_failures`.
`notes.wayback` has request/retry counters and any family-index failure.

## Ramp

| Step | Command | Gate before the next step |
|---|---|---|
| 1 | `--phase fights --since 2026-02-01 --limit 2` | ledger success; Feb 7 card 13/13 bouts; fighters linked with DOB; round rows > 0; zero unexpected assertions; gaps listed |
| 1b | same command again | no duplicate rows/aliases/results; enriched fights skipped; counts stable |
| 2 | `--phase fights --since 2025-10-01 --limit 10` | `python scripts/verify_phase1.py`; inspect mismatches and review queue |
| 3 | `--phase fighters` (26 list pages) then `--phase fights --since 2025-01-01` | verify again |
| 4 | newest -> oldest in chunks: `--phase fights --since 2024-01-01`, then `--since 2022-01-01`, `2019-01-01`, `2015-01-01`, `2010-01-01`, `2000-01-01`, `1990-01-01` | verify after each chunk; each chunk skips what earlier chunks enriched |

Resumability: every page is cached under `scripts/backfill/cache/`; every row
is keyed by `ufcstats_id`; enriched fights are skipped. Re-running a chunk is
safe and cheap.

## Expected pace

Wayback throttles hard: 2–3 s spacing plus 429/503 backoff from 30 s doubling
to 10 min. Budget 3 s per page when clear, much more when throttled. Fighter
pages dominate (two per new bout the first time a fighter is seen).

Coverage bound from the family indexes (2026-09-06): 4,115 fighter pages have
at least one capture. Events and fights indexes are built on first use;
their counts land in `notes.wayback`.

## Reading the gaps

`notes.wayback_missing` lists every page with no usable capture. A missing
fighter page leaves the bout unlinked (`bouts_unlinked_missing_fighter_page`);
a missing fight page leaves the result unenriched. Those are the rows the
Worker's live path (or a later gap-fill run) has to close. They are never
written with guessed data.
