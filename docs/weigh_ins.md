# Weigh-ins — a structured live desk

Built on the fighter-status foundation (`ufc-injuries-v1`), because `weight_miss`
is already a first-class status type and the ten-minute status pass already
separates freshness from article generation. Weights, though, are **their own
dataset**: `ufc_weigh_in_results`
(`supabase/migrations/20260908000013_ufc_weigh_ins.sql`, **not applied**).

Renumber to `…000012` or later during final integration if production has moved
past `…000011` — the status migration and this one must land in that order,
since this one adds a column to `ufc_fighter_status_events`.

## The rule that outranks coverage

> **Never infer a contracted limit.**

A weight class is not a limit. A lightweight **title** fight is 155 lb; a
**non-title** lightweight bout is 156 because of the one-pound allowance; a
**catchweight** is whatever two camps agreed and is frequently never published.
Deriving "over by 2.5" from a division name produces a number that is wrong
exactly when it matters most — a named athlete shown as missing by a pound they
did not miss by, on a page people bet against.

`limit_basis` records where every limit came from:

| basis | when | over_by_lbs |
|---|---|---|
| `sourced` | the source stated the contracted figure | computed |
| `division_rule` | standard division **and** known title status | computed |
| `unsupported` | catchweight, open weight, unknown division, unresolved bout | **always null** |

A source that says "missed weight" with no number gives `result='missed'` with
`official_weight_lbs`, `contracted_limit_lbs` and `over_by_lbs` all null. The
miss is real; the arithmetic is not available; the page says which. Enforced by
`weighin_over_by_needs_inputs` at the database, `resolveLimit`/`evaluateWeight`
in the collector, and `deltaCell` in the UI — which deliberately **cannot**
compute a delta, so a page can never produce a figure the database refused.

## Source adapters, and expected latency

Priority order is official → commission → news, and `SOURCE_RANK` in
`weights.mjs` uses it to resolve two sources disagreeing at the same attempt.
Both readings are kept either way; the loser is `superseded_at`, and the row is
marked `is_correction` so the desk can say a correction happened rather than
silently swapping a number.

| # | adapter | kind | what it is | realistic source→page latency |
|---|---|---|---|---|
| 1 | `ufc-official-weigh-ins` | `official` | The UFC.com event page's weigh-in results block, published the morning of the scale. The only surface that reliably states a **catchweight's agreed figure**. | Publisher lag ~10–25 min after the scale, plus ≤3 min collection, plus ≤15 s page cache → **~11–28 min** |
| 2 | `commission-results` | `commission` | NSAC / CSAC / FSAC official weights, HTML or PDF depending on jurisdiction. Slowest and most decisive; where a contracted limit is actually written down. | Often **post-event**; use for corrections and limits, not for live |
| 3 | `wire-weigh-in-report` | `news` | The five publishers already in `ufc_news_sources`, read out of `ufc_news_items`. **No new fetcher and no new politeness budget** — the newsroom ingest already fetches them, with the same fighter/event/bout linking policy. | Publisher lag ~2–8 min, plus ≤3 min collection → **~5–11 min**, and the most likely to need a correction |

**In practice the wire wins the race and the official source wins the record.**
A miss usually appears on MMA Fighting or MMA Junkie within a few minutes and on
UFC.com a quarter of an hour later with the exact figure; the desk shows the
wire reading first and replaces it with the official one as a visible
correction. That is the intended behaviour, not a defect.

### What is implemented, and what is not

The **parsers are real and tested** (`parseUfcOfficial`, `parseCommissionTable`,
`parseWireItem`, `matchFighter`). The **fetchers are behind an injected
`fetchImpl`, and this branch supplies none** — `parseWeighInSources` returns
zero readings and says `no source was contacted`. Pointing a live scraper at a
publisher from a read-only branch is the one part of this feature that touches
the outside world, and it should be turned on deliberately, not as a side
effect of a dry run.

### Never from commentary, never from a picture of a scale

