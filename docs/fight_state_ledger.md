# PBE Fight State Ledger

Append-only fight-week snapshots per bout, so the product keeps information
that cannot be recreated after the fact (card state, rankings, the Fight DNA
in force, the wire, odds once a provider exists, the result). Table:
`public.ufc_fight_state_ledger` (`migrations/005_ufc_fight_state_ledger.sql`);
a trigger rejects every UPDATE and DELETE, so corrections are new rows.

## Checkpoints

| checkpoint | time | note |
|---|---|---|
| `t_minus_7d` | start − 168 h | |
| `t_minus_72h` | start − 72 h | |
| `post_weigh_in` | start − 26 h | approximation until weigh-in ingestion exists; `provenance.checkpoint_basis` records it |
| `t_minus_24h` | start − 24 h | |
| `t_minus_3h` | start − 3 h | |
| `close` | start − 1 h | |
| `post_result` | when a result row exists | |
| `ad_hoc` | on demand | baseline captures, corrections |

`start` is the ESPN event start (`provenance.scheduled_start_source =
espn_core_api`); if unknown, the event date at 22:00 UTC is assumed and the
basis is recorded. Each (bout, checkpoint) is captured once, only inside
`[checkpoint, checkpoint + 12 h]`; a missed window is reported and never
back-filled, because a late capture would not be the state at that time.

## Blocks

`bout_state`, `fighters` (identity, stance, record, stance context, rankings
positions), `rankings`, `dna` (the latest `ufc_fighter_dna_snapshots` row at or
before capture: sample, coverage, selected metric objects, pace, finish and
the split against the opponent's listed stance), `weigh_in`, `wire`
(attributed `ufc_news_items` linked to the bout/event/fighters in the last 14
days plus published PropBetEdge articles with their fact-block version),
`odds`, `market`, `model`, `result`, and `provenance` (per-block source table
and timestamps, builder version, checkpoint basis).

Blocks whose source does not exist are stored as explicit
`{"status":"unavailable","reason":…}` objects: weigh-in ingestion, odds
provider, market derivations and model output are all `unavailable` today.
Nothing is guessed.

## Running

```
node scripts/ledger/capture_fight_state.mjs --auto                    # due checkpoints, LOCAL inspection only

PRODUCTION OWNER: the Cloudflare Worker `workers/ufc-fight-state`, cron `23 * * * *`.
The GitHub workflow `.github/workflows/fight-state-ledger.yml` is disabled_manually
and no longer schedules anything: its declared hourly cron was in practice firing
every four to five hours, which is where the ledger's missed windows came from.
The Worker imports this same module, so there is one implementation of fight state.

CORRECTIONS ARE APPEND-ONLY. A row that should not stand is invalidated by a LATER
row naming it (provenance.correction.invalidates_ledger_id); UPDATE and DELETE are
refused by trigger. Idempotence and every product read use the EFFECTIVE ledger,
which excludes invalidated rows. `GET /ledger?event=<id>&audit=true` shows both.
node scripts/ledger/capture_fight_state.mjs --checkpoint ad_hoc --event noche
node scripts/ledger/capture_fight_state.mjs --auto --dry-run --json
```

The workflow runs at :23 every hour from the default branch; until this
branch merges, run it by hand or dispatch it on the branch.

## Reading

`GET /v1/ufc/bouts/{id}/ledger` and `GET /v1/ufc/events/{id}/intelligence`
(API track) expose the ledger newest-first with a diff of what changed between
checkpoints; Card Shock scoring will be derived from those diffs.

## First capture (2026-09-06)

`post_result` for the 14 bouts of UFC Fight Night: Hooker vs. Parnasse
(2026-09-05) and `ad_hoc` baselines for Noche UFC: Silva vs. Delgado
(2026-09-12) and the Contender Series weeks in the window; the T-7d windows
for Noche UFC had already closed before the ledger existed and are recorded as
missed, not back-filled.
