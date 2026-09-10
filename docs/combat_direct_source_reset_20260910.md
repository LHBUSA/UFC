# Combat Career DNA — direct-source reset (2026-09-10)

This document supersedes the **external-source recommendation** in
`docs/combat_live_baseline_20260910.md`. The live UFC/combat coverage counts in
that baseline remain valid; only the proposed vendor path is replaced.

## Decision

PropBetEdge does not need UFCalendar or another paid aggregator merely to
repackage UFCStats/Wikipedia-derived MMA facts.

The Career DNA source strategy is now:

1. **UFC-native facts:** keep the existing UFCStats/ESPN/official source lanes
   already owned by the UFC product. UFCStats remains fail-closed when source
   access is challenged; we do not bypass access controls.
2. **Cross-promotion professional career history:** use English Wikipedia
   directly through the Wikimedia Action API when a fighter page exposes a
   structured `Mixed martial arts record` table.
3. **Identity/reference enrichment:** use Wikidata directly where useful.
4. **Promotion-specific gaps:** add direct upstream adapters only when they add
   material facts not already obtainable through the above lanes.
5. **Unavailable facts:** remain null. No paid fallback is required simply to
   make the row count larger.

## Identity contract

A Wikipedia title or fighter name is not identity proof.

For an existing UFC fighter, the Wikipedia page must be verified against our
canonical UFC graph before any non-UFC career row is accepted. The first
collector requires exact UFC opponent + event-date overlaps and rejects DOB
conflicts. One-UFC-bout fighters require a matching DOB plus the exact bout.

Opponent links from a verified career table may create a source-native combat
identity only when the linked identity does not collide with an existing combat
fighter name. Possible existing identities go to `combat_identity_review_queue`
instead of being merged by name.

## Data contract

The direct Wikipedia adapter extracts structured facts only:

- result / record
- opponent
- method
- event
- date
- round
- time
- location
- source page / page id / revision id / row locator

It does not copy article prose into the product. UFC rows from the Wikipedia
career table are verification evidence only; they are never duplicated into
`combat_bouts`.

Recognized non-UFC promotions in V1 include PRIDE, WEC, Strikeforce, Bellator,
PFL, WSOF, ONE, RIZIN, KSW, Cage Warriors, LFA, Invicta, BRAVE, OKTAGON,
DREAM, Shooto, Pancrase and M-1. Unrecognized promotion rows stay in the staged
source packet for later mapping rather than being guessed into a promotion.

## Operations

The parser is network-free and tested:

```bash
python scripts/combat/test_wikipedia_mma_parser.py
```

Build the current ranked/upcoming UFC pilot queue:

```bash
node scripts/combat/build_pilot_queue.mjs --limit 100 --json logs/combat-pilot.json
```

Audit direct Wikipedia coverage with no database writes:

```bash
python scripts/combat/wikipedia_mma_ingest.py \
  --pilot logs/combat-pilot.json \
  --limit 10 \
  --json logs/wikipedia-mma-audit.json
```

A write requires an explicit flag:

```bash
python scripts/combat/wikipedia_mma_ingest.py \
  --pilot logs/combat-pilot.json \
  --limit 10 \
  --write \
  --json logs/wikipedia-mma-write.json
```

The collector uses an identifying Wikimedia User-Agent, request throttling,
`maxlag`, retry/backoff and a hard request cap. If the source is unavailable,
the run fails rather than attempting to evade the source.

## Source registry

`20260910231000_combat_direct_public_sources.sql`:

- adds `wikipedia_en` as the enabled direct public Career DNA source;
- blocks `ufcalendar` by product policy because it is redundant to our direct
  upstream strategy;
- blocks Fight Forensics / SportsDataIO / Sportradar for this lane because a
  paid data dependency is not needed;
- keeps the vendor `rights_state` as `unknown` when the block is a product
  decision, avoiding unsupported legal conclusions.

## Acceptance bar before scaling

Run a small ranked/upcoming pilot first. Scale only when:

- Wikipedia fighter identities pass the UFC-history checksum;
- UFC rows are not duplicated into `combat_*`;
- repeated runs are idempotent;
- target-vs-target external bouts deduplicate;
- ambiguous opponent identities enter review, never auto-merge;
- external bout counts materially improve Career DNA for the selected fighters;
- the UFC-only Matchup DNA sample remains unchanged.

The objective is our own normalized combat graph built from direct, inspectable
sources—not dependence on somebody else's scraper.
