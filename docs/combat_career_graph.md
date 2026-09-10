# Combat career graph — UFC-first, MMA-deep

## Purpose

The UFC product remains UFC. The combat career graph is the underlying identity
and career layer that lets Fight DNA understand what a fighter did before,
between, or outside UFC appearances without mixing unlike samples or polluting
the canonical `ufc_*` tables.

The first release is deliberately an overlay:

- `ufc_*` stays authoritative for UFC events, bouts, results, round stats,
  rankings, weigh-ins, officials, market and editorial data.
- `combat_*` owns cross-promotion identity and verified non-UFC career facts.
- `combat_career_bouts` unions the two at read time and labels every row
  `source_scope = 'ufc'` or `source_scope = 'combat'`.
- A consumer must preserve that distinction. Career DNA may use both scopes;
  UFC DNA must use UFC scope only.

## Why this exists

A fighter can arrive in the UFC with a large professional history elsewhere.
Treating the UFC subset as the whole career makes sparse newcomers look like
unknown fighters and hides real finish, pace, experience and opponent-history
context. The answer is not to dump third-party records into `ufc_bouts`; it is
to give one person a stable combat identity and attach promotion-native career
facts to that identity with provenance.

## Migration

`supabase/migrations/20260910235900_combat_career_graph.sql`

The migration is additive. It does not ALTER, INSERT, UPDATE or DELETE any
`ufc_*` table. It creates:

- `combat_sources` — operational rights/access gate for every new source.
- `combat_fighters` — one cross-promotion person identity; optional one-to-one
  link back to `ufc_fighters`.
- `combat_fighter_identities` — source-native fighter IDs (UFC Stats, ESPN,
  Wikidata, later promotion/provider IDs).
- `combat_fighter_aliases` — names, nicknames and transliterations with source.
- `combat_identity_review_queue` — ambiguous identities fail closed here.
- `combat_promotions` and `combat_rulesets`.
- `combat_events`, `combat_bouts`, `combat_bout_results`, `combat_round_stats`
  for verified non-UFC career data.
- `combat_source_claims` — field-level provenance/reconciliation evidence.
- `combat_import_runs` — one ledger row per bootstrap/import/reconcile run.
- `combat_career_bouts` — UFC + non-UFC normalized read model.
- `combat_fighter_career_summary` — separate UFC and external appearance counts.
- `combat_ufc_bridge_coverage` — bridge completeness and expansion counters.

All tables are RLS-on and service-role only. There is no public combat data
plane in this migration.

## Source policy: public does not mean ingestable

`combat_sources.access_mode` is an execution gate, not documentation.

- `approved_ingest` — may write canonical `combat_*` facts.
- `identity_only` — may establish an identity namespace, not career facts.
- `reference_only` — may be used only by explicitly built reference/claim flows.
- `review_required` — fail closed. No automated collection.
- `blocked` — never collect.

Canonical fact tables have database triggers that reject any source not both
`enabled` and `approved_ingest`.

Initial policy:

- `ufc_canonical` — approved, because it is our existing normalized UFC graph.
- `ufcstats` — identity-only in the combat layer. This does not change the
  existing UFC Stats ingestion lane or its challenge/backoff policy.
- `espn` — identity-only in the combat layer. This does not authorize new MMA
  career collection from ESPN.
- `wikidata` — approved open-data identity/reference source (CC0), but sparse.
- UFC.com, commissions, Sherdog, Tapology, FightMatrix, MMA Decisions and the
  generic promotion source all start `review_required` and disabled. Each
  concrete adapter must earn an explicit policy change before it can write.

This is intentional. A source being visible in a browser is not proof that its
content can be bulk-collected or redistributed.

## UFC -> combat identity bridge

`combat_sync_ufc_identity()` is the only bootstrap operation in V1.

It:

1. creates/refreshes one `combat_fighters` row for every current `ufc_fighters`
   row;
2. records already-resolved UFC Stats and ESPN IDs as verified identities;
3. copies the existing canonical alias set into the combat alias layer;
4. never writes back to `ufc_fighters`.