There is no adapter that could produce a weight from a broadcast still or from
"he looked drained". Every adapter extracts a figure its source published as
text and stores that text in `raw_text`. Name matching is restricted to
**fighters booked on this card**, and an ambiguous surname on one card attaches
to nobody — a weight on the wrong athlete is worse than a missing row.

## Cadence, and why a fast trigger is still cheap

`scripts/weighins/weighin_pass.mjs`, cadence decided by `lib/window.mjs`:

| mode | when | cadence | cost |
|---|---|---|---|
| `live` | 40 h to 2 h before the card — spans weigh-in morning | **3 min** | 1–2 source fetches |
| `watch` | fight week, outside the scale window | 30 min | 1–2 fetches |
| `idle` | otherwise | 12 h | **one indexed query, zero fetches** |

The window decision happens **before any source fetch**, which is what makes a
one-minute Cloudflare trigger affordable: out of window the pass costs a single
query for the next event date and stops. `--force` bypasses the gate for an
operator, never for a scheduler.

### Its own single-flight identity

`LOCK_ID = 'weigh-ins'`, not `'newsroom'`, and its ledger rows carry
`worker='ufc-weigh-ins'`. The newsroom's Durable Object serialises its own
invocations, and a four-minute editorial sweep holding that lock would silence
the desk for the exact ninety minutes the feature exists for. A live desk
cannot queue behind a batch writer.

### No model, no articles, no DNA

The pass imports none of `write_articles.mjs`, `polish_world_class.mjs`, any
Anthropic transport, or the DNA builder — asserted by walking the transitive
import graph in `lib/pass.test.mjs`, which also fails if any module in that
graph contains a model endpoint. The structured line

> `Jose Miguel Delgado — 148.0 lb — MISSED by 2.0 lb`

is built from stored fields by `summaryLine`/`updateLine` and is reproducible
six months later. Editorial publication stays on its own cadence.

## Browser polling

The page polls **our route only**, every 15 s, and only while something can
still change (`pending > 0`); it stops when the tab is hidden and on a finished
card. It never contacts a publisher: fanning out from every reader would
multiply that site's load by our readership and make freshness depend on the
visitor's network.

**Fifteen seconds is not the freshness.** It bounds cache staleness; the source
is read every three minutes. The header therefore shows `last_source_update`
from the database — the publisher's own timestamp — not the time the page
rendered.

## Corrections and the audit trail

Corrections are **new rows** with `supersedes_id`; nothing is overwritten and
no `delete` is granted to anyone. `ufc_weigh_in_current` is the projection with
corrections applied; `ufc_weigh_in_history` keeps every reading ever taken,
including the superseded ones, which is what the live timeline renders.

Ordering: attempt number first (a second trip to the scale beats the first
regardless of clock skew), then source authority, then time.

## Status integration

A sourced miss mirrors into `ufc_fighter_status_events` as `weight_miss`, with
`event_id`, `bout_id`, source provenance and a deterministic `status_detail`.
Exactly once, enforced by a partial unique index on `weigh_in_result_id` — a
replaying pass cannot mint a second claim about a named athlete.

**No medical inference.** A missed cut is not an illness or an injury; the
mirrored event carries no `injury_type`, `body_part`, `injury_side` or
`clinical_quote`, and a test asserts those keys are absent.

The status table is **not** canonical storage for weights. It records the
availability consequence; the measurement lives here.

## Access control

Same posture as the status migration: all three views are
`security_invoker = true`, `anon`/`authenticated` are explicitly revoked on the
table and every view, `service_role` keeps `select`/`insert`/`update`, and
**nobody is granted `delete`** — a corrected weight must stay answerable.

## API

`GET /v1/weigh-ins` (also `/v1/ufc/weigh-ins`) with `?event_id`, `?fighter_id`,
`?status`, `?since`, and `GET /v1/ufc/events/{id}/weigh-ins?include=history`.
Read-only; every non-GET method is refused. `?since` filters on **our**
`detected_at`, not the publisher's timestamp, so a source that back-dates
cannot hide a change from a poller. Every response carries a `contract` note
stating that a null limit means unpublished, not a division default.
