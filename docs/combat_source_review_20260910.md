# Combat source review — 2026-09-10

This is an operational source strategy, not a claim that public facts are owned
by a publisher. The objective is simple: **go to the upstream public source
when it is usable, preserve provenance, respect access controls, and do not pay
a downstream aggregator merely to repackage those same sources.**

The `combat_sources` table remains fail-closed. A source must be explicitly
enabled before it can write canonical `combat_*` facts.

## Direct-source policy

For Career DNA and cross-promotion MMA history:

1. Prefer the original/public source directly.
2. Use an official API when one exists instead of crawling rendered pages.
3. Identify our client with a real User-Agent and throttle requests.
4. Store normalized facts + source URL + source revision/locator, not copied
   article prose.
5. Cross-check a fighter's Wikipedia UFC rows against our canonical UFC graph
   before that page is trusted as the person's career page.
6. Never auto-merge fighter identities on name alone.
7. If a source blocks access, stop. Do not solve CAPTCHAs, evade challenges,
   rotate identities, or otherwise bypass the source's access control.
8. Missing/unavailable data stays missing. We do not invent it.

## UFC Stats

UFC Stats remains the native source for UFC-specific round statistics and fight
page detail already modeled by `ufc-stats-ingest`.

The current worker is intentionally fail-closed when UFC Stats presents an
access challenge. That policy does not change here. We use existing cached /
archived captures where available and direct access only when the source is
actually available to the collector.

**Combat registry state:** identity namespace only. UFC-native writes remain
owned by the existing `ufc_*` ingestion path.

## English Wikipedia — APPROVED direct Career DNA source

Wikipedia fighter pages commonly expose a structured **Mixed martial arts
record** table containing result, opponent, method, event, date, round, time,
location and notes across the fighter's professional career. For UFC-linked
fighters this can include pre-UFC PFL, Bellator, WSOF, KSW, ONE, RIZIN,
Strikeforce, WEC and regional history on the same page.

The new collector uses the Wikimedia **Action API** to obtain the page and its
revision id. It does not crawl arbitrary links or copy article prose into our
product.

Before any non-UFC row is promoted:

- the page must contain a parseable MMA record table;
- DOB conflicts fail identity verification;
- at least two exact UFC opponent+date overlaps are required for ordinary
  multi-fight UFC careers, or DOB + an exact overlap for a one-UFC-bout case;
- every stored external row keeps the Wikipedia page title, page id, revision
  id and row locator;
- UFC rows are validation evidence only and are never duplicated into
  `combat_bouts`.

Opponent identity is also fail-closed. A stable Wikipedia opponent link may
create a source-native combat identity **only when it does not collide with an
existing fighter name**. If it could be an existing UFC fighter and we have not
yet proven the Wikipedia identity, the row goes to review instead of merging by
name.

**Registry state:** `approved_ingest`, enabled after
`20260910231000_combat_direct_public_sources.sql`.

## Wikidata

Wikidata remains the preferred open identity/reference layer where it has the
needed entity. It is CC0 and is useful for stable identity keys, names and
biographical cross-checks, but it is not deep enough by itself to supply full
bout careers.

**Registry state:** `approved_ingest`, enabled.

## UFCalendar — NOT USED

UFCalendar is not an upstream source for PropBetEdge. Its own product describes
its UFC data as sourced from UFCStats and its broader promotion data as sourced
from Wikipedia.

That makes it redundant for our architecture. We can ingest those upstream
sources directly, validate them against our own UFC graph, and keep our own
normalization/provenance layer.

**Registry state:** `blocked`, disabled by product policy. This is a product
choice, not a legal conclusion about UFCalendar.

## Fight Forensics / SportsDataIO / Sportradar — NOT USED for this lane

These are not required for the direct-source Career DNA strategy. Their source
rows remain in the registry only so a future business decision would have to be
explicit.

**Registry state after the direct-source migration:** `blocked`, disabled by
product policy. `rights_state` remains `unknown`; we are not making a legal
claim about their data rights.

## Combat Registry / MixedMartialArts.com

The official-record value is high, but the current site-access posture reviewed
for this project does not give us a clean automated ingestion lane. We do not
bypass that.

**Registry state:** remains blocked unless a future permitted access path is
available.

## Sherdog / Tapology / FightMatrix / MMA Decisions

Useful as human reference and gap-discovery surfaces, but they are not enabled
as automated canonical fact writers in this system. We do not need them to
start Career DNA because Wikipedia already exposes many full professional
records for UFC-linked fighters.

**Registry state:** review-required / disabled.

## Implementation

The direct Wikipedia lane is:

```bash
python scripts/combat/wikipedia_mma_ingest.py --fighter "Kayla Harrison"
```

That command is audit-only. It resolves the Wikipedia page, parses the record,
and compares the UFC portion to our canonical UFC history.

For the ranked/upcoming pilot:

```bash
node scripts/combat/build_pilot_queue.mjs --limit 100 --json logs/combat-pilot.json
python scripts/combat/wikipedia_mma_ingest.py --pilot logs/combat-pilot.json --limit 10
```

Only after the audit output is clean do we write:

```bash
python scripts/combat/wikipedia_mma_ingest.py --pilot logs/combat-pilot.json --limit 10 --write
```

The write pass registers verified Wikipedia identities, stores a normalized
career packet with page/revision provenance, and promotes recognized non-UFC
professional bouts into `combat_*`. UFC rows remain solely in `ufc_*`.

## Decision

**No paid MMA data dependency is needed for this phase.**

Start with direct UFC Stats + Wikipedia/Wikidata, ingest what can be obtained
cleanly, and leave unavailable fields null. Expand promotion/source adapters
only when they materially add facts we cannot already obtain through this
upstream path.
