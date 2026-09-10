# Real-time UFC news pipeline

The design the `ufc-news-realtime-v1` branch builds toward, and the record of
what has actually been done. `docs/news_pipeline.md` describes the system that
exists today and stays accurate until the cutover; this file describes what
replaces the external-news half of it.

## Why

The external-news path has never published anything. Of 54 `ufc_articles`,
every one of the 13 `external` stories sits at `status='review'`, and the reason
is structural rather than a bug: `generateExternal` builds its fact block from
the RSS title and summary alone, never fetching the source page, so it emits
~76 words of the shape

> Contract report from Bloody Elbow: the table view on Islam Makhachev

and then asks the OpenAI desk to turn that into a 500-word article while the
desk's own validator forbids introducing any number not already in the packet.
That is unsatisfiable by construction. **The gate is right; the packet is
starved.** Fetching the source and attaching first-party UFC evidence is what
makes the existing gate passable, not a reason to weaken it.

Three of those thin drafts were briefly public on 2026-09-08 — published 13:37,
demoted to review 20:53 — which is why `first_published_at` is set on six rows
whose status is no longer `published`.

## The contract

```
ingest → PRIVATE → score → resolve entities → fetch source
       → build UFC intelligence packet → GPT-5.6 Sol → validate
       → dedupe → hero/media check → PUBLISH
```

There is no publish-then-enrich step for article quality. Video and secondary
media may attach after publication; a correct hero image may not.

## The candidate state machine

`ufc_news_items.state` is the spine. Every transition is a conditional
single-statement `UPDATE`, which is what replaces the newsroom's global
20-minute Durable Object lock on the real-time path.

```
new ──score──► scored ──enqueue──► queued ──claim──► enriching ──┬─► published
                                                                 ├─► held
                                                                 ├─► duplicate
                                                                 ├─► skipped
                                                                 └─► failed
```

The claim is:

```sql
update ufc_news_items
   set state = 'enriching', lease_token = $2, lease_expires_at = now() + interval '5 min',
       attempts = attempts + 1, last_attempt_at = now(), state_changed_at = now()
 where id = $1 and state = 'queued';
```

Atomic in Postgres. A duplicate queue delivery updates zero rows and the second
consumer stops. A consumer that dies leaves `state='enriching'` with an expired
lease, and the reclaim query picks it up; `attempts` bounds that, and an item
past the bound goes to `failed` and the DLQ rather than round-tripping forever.

`lease_token` is checked again at publish time, so a stalled run that is
reclaimed and then wakes up cannot write over the run that replaced it.

Behind both of those sits the structural guarantee, which does not depend on any
worker behaving correctly:

```sql
create unique index ufc_articles_news_item_uniq
  on ufc_articles (news_item_id) where news_item_id is not null;
```

One wire item, at most one article. Duplicate public articles are
unconstructible, not merely unlikely.

## Where the Durable Object lock still applies

Unchanged, and still the right tool for: source verification sweeps, backlog
reprocessing, broad refreshes, the daily editorial sweep, and control
operations. Those are genuinely global and benefit from single-flight. The
per-item article path does not.

## The two-class number gate

The current desk validator whitelists every number in the output against the
source packet. Fetching the source article enlarges that set, which would
weaken the gate exactly where it matters most. Numbers therefore carry
provenance:

| class | origin | rule |
|---|---|---|
| A | our own tables (`ufc_fighters`, `ufc_bout_round_stats`, `ufc_rankings`, `ufc_market_observations`, …) | may be asserted directly |
| B | the fetched source article (`ufc_news_items.source_body`) | permitted only with attribution to that source |
| C | anywhere else | reject |

The packet records which class each number belongs to, so validation is a
lookup rather than a judgement.

## Entity resolution is a publication gate

`primary_fighter_id`, `secondary_fighter_ids`, `mentioned_fighter_ids`. A
comparison subject is not the subject: "Jon Jones" in a prospect's signing
headline belongs in `mentioned_fighter_ids` and must never become the hero
image. Hero selection reads `primary_fighter_id` and nothing else. Below the
confidence threshold the item is held, never guessed.

## Latency

Target: detection to publicly visible within 10 minutes, 3–5 preferred.
Measured, not asserted: `ufc_news_pipeline_events.since_detect_ms` on the
`publish` row is the number, and p50/p95/max come from that column. The
website's ISR window counts toward it — a 3-minute backend that the public sees
10 minutes later has not met the target.

---

# Phase 2 — schema (applied 2026-09-09)

