# Fighter status — availability as structured data

Not "injuries". The product question is **is this fighter available, for which
bout, since when, and who says so** — and a visa refusal removes someone from a
card exactly as an ACL does. The model is `ufc_fighter_status_events`
(`supabase/migrations/20260908000011_ufc_fighter_status.sql`, **not applied**).

## The rule that outranks coverage

> **Never infer a diagnosis.**

"Out due to injury" is `status_type='injury'` with `injury_type` **NULL**. Not
`'unspecified'`, not carried over from this fighter's last injury, not guessed
from "grabbed his knee". A wrong body part attached to a named athlete is a
fabricated medical claim about a real person; an empty column is a gap. Those
are not the same size of mistake, and the system is built so the first one is
hard to make:

| layer | how it enforces the rule |
|---|---|
| extractor | `injury_type`/`body_part` come only from a closed vocabulary matching literal words, in a sentence that names the subject |
| row | every clinical value carries `clinical_quote` — the sentence that licensed it |
| schema | `CHECK status_clinical_requires_quote` — no quote, no clinical claim, at the database |
| API | a null crosses as a null, with the key present; `/v1/ufc/injuries` never substitutes a placeholder |
| UI | renders "No diagnosis stated by the source" as a sentence, styled as absence, never as a value |

## Sources, and which ones outrank which

`source_kind` is not decoration. It is the difference between the promotion
amending its own card and somebody reporting that it did.

| kind | what it is | used for |
|---|---|---|
| `official` | `ufc.com` and promotion-owned surfaces | **preferred for withdrawals and replacements.** When UFC.com changes a card, the card changed. Confidence +0.10 and an "Official" badge. |
| `commission` | athletic commission / anti-doping bodies (NSAC, USADA, CSAC) | suspensions and medical suspensions, where the commission is the primary record |
| `news` | verified RSS sources in `ufc_news_sources` | everything else; the bulk of the feed |
| `manual` | desk-entered, with the URL the editor was reading | corrections and anything the rules cannot reach |

### Audit of official surfaces

`ufc.com` publishes card updates as news posts and amends the event page
itself. Two observations shape how this system treats them:

1. **The event page is the record, the news post is the announcement.** A
   withdrawal appears in a post first and on the card page shortly after. The
   post is what carries a URL, a timestamp and a sentence, which is what a
   status row needs — so the post is the source we cite.
2. **UFC.com News is already a seeded RSS source** (`ufc_news_sources`,
   weight 0.8, verified by `scripts/news/seed_sources.mjs`). No new fetcher is
   required to reach it; `sourceKindFor()` promotes it to `official` on the
   host, so the existing ingest already delivers the preferred surface.

What this deliberately does **not** do is scrape the UFC card page for diffs.
A diff tells you a bout vanished; it does not tell you why, when, or who said
so, and a status row with no sentence behind it is exactly the unsourced claim
this design exists to prevent. If card-page diffing is added later it should
produce a *flag for review*, not a row.

## Access control

The migration is `supabase/migrations/20260908000011_ufc_fighter_status.sql`.
It is **000011**, not 000010: `ufc-fight-model-v1` holds
`20260908000010_ufc_model_predictions.sql`, and two candidate branches sharing
one version is a coin toss over which a fresh environment applies.

RLS on the base table is only half a guarantee. **A view runs with the
privileges of its owner by default**, so a view over an RLS-protected table
evaluates the policies as the owner — who is exempt — and hands every row to
anyone holding SELECT. RLS is on, the dashboard says protected, and three views
are wide open. It is silent, it is the default, and this table holds sourced
medical and disciplinary claims about named people.

So both mechanisms, because they fail differently:

* `security_invoker = true` on all three views — they execute as the **caller**,
  so the base table's RLS is evaluated against the role that actually asked.
* explicit `revoke all ... from anon, authenticated` on the table **and** each
  view — so a view is not merely empty for a browser role but inaccessible.
  This survives a policy being added later for some other purpose; a policy
  written for one reason must not silently open three views.

`service_role` keeps `select` on everything and `insert, update` on the table —
which is how every server read in this repo already works. **No `delete` is
granted to anyone**: expiring a claim must not be implementable as deleting it.

`lib/schema.test.mjs` asserts all of the above against the migration file.
It proves the SQL says the right thing, **not** that a live cluster behaves that
way — the migration has deliberately not been applied. The last test in that
file writes down the three statements a post-apply check must run: the
`reloptions` of each view, `role_table_grants` for anon/authenticated, and an
empirical `set local role anon; select count(*)`.

## The ten-minute pass, and the SLA arithmetic

The collector reads `ufc_news_items`. **If news ingest runs every thirty
minutes, a ten-minute status check is theatre**: it re-reads a table that has
not changed, reports success three times, and the real latency on learning that
a main event is off is thirty minutes. Any status SLA is bounded by whatever
last wrote the table it reads.

`scripts/status/status_pass.mjs` is the answer — **option A**: relevant source
ingest *plus* extraction on the same ten-minute trigger, with article
generation on its own schedule and never on this one.

    1. ingest     five RSS fetches, parse, dedupe, link, insert. No model.
    2. extract    regexes over the taxonomy-prefiltered window, idempotent insert.
    3. lifecycle  expire what its card outlived, resolve what a source ended.

Nothing in that list calls a model or writes an article. That is not a promise
in a comment — `lib/status_pass.test.mjs` walks the module's transitive import
graph and fails if `write_articles.mjs`, `polish_world_class.mjs` or any
Anthropic transport ever appears in it, and separately asserts that no module
in the graph contains a model endpoint.

