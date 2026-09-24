# Fight DNA same-day cutoff fix (2026-09-24)

## Defect

`scripts/dna/build_fight_dna.mjs` (v1.1, the code `workers/ufc-intelligence` runs daily at 07:17Z and again whenever `ufc-stats-ingest` hands it new round rows) selected events with `event_date <= AS_OF` and filtered bouts with `e.event_date <= AS_OF`. The contract (`docs/FIGHT_DNA_CONTRACT.md`), the API's `as_of` note (`workers/ufc-api/src/index.js`, `DNA_AS_OF_NOTE`) and the model docs (`docs/model/METHODOLOGY.md`, `LEAKAGE.md`) all define the cutoff as EXCLUSIVE: the snapshot dated D contains bouts with `event_date < D`, never `= D`.

The historical series used by PBE Algo was built by `scripts/dna/repair_historical_snapshots.mjs`, which patched the cutoff to exclusive at runtime, so the model's training and walk-forward inputs were correct. The daily "current" snapshot was not: a same-UTC-day rebuild (triggered when a card's round stats land) wrote a snapshot dated D that already contained D's bouts.

## Fix (this commit)

- `scripts/dna/build_fight_dna.mjs`: `event_date=lt.${AS_OF}` with `order=event_date.asc,id.asc`; the bout filter goes through one exported predicate, `boutContributes(eventDate, asOf)` (`eventDate < asOf`). `BUILDER` is now `ufc-intelligence/build_fight_dna@v1.2`; `DEFINITION_VERSION` stays 1 because no metric definition changed. An optional `cfg.onRows` observer lets tests capture dry-run output; it is null in production.
- `scripts/dna/repair_historical_snapshots.mjs`: patch logic is now the exported pure `patchBuilderSource(src)`; its anchors resolve against the current builder; it asserts the exclusive form is present instead of re-patching it; the temp builder's CLI guard is retargeted so the repair can actually run. Not executed against the database.
- `scripts/dna/build_fight_dna.test.mjs` (8 tests, no network, PostgREST stub that throws on any `lte.` query or any non-GET): fight D excluded from snapshot D; included from D+1; D+7 excluded at D+7 and included at D+8; the predicate is exclusive on the boundary; the events query is `lt.`; the repair anchors resolve and keep exclusive semantics; and the PBE Algo consumer (`latestAsOf(as_of_date <= event_date)`) still resolves to a snapshot that cannot contain the target bout. A mutation check (revert to `lte`/`<=`) fails all 8.

Run: `node --test scripts/dna/build_fight_dna.test.mjs` and `node --test scripts/model/model.test.mjs` (26 pass, 3 skipped without the local extract).

## Invariant

For an as-of date D, no bout with `event_date >= D` contributes to the snapshot dated D. Fight D first appears in the snapshot dated D+1 (the daily cron at 07:17Z the next UTC day, or any later rebuild).

Historical PBE Algo semantics are unchanged: the model resolves `as_of_date <= event_date`, and its stored predictions and the repaired historical series were already exclusive. No model artifact was rewritten.

## Contaminated snapshots in production (scan of all 54,543 rows, 2026-09-24)

Exactly 8 snapshots contain a bout dated on or after their `as_of_date`. All 8 were written by the same-day rebuild on 2026-09-19 (UFC 331) and each contains one bout from that card:

| fighter_id | as_of_date | generated_at | contaminating event_date | bouts |
|---|---|---|---|---|
| `1cf96282-3a89-4afe-8df8-bd3ae01e587c` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `21ee70b8-ce4e-43a0-8113-628b3a626753` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `26f1a938-4948-4ceb-8bd3-7c4f4339ba13` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `374474de-be75-4e2e-b934-acaa83caa433` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `45a8e167-ed6f-4987-b855-5729099ce3ac` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `54bd9461-d733-42ba-bd59-74e6c5c3780c` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `9794a933-6515-4f16-a65b-226fee97eb4d` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |
| `f698480e-96f6-4a29-b26f-aa204b42e280` | 2026-09-19 | 2026-09-19T23:31:17Z | 2026-09-19 | 1 |

Every other snapshot (including the full historical series) is clean.

## Decision

Both, in this order:

1. **Rebuild the 8 rows** once the fixed builder is deployed, with the fixed code: `node scripts/dna/build_fight_dna.mjs --as-of 2026-09-19 --fighter <fighter_id>` for each id above (idempotent upsert on the snapshot PK; it also rewrites that fighter's bout-feature rows with identical values). This is a production write and needs the owner's go, as does redeploying `ufc-intelligence` with the fixed builder (the Worker still runs v1.1 until then, so the next same-day rebuild would recreate the defect).
2. **The simulator rejects rather than trusts.** The engine (`workers/ufc-simulator`, `validateSnapshotAsOf`) refuses any snapshot whose `provenance.bouts` contains a bout dated on or after its `as_of_date` and returns `REJECTED_SNAPSHOT`; the Phase 4 Worker must then resolve the previous valid snapshot for that fighter. Every artifact stores `inputs_sha256`, so a snapshot repaired after an artifact exists yields a new revision, never a silent overwrite.

The deployed `ufc-algo` cycle already guards its own inputs (`target_in_snapshot`, `snapshot_after_event`).