`supabase/migrations/20260909180000_ufc_news_pipeline.sql`. Additive only:
36 columns, 1 table, 12 indexes, 3 CHECK constraints. Nothing dropped, nothing
renamed, no existing constraint changed, no row's existing value overwritten.

Deliberately **not** changed: `ufc_articles.status` keeps its three values. The
site and the API both filter `status='published'`, and a held article is
`status='review'` plus a `hold_reason`. Widening that CHECK to add `'held'`
would have modified the one control keeping thin drafts off the site, for no
gain.

Proofs, in order:

1. `BEGIN … ROLLBACK` against the live schema — executes, then discarded.
2. Migration + probe in one rolled-back transaction — the post-state was
   inspected before anything was committed.
3. Migration applied **twice** in one rolled-back transaction — idempotent.
4. Applied.
5. Post-apply probe — matched the dry run exactly.
6. `rollback/20260909180000_ufc_news_pipeline.down.sql` proven the same way:
   returns the schema to its pre-migration state with the pre-existing unique
   constraints and the `assign_distinct_article_hero` trigger intact.

Backfill (all into columns that were null a moment earlier):

| write | rows | why |
|---|---|---|
| `ufc_news_items.detected_at = captured_at` | 140 | `default now()` would have made every pre-existing row look as though it arrived at migration time and corrupted the first latency report |
| `ufc_news_items.state = 'skipped'` | 140 | seeding them `'new'` would hand the enricher a 140-item backlog of stale wire on its first run; the backlog is reprocessed deliberately in Phase 8 |
| `ufc_articles.first_published_at = published_at` | 44 | `published_at` moves on a material refresh; the SLA baseline must not |

## One real side effect, reported rather than smoothed over

`/v1/ufc/news` returns the **same 38 slugs** before and after, but in a
different order. Cause: `order=published_at.desc` has no tiebreaker, and two
groups of four articles share a `published_at` to the microsecond. The
`first_published_at` backfill rewrote those rows, changing heap order and so the
tie-break. Repeated calls are stable before and stable after; only the crossing
moved them.

This is a pre-existing bug the migration exposed, not a bug it introduced: any
row rewrite would do the same. The fix is a secondary sort key on the news
queries in `workers/ufc-api` and `web/lib/db.ts`. It is deliberately **not**
done here, because Phase 2 changes no public behaviour.

---

# Phase 3 → Phase 4 boundary: two changes, in order, separately proven

Neither is optional and neither is part of Phase 4's feature scope. Both were
found by running Phase 3 against production rather than by reading the code.

**They ship as two independent deployments, A then B, each observed over normal
cron execution and reported before the next begins.** Not because the ordering
is a nicety — because the two bugs were concealing each other. A `?dry=true`
probe consumed Combat Press and LowKick MMA's feed freshness; the next real run
got 304 for both; and their items reached the database ONLY because the legacy
newsroom writer was still fetching unconditionally. Do B before A and those
items vanish silently, with every counter reporting success. Do them in one
deployment and there is no moment at which either is known to work on its own.

---

## Step A — `?dry=true` must be genuinely side-effect free

`fetchFeed` persists feed health — including the ETag and Last-Modified
validators — on every call, `dry` included. So a dry run makes the *next* real
run conditional, the origin answers 304, and the items the dry run just looked
at are never inserted at all. A dry run that changes the next production fetch
is not a dry run.

Dry mode must mutate none of: ETag, Last-Modified, source freshness metadata,
circuit-breaker state, success/failure counters that affect behaviour, Supabase
rows, queue messages, pipeline events, or any other future-fetch decision state.

Proof protocol, in order:

1. capture the exact relevant KV state
2. make a source response available to dry mode
3. execute the dry run
4. prove the KV operational state is unchanged, byte-wise where the encoding is
   stable and semantically where it is not
5. run a real ingest immediately afterwards
6. prove the real run still sees and processes that same item
7. prove no duplicate is introduced

Deploy only this fix. Observe normal cron execution. Stop and report.

---

## Step B — `ufc-news-ingest` becomes the sole writer to `ufc_news_items`

Only after Step A is proven.

Production evidence, 2026-09-09: 214 wire rows arrived from `ufc-news-ingest`
and 22 from `ufc-newsroom`'s legacy ingest phase at 23:01:17–23:01:23Z. They are
not the same kind of row.