### Cost of the cadence

Five feeds every ten minutes is 144 fetches per publisher per day, which is
ordinary RSS polling. The extraction is regexes. The lifecycle is one select
and a handful of patches. The expensive thing in the newsroom — a per-story
Anthropic rewrite — is not in this path at all, which is the whole point:
running publication six times an hour to learn about a withdrawal would be
paying for a newspaper to find out the time.

### Wiring it into the newsroom Worker

Three changes on `ufc-newsroom-worker-v1`, none of which touch the article path:

    // phases.mjs
    import { runStatusPass } from '../../../scripts/status/status_pass.mjs';
    import { main as ingestNews } from '../../../scripts/news/ingest_news.mjs';

    export async function runStatus(env, sb, { now = Date.now() } = {}) {
      return runStatusPass(env, { write: true, now, ingestFn: (e) => ingestNews(e, { now }) });
    }

    // coordinator.mjs
    PHASES            = ['sources', 'status', 'ingest', 'write', 'refresh', 'sweep'];
    MAX_AGE_MINUTES   = { ..., status: 25 };        // intended every 10
    CRON_PHASES       = { '*/10 * * * *': ['status'], ... };

    // wrangler.toml
    crons = ["*/10 * * * *", "15 */2 * * *", "20 10 * * *"]

**`ingestFn` is injected rather than imported** because on `ufc-injuries-v1`
`scripts/news/ingest_news.mjs` still calls `main()` at import time with no CLI
guard — importing it would start a live ingest as a side effect of loading the
module. The Worker-callable version lives on the newsroom branch, and forking
it here would leave two branches editing the same lines, which is exactly the
integration collision this review already caught once with the migration
version. So the capability is declared and passed in; without it the pass runs
its other two steps and **reports `ingest.available = false` with a note that
freshness is bounded by whatever else writes the table**, rather than claiming
a ten-minute SLA it does not have.

### Two things the wiring must get right

**A separate single-flight lock.** The newsroom's Durable Object serialises
invocations, so a four-minute writer run would make the next ten-minute status
trigger stand down — status latency would silently become a function of writer
duration. The status pass needs its own lock id (`idFromName('newsroom-status')`),
or the decoupling is only on paper.

**Phase order and containment.** `status` runs before `write` in `PHASES`, so a
status result is recorded before the writer starts; and phase failures are
already contained individually, so a desk outage cannot stop the newsroom
knowing who is out. Within the pass itself the three steps are contained
separately too: a dead feed host still leaves extraction and the lifecycle
running, so a stale withdrawal does not survive an unreachable publisher.

## Lifecycle maintenance

The three states:

* `active` — current, as far as our sources say.
* `resolved` — a later sourced event ended it; `resolved_by_event_id` points at it.
* `expired` — the card it concerned has passed with nothing resolving it. History, not a present-tense claim.

`supersedes_event_id` chains a correction — a follow-up naming the injury the
first report did not — without overwriting anything in place.


`scripts/status/lifecycle_pass.mjs` (decisions in `lib/lifecycle.mjs`, pure and
testable without a database). Two honest ways for a present-tense claim to stop
being true, and deliberately no third:

* **Resolution** — a later *sourced* `cleared` or `return` for the same fighter,
  strictly later, where the relationship is unambiguous: exactly one open
  candidate, or every open candidate shares the resolver's card. Two open
  statuses of different kinds and a vague clearance resolves **nothing** and is
  reported ambiguous, because guessing either declares a suspended fighter
  eligible or leaves a healed one injured. A *reported* clearance never lifts a
  suspension; only a `commission` source does.
* **Expiry** — a card-specific status whose event date has passed. An unknown
  event date is not evidence the event happened.

**A status tied to no card NEVER expires by time, at any age.** Nothing in the
passage of time tells us a fighter recovered, and a "cleanup" job that aged out
old injuries would be making a medical claim by omission — the fighter would
silently become available on our site with no source saying so. Tested at one
month, one year and five years.

Nothing is deleted. Both transitions are state changes on rows that stay put,
so a fighter's history keeps the event, its source, and the card it was about.
`grant` deliberately withholds `delete`, and a schema test asserts it.

The current-status view carries the same rule **independently of the job**: it
joins `ufc_events` and excludes card-specific rows whose card has passed,
whatever the stored state says. A scheduled pass can be late, fail, or be
switched off, and if it is the only thing standing between a withdrawal from a
March card and today's availability page, one missed run publishes a false
present-tense claim about a named athlete.

## Reading the backfill

`scripts/status/backfill_status_events.mjs` has **no insert path at all**. It
answers, before a single row exists: how many status events our archive
contains, how many resolve to a fighter/event/bout, how many are ambiguous, and
**what the wrong ones look like**. That last section is drawn from the highest
confidence rows — the ones most likely to be believed — and prints each
headline in full so a human can check the claim against the sentence.

Two rules came directly out of reading that output against real data:

* **Ambiguous means emit nothing.** "Shevchenko injured; Silva-Wang set for
  UFC 332" links Silva and Wang, and an earlier version filed *both* as
  injured. There is no review queue between the extractor and the page, so
  "emitted for review" means "published".
* **The subject can be someone the linker never resolved.** In that same item
  Shevchenko was not linked at all, so a "single named fighter" fallback picked
  a bystander. Position decides the subject, and when position cannot answer,
  nothing is recorded.
