# Fighter status — availability as structured data

Not "injuries". The product question is **is this fighter available, for which
bout, since when, and who says so** — and a visa refusal removes someone from a
card exactly as an ACL does. The model is `ufc_fighter_status_events`
(`supabase/migrations/20260908000010_ufc_fighter_status.sql`, **not applied**).

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

## Collector cadence, and why it is not part of the writer

`scripts/status/collect_status_events.mjs` is a separate entry point, callable
as `collectStatusEvents(env, opts)` from the `ufc-newsroom` Worker on a **5–15
minute** trigger. It must not be coupled to article publication:

* **Opposite cadences.** Publication is expensive and fine every couple of
  hours. A main-event withdrawal is worth knowing in minutes and costs one
  query and some regexes.
* **Opposite failure modes.** If the editorial desk is down the newsroom should
  still know who is out. If status extraction throws on a malformed item, the
  day's articles must still publish.
* **Overlapping window.** Every pass re-reads the last `--since-hours` of news,
  so an item that arrives late, is edited, or is linked to a fighter only after
  a later fighter load still gets a second look. Re-reading is free because
  `fingerprint` makes a repeat a no-op at the database rather than a judgement
  in the client.

Writing is opt-in (`--write`). The default is a dry run, and the migration is
unapplied, so the write path is currently unreachable in every environment.

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

## Lifecycle

* `active` — current, as far as our sources say.
* `resolved` — a later sourced event ended it; `resolved_by_event_id` points at it.
* `expired` — the card it concerned has passed with nothing resolving it. History, not a present-tense claim. An unresolved withdrawal from last March is not a fighter who is out today.

`supersedes_event_id` chains a correction (a follow-up naming the injury the
first report did not) without overwriting anything in place.
