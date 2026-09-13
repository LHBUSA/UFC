# Round-for-Round: rollover + round-archive gap (2026-09-13)

Branch `round-for-round-rollover-archive-v1`, from main `9415fea`. Not merged, not deployed.

## Production failure (verified read-only, 2026-09-13 ~23:25Z)

`Noche UFC: Silva vs. Delgado`, 2026-09-12, event `1d0b22df-81e7-4e5b-8fa5-8e5d03c24c52`:

| Fact | Value |
|---|---|
| card_status | complete |
| bouts / results | 13 / 13 |
| bouts with round rows / round rows | 0 / 0 |
| ufc_round_stat_queue | 13 × `awaiting_source`, `last_reason = UFCSTATS_ENABLED=false`, attempts 0 |
| queue overall | 41 × `awaiting_source` (all `UFCSTATS_ENABLED=false`) |
| archive coverage ends | 2026-09-05 |
| /round-by-round deck (production) | UFC 331 as "Next event", 0 results — Noche already gone |

Evidence: `docs/ops/evidence/noche_ufc_round_archive_state_2026-09-13.json`.

## Phase A — canary (production Worker)

`POST https://ufc-stats-ingest.sales-fd3.workers.dev/admin/canary?n=6`, Worker `v0.5.0`, 2026-09-13T23:20:12Z:

| | |
|---|---|
| verdict | **challenged** |
| egress | Cloudflare ORD, IPv6 |
| UFC Stats HTTP | 200 with the challenge interstitial (`http://ufcstats.com/fight-details/e93a446ad5e483de`) |
| bouts tested | 0 of 6 (aborted on the first page, by design) |
| identity / parser mismatches | not measured |
| rows that would change | none (canary never writes round rows) |
| challenges solved | 0 (solver off) |
| source_health written | `challenged`, retry_after 2026-09-14T05:20:12Z |

Evidence: `docs/ops/evidence/ufc_stats_ingest_canary_2026-09-13.json`. Same result as the 2026-09-10 canary (DTW).

**Phases B and C are blocked.** `UFCSTATS_ENABLED` stays `"false"`, the challenge solver stays off, and Noche is not processed. Nothing in this branch fabricates, reconstructs or zero-fills round data.

## Phase D — rollover (web)

`web/lib/roundRollover.ts` selects three cards from stored data: live (broadcast window open), latest completed (most recent card with stored results, 10-day retention, until a later card is fought or goes live), next (soonest not-started card, never the focus). `getRoundForRoundState` in `web/lib/roundLive.ts` builds the deck from it; the next card is a separate small panel. The public line says "13 results recorded · round data pending" and "Official round observations are still being finalized" — never archived/verified before rows exist. The permanent archive (`ufc_round_index`) is unchanged.

Also fixed: the deck's "Event details" link used UFC.com's undated slug and rendered "Event not found" (production `/events/cryptocom-ufc-331`).

## Health — the outage is no longer silent (Worker, not deployed)

`workers/ufc-stats-ingest/src/archiveHealth.mjs`: a completed card with results, past a 12h grace after its event day, missing round rows while bouts wait on the source, is a ROUND ARCHIVE GAP. `/health` reports `round_lane_status: degraded` plus the gaps; every run records it in notes; the hourly fast-cron tick checks it with database reads only; one Discord alert, deduped, escalated every 24h, cleared once. `DISCORD_WEBHOOK_URL` is unset in production, so until it is set the alert is visible on `/health` and in run notes only.
