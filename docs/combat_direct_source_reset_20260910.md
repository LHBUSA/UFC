# Combat Career DNA — direct-source reset (2026-09-10)

This document supersedes the **external-source recommendation** in
`docs/combat_live_baseline_20260910.md`. The live UFC/combat coverage counts in
that baseline remain valid; only the proposed vendor/runtime path is replaced.

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

## One production runtime

`workers/combat-wikipedia-ingest` is the sole network/write owner for direct
Wikipedia Career DNA ingestion. Cloudflare owns execution and scheduling;
GitHub remains source/deployment plumbing only.

There is deliberately no second Python network/write runner. Keeping one
runtime prevents identity, refresh and idempotency rules from drifting between
two implementations.

The worker ships staged off:

```toml
SCHEDULE_ENABLED = "false"
WRITE_ENABLED = "false"
```

Deploying it therefore does not start a backfill. First deploy it inert, run the
read-only canary, then separately enable writes and scheduling only after proof.

## Identity contract

A Wikipedia title or fighter name is not identity proof.

For an existing UFC fighter, the Wikipedia page must be verified against our
**completed** canonical UFC history before any non-UFC career row is accepted.
Announced/upcoming UFC bouts are excluded from the identity checksum.

The worker requires exact UFC opponent + event-date overlaps and rejects DOB
conflicts. An ordinary fighter with multiple completed UFC bouts needs at least
two exact overlaps and zero unexplained Wikipedia UFC rows. A fighter with one
completed UFC bout requires matching DOB plus that exact bout.

Opponent links from a verified career table may create a source-native combat
identity only when the linked identity does not collide with an existing combat
fighter/alias. Possible existing identities go to
`combat_identity_review_queue` instead of being merged by name.

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
DREAM, Shooto, Pancrase and M-1. Unrecognized promotion rows stay unpromoted
rather than being guessed into a promotion.

The parser is pinned to the `Mixed martial arts record` section. A larger boxing,
kickboxing or amateur table must not win merely because it has more rows.

## Operations

The Cloudflare worker lives at:

```text
workers/combat-wikipedia-ingest/
```

Run local unit/dry-deploy checks from that directory:

```powershell
npm install
npm test
npx wrangler deploy --dry-run
```

Deploy with both switches still false:

```powershell
wrangler deploy
```

Then run the authenticated, read-only canary:

```text
POST /admin/canary
Authorization: Bearer <ADMIN_TRIGGER_TOKEN>
```

The default canary checks Kayla Harrison, Patricio Pitbull and Salahdine
Parnasse. Kayla/Patricio are useful multi-promotion positive cases. Parnasse is
also a deliberate freshness/fail-closed case: if Wikipedia has not yet added his
completed UFC bout, he should remain unverified rather than being forced through.

A manual audit remains read-only:

```text
POST /admin/run?limit=5
```

An actual write requires **both**:

- Worker environment `WRITE_ENABLED="true"`; and
- request `POST /admin/run?limit=5&write=1`.

Only after one bounded write is verified should `SCHEDULE_ENABLED="true"` be
turned on. The Cloudflare cron is `17 */6 * * *`, five fighters per pass by
default.

The collector uses an identifying Wikimedia User-Agent, `maxlag`, sequential
throttling, retry/backoff and a hard request cap. If the source is unavailable,
the run fails rather than attempting to evade it.

## Source registry

`20260910231000_combat_direct_public_sources.sql`:

- adds `wikipedia_en` as the enabled direct public Career DNA source;
- blocks `ufcalendar` by product policy because it is redundant to our direct
  upstream strategy;
- blocks Fight Forensics / SportsDataIO / Sportradar for this lane because a
  paid data dependency is not needed;
- keeps vendor `rights_state` as `unknown` where blocking is a product decision,
  avoiding unsupported legal conclusions.

## Acceptance bar before scaling

Scale only when:

- Wikipedia fighter identities pass the **completed-UFC** checksum;
- UFC rows are not duplicated into `combat_*`;
- repeated runs are idempotent;
- the same external bout seen from both fighters converges on one event/bout;
- ambiguous opponent identities enter review, never auto-merge;
- conflicting result claims enter review instead of overwriting truth;
- external bout counts materially improve Career DNA for selected fighters;
- the UFC-only Matchup DNA sample remains unchanged.

The objective is our own normalized combat graph built from direct, inspectable
sources—not dependence on somebody else's scraper.