The migration runs it once. Afterward it is explicitly re-runnable via:

```bash
node scripts/combat/bootstrap_ufc_identity.mjs --apply
```

It is a function rather than a trigger on `ufc_fighters` so
`ufc-stats-ingest` remains the sole owner of canonical UFC fighter writes.

## Pilot queue

Build the first 100 fighters to enrich:

```bash
node scripts/combat/build_pilot_queue.mjs --limit 100 --json logs/combat-pilot.json
```

Priority is deliberately product-facing:

1. current champions/ranked fighters;
2. fighters on the next three cards;
3. active fighters;
4. fighters with zero external career rows;
5. fighters that already have both verified UFC Stats and ESPN namespaces.

The queue contacts no outside source. It tells the next approved adapter who to
work on first.

## Audits

Native UFC gap audit:

```bash
node scripts/combat/remaining_ufc_audit.mjs --json logs/ufc-gap-audit.json
```

This reports structural coverage separately from depth: results, round stats,
referees, judge names, scorecards, weigh-ins, rankings identity, media and
related layers. It is the checklist for finishing UFC before assuming MMA will
solve a UFC-native hole.

Combat overlay audit:

```bash
node scripts/combat/career_audit.mjs --json logs/combat-career-audit.json
```

This reports bridge coverage, source gates, external events/bouts/promotions,
identity reviews and how many UFC fighters actually gained non-UFC history.

## Ingestion contract for the next adapter

The next source adapter must not write directly from scraped HTML into canonical
career tables. It should produce a source-native packet first:

```json
{
  "source_key": "licensed_provider_x",
  "fighter": {
    "external_id": "...",
    "name": "...",
    "dob": "YYYY-MM-DD",
    "source_url": "..."
  },
  "event": {
    "external_id": "...",
    "promotion": "...",
    "name": "...",
    "date": "YYYY-MM-DD",
    "source_url": "..."
  },
  "bout": {
    "external_id": "...",
    "fighter_a_external_id": "...",
    "fighter_b_external_id": "...",
    "weight_class_raw": "...",
    "scheduled_rounds": 3,
    "competition_class": "professional"
  },
  "result": {
    "winner_external_id": "...",
    "method_raw": "...",
    "round": 2,
    "time_sec": 214
  }
}
```

Then:

- exact source identity wins;
- cross-source linking requires stable supporting keys;
- ambiguous identity goes to `combat_identity_review_queue`;
- a new source-native fighter may be created only when the source has a stable
  fighter ID and no plausible existing identity collides;
- missing facts stay null;
- no inferred ruleset, title status, round count, weight limit or result;
- raw source evidence is retained in `source_record` / `combat_source_claims`;
- canonical promotion/event/bout rows require an `approved_ingest` source.

## Fight DNA policy

Do not silently change current UFC Fight DNA by adding non-UFC fights.

Expose three explicit samples when Career DNA ships:

- **UFC DNA** — only `source_scope='ufc'`.
- **Career DNA** — verified professional bouts across approved promotions.
- **Matchup DNA** — may compare both, but must surface UFC sample, external
  sample, promotion/ruleset mix and confidence separately.

A 5-round UFC title bout, a different promotion/ruleset, and a regional 3x5 bout
are not interchangeable observations. `ruleset_id`, `scheduled_rounds`,
`competition_class`, promotion and source provenance exist so model builders can
filter or weight them explicitly rather than pretending all MMA rows are
homogeneous.

## Rollout sequence

1. Apply the migration and prove 100% UFC -> combat fighter bridge coverage.
2. Run the native UFC gap audit and keep finishing UFC-owned data lanes.
3. Generate the top-100 pilot queue.
4. Approve one legally/operationally suitable external career source.
5. Implement one adapter against that source and ingest the pilot only.
6. Measure additional verified career bouts per fighter and identity-review rate.
7. Only then expand: current UFC roster -> their opponents -> major promotions ->
   broader global MMA.

The success metric is not row count. It is verified career coverage without a
single silent identity merge or loss of source/ruleset semantics.