| | ufc-news-ingest | ufc-newsroom legacy ingest |
|---|---|---|
| UFC-focus filter | yes — boxing/PFL/RIZIN land `state='skipped'` | none — everything is `state='new'` |
| `detected_at` | the run's clock, one value per poll | column default `now()`, per row |
| pipeline event | one `detect` row per item | none |
| queue ownership | Phase 4 | never |

The second column is the problem. A boxing item written by the legacy path is
`state='new'` and therefore *scoreable*, which is exactly the GPT-5.6 Sol spend
the focus filter exists to prevent. Two writers with different semantics is
tolerable only while nothing consumes the rows; the moment Phase 4 processes
candidates it stops being tolerable.

**`ufc-newsroom` itself stays.** Durable Object lock, run ledger, control-plane
cron, catch-up planning, `/health`, `/admin/run`, source and batch
orchestration. This disables one writer. It is not a newsroom rewrite and it
ships with a rollback.

Proof required, across multiple real cron cycles rather than one triggered run:

- `ufc-news-ingest` is the only process creating `ufc_news_items`
- every new item carries the new `detected_at` semantics (one value per poll,
  never a row-by-row cluster)
- every eligible item has a `detect` pipeline event
- cross-sport items never reach an enrichment-eligible state
- duplicate delivery remains harmless
- no legitimate item disappears
- the published article set is unchanged
- `ufc-newsroom` `/health` stays clean and its ledger keeps recording runs

Only after A and B are each independently proven may the queue producer be
considered for enablement. Not before.

---

# Product requirements queued after the media lane

Two, recorded here rather than carried in a conversation.

## 1. Rich articles, not text-only ones

The new Sol articles read better than the old deterministic ones and are
POORER as a product. The benchmark is the existing deep UFC article: high-level
analysis, Bettor's Edge, Fight DNA, matchup and fighter data, real charts,
market context, official video, hero media, recent form, sourcing, and related
fight/event/news context. Better prose is not permission to regress to prose.

So `ufc-news-enrich` gains a deterministic **content plan** stage after the
narrative: for each article, decide which modules the evidence can actually
support, and attach only those.

| module | attach when |
|---|---|
| Bettor's Edge | always (it is already in the packet) |
| fighter stat comparison | an opponent profile exists |
| Fight DNA evidence | `ufc_fighter_dna_snapshots` covers the fighter |
| recent-form comparison | both sides have archived bouts |
| odds / market snapshot | `ufc_market_observations` covers THIS bout |
| round/style visualisation | round-level rows exist |
| official video | video-autopilot resolves one confidently |
| fighter or matchup card | a primary fighter, always |
| related live wire | topic-signature siblings exist |
| source + methodology | always |

A contract story may warrant a fighter profile, a video and career context. A
matchup story may carry three to five modules plus DNA and video. Nothing is
forced: a module with no evidence is omitted and the omission is recorded, which
is the same discipline the prose already follows.

**Charts are built from packet fields, never from the model.** GPT-5.6 Sol
writes narrative; it does not emit chart data or HTML. SLpM, SApM, TD/15, TD
defence, finish history, round pace, DNA traits, recent-form outcomes and odds
movement are all deterministic reads of verified columns. A model-invented chart
is a fabricated number with a picture around it.

**Ownership stays split.** `ufc-news-enrich` owns the article and its content
plan; `ufc-video-autopilot` owns video discovery, classification and resolution;
`ufc-media` owns images; the renderer composes those authoritative layers. No
duplicated video storage, no second monolithic writer.

## 2. The ticker is a distribution layer, not a feed reader

External news is radar. The PropBetEdge newsroom is intelligence. The ticker is
our distribution, and it is currently dominated by Bloody Elbow, Sherdog, MMA
Mania and BJPenn — which is sending our own homepage audience to our inputs.

- A live-wire topic we have published on shows OUR article, our headline, an
  internal link, and the external trigger does not also appear.
- A detected story we have not yet written may show the external item, with
  attribution, until our article publishes — then ours supersedes it.
- Ranking: newest PropBetEdge analysis first, important developing signals
  second, unmatched external wire last.
- Target roughly 75–85% internal once article volume supports it, with no
  filler manufactured to reach a percentage.
- Deduplicate on `topic_signature` / `canonical_article_id`: one development,
  one slot.
- Attribution is preserved inside the article and its methodology. The source is
  credited; the audience is simply not sent away from the better product.
- Breaking-news exception: an external signal may appear instantly while
  enrichment runs, and the ticker destination swaps to our canonical article the
  moment it clears the green path.
- Freshness still wins. An older internal article must not outrank genuinely
  breaking external news merely for being ours.
