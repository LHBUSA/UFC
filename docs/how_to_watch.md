# How to Watch — UFC start times and broadcast carriers

**Owner:** the `ufc-broadcast-schedule` Cloudflare Worker, on a Cloudflare Cron
Trigger. **Not** GitHub Actions, **not** Vercel cron. The repository's
`.github/workflows` is not involved in this lane and must not become involved.

```
Cloudflare Cron (*/30)  ->  ufc-broadcast-schedule  ->  https://www.ufc.com/events
                                       |
                                       v
                          Supabase: ufc_event_broadcasts
                                       |
                        (read-only, cached, never a live fetch)
                                       v
                 Next.js on Vercel: event page, homepage, /api/ufc/*
```

A reader's page load never touches UFC.com. That is the whole reason the Worker
exists: the promotion's website must not be able to slow down, or break, a
PropBetEdge page.

---

## The source, and why it is trustworthy

`https://www.ufc.com/events` carries the start times as **unix epoch seconds**
in stable data attributes, because UFC's own client-side timezone widget needs
them:

```html
<div class="c-card-event--result__date tz-change-data"
     data-main-card="Sat, Sep 12 / 5:00 PM EDT"
     data-main-card-timestamp="1789246800"
     data-prelims-card-timestamp="1789236000"
     data-early-card-timestamp="">
```

and the per-row "How to Watch" overlay carries the same epochs again, one per
segment, each next to that segment's carriers:

```html
<div class="c-listing-viewing-option__fight-card">Main Card</div>
<div class="c-listing-viewing-option__time" data-timestamp="1791072000">8:00 PM EDT</div>
<a href="https://ufc.ac/...">Watch On Paramount+</a>
<a href="https://www.cbs.com/live-tv/stream/tveverywhere/">Watch on CBS</a>
```

We parse the **epoch**, never the rendered `"8:00 PM EDT"` string. The rendered
string is a derived display of the same number and is exactly the thing that
breaks across a daylight-saving boundary.

The brief asked for JSON-LD or a public data endpoint first. UFC.com publishes
neither on `/events` (verified 2026-09-12: zero `application/ld+json` blocks, no
public schedule API). The epoch attributes are better than either for this
purpose — machine-readable and timezone-unambiguous, straight from the
promotion.

One extra fetch per **new** slug hits the event page for its branded name,
because the listing only prints the matchup:

```html
<title>Noche UFC: Silva vs Delgado | UFC</title>
```

Steady-state detail fetches per pass: **zero**. Capped at 4.

### Known fragility

This is DOM parsing and it is pinned to four markers:

| marker | used for |
|---|---|
| `l-listing__item` | splitting the page into event rows |
| `c-card-event--result__headline` | slug + headline |
| `data-*-timestamp` | the canonical instants |
| `c-listing-viewing-option` | per-segment times and carriers |

A Drupal theme change can move any of them. The mitigations are structural, not
hopeful:

* every extractor returns `null` rather than guessing;
* `parseEventsPage` reports `rows` / `recognised` / `unrecognised` / `upcoming`;
* the pass **refuses to write** when the recognised upcoming count falls below
  half of what was previously known (`COLLAPSE_RATIO`, rounded up) — cards leave
  the upcoming list one at a time, so losing half of them at once is a markup
  change, never a schedule;
* a refused pass leaves every stored row untouched and logs a `failed` run.

Other things observed on the live source and handled deliberately:

* `data-early-card-timestamp=""` (empty, not absent) on cards with no early
  prelims → stays `null`, never a 1970 timestamp.
* A card's UTC date and its **Eastern** date differ for any main card after
  20:00 ET. `event_date` is computed with `Intl` in `America/New_York`, which is
  the convention UFC itself and our `ufc_events` both use.
* International cards (Abu Dhabi, Edmonton) still publish US Eastern times on
  this edition; the stored instant is correct regardless.
* Ticket links (`ticketmaster`/`seatgeek`/`axs`) sit in the same markup as watch
  links. `providerFromLabel` rejects them by label so no card ever gets a
  broadcaster called "Tickets".

---

## Data model

`ufc_event_broadcasts`, one row per UFC.com event, keyed by the **promotion's
own slug** rather than by `ufc_events.id`:

* UFC.com publishes cards before our schedule source does, so the natural key
  has to exist without a local event;
* a mis-match must degrade to an unlinked row, never a wrongly attached one.

`event_id` is nullable and set only on a confident match (`match_status` is
`matched` / `unmatched` / `ambiguous`). Two events on one date are resolved by
name overlap or not at all — a wrong link puts the wrong start time on a card
page, which is worse than no start time.

**`broadcasts` is a JSONB array, never a single `network` string.** UFC 332
already carries three: Paramount+, UFC Fight Pass and CBS.

```json
{
  "provider": "CBS",
  "region": "US",
  "type": "tv",
  "watch_url": "https://www.cbs.com/live-tv/stream/tveverywhere/",
  "segments": ["main_card"]
}
```

* `type` comes from a **closed** list. An unrecognised carrier keeps the name
  UFC.com printed and gets `type: null`. A guessed type on the next broadcast
  deal would be a fabricated fact in a field that looks authoritative.
* `region: "US"` records *which edition stated this* — we pin to the US edition
  of `ufc.com/events`, whose times are printed in ET and whose carriers are the
  US carriers. It is not a claim about rights in any other territory. The row
  also carries `source_edition`.

### The two timestamps

| column | moves when |
|---|---|
| `verified_at` | **every** successful authoritative verification, changed or not |
| `last_changed_at` | **only** when the comparable content actually changes |

They must never collapse into one field. A UI that says "updated 4 minutes ago"
after every cron is lying about the card; one that says "updated 6 days ago"
because nothing changed is lying about the check.

`content_hash` is SHA-256 over `COMPARABLE` only — the card facts. Parser
version, source URL and the ticket link are deliberately excluded, so bumping
the parser never reads as "the main card moved".

`ufc_event_broadcast_changes` is the field-level ledger: `last_changed_at` says
*that* something moved; this says *what*, typed as
`time` / `broadcast` / `venue` / `identity` / `new`.

---

## Cadence

Cron fires every 30 minutes. The **wake** rate is not the **fetch** rate; the
pass decides, cheaply, whether work is due. An idle wake costs two indexed
queries and zero upstream fetches.

| mode | when | min interval |
|---|---|---|
| `live` | inside the broadcast window (first segment → main card + 5h) | 30 min |
| `day` | under 6 h to the main card | 30 min |
| `near` | under 24 h | 60 min |
| `week` | under 8 days | 6 h |
| `idle` | anything else, or nothing scheduled | 12 h |

Measured against the **main card instant**, not the calendar date: a card at
01:00 UTC Sunday is an event-day card all through Saturday evening US time, and
a date comparison gets that wrong.

---

## Failure behaviour

| condition | result |
|---|---|
| fetch times out | `upstream_failed`. **No** write to the schedule. Rows keep every field; only their age moves. Run logged `failed`. |
| non-200 | same |
| markup unrecognised | `parser_unrecognised`. Fail closed, same preservation. |
| parse collapses partially | `parser_unrecognised`. Refused. |
| one malformed row | dropped and counted (`counters.malformed`); every other row writes normally |
| detail fetch fails | degrades to the listing headline; the pass still succeeds |
| duplicate invocation | the cadence gate returns `skipped` before any fetch; a genuinely concurrent pass is stopped by the `broadcast-schedule` Durable Object lock |
| identical content | one bulk `PATCH` of `verified_at`. No change rows, no `last_changed_at` movement. Idempotent. |

A stale `verified_at` is **visible in the UI** rather than hidden: the tick turns
gold and the wording changes to "Last verified from UFC.com".

---

## API

Both read our cached rows. Both are `force-dynamic` with a short shared edge
cache, deliberately **not** statically prerendered — "is there an upcoming
event" is an existence question, and a build-time answer to it is wrong at
exactly the moment it flips.

### `GET /api/ufc/next-event`

```json
{
  "ok": true,
  "data": {
    "event_id": "…", "ufc_slug": "ufc-332",
    "event_name": "UFC 332: Silva vs Wang",
    "event_date": "2026-10-03",
    "venue": "Delta Center", "location": "Salt Lake City, UT, United States",
    "early_prelims_start_utc": "2026-10-03T20:00:00.000Z",
    "prelims_start_utc": "2026-10-03T22:00:00.000Z",
    "main_card_start_utc": "2026-10-04T00:00:00.000Z",
    "segments": [{ "key": "main_card", "label": "Main Card", "utc": "2026-10-04T00:00:00.000Z" }],
    "broadcasts": [{ "provider": "CBS", "region": "US", "type": "tv", "watch_url": "…", "segments": ["main_card"] }],
    "linkable_broadcasts": [],
    "ufc_event_url": "https://www.ufc.com/event/ufc-332",
    "tickets_url": "…",
    "source": "UFC.com", "source_url": "https://www.ufc.com/events",
    "verified_at": "…", "last_changed_at": "…"
  },
  "meta": { "state": "upcoming", "stale": false, "parser": "…", "generated_at": "…" }
}
```

No upcoming card returns `200` with `data: null` and a reason — a `404` would
read as "this endpoint is broken".

### `GET /api/ufc/schedule?limit=20&include=upcoming|all`

Same rows as a list, plus `meta.oldest_verified_at` and `meta.any_stale`, which
are the real freshness of the payload.

---

## Time handling

Canonical values are UTC and only UTC. **No ET/PT display string is ever the
stored truth.**

Every localized string comes from `Intl.DateTimeFormat` with an IANA timeZone.
There is no hour arithmetic anywhere in this feature and there must never be:
"ET minus one hour" is wrong in Arizona, wrong across every DST boundary, and
wrong for every viewer outside North America.

The server renders in `America/New_York` — a correct value in its own right, not
a placeholder — and the client re-formats the same instant in the visitor's
resolved zone on mount. The first client render returns the server string, so
hydration matches; the time value sits in a reserved line box, so the swap
changes glyphs and never geometry.

---

## Frontend

| surface | component |
|---|---|
| event page, under the poster | `HowToWatchPanel` in `web/components/HowToWatch.tsx` |
| homepage next-event card | `WatchStrip`, same file |
| timezone swap, countdown, freshness | `web/components/HowToWatchClient.tsx` (`"use client"`) |
| styling | `web/app/how-to-watch.module.css` |

The countdown ticks client-side every 30 s off a UTC instant the server already
sent. It never calls the API.

The ten designed states are enumerated in the header comment of
`HowToWatch.tsx`. The two that matter most for honesty:

* **broadcaster unknown** → a sentence saying UFC.com has not published one.
  No CTA is invented and no affiliate link is ever manufactured.
* **carrier named but no destination** → the carrier is printed, visibly not a
  button. We say who carries it; we do not fabricate a link.

### Structured data

The event page's `SportsEvent.startDate` is upgraded from a bare date to the
verified main-card **instant** when one exists, and `endDate` is then dropped
rather than invented — we do not know when a card ends.

Broadcaster is deliberately **not** published in schema.org. A `BroadcastEvent`
over a `BroadcastService` asserts considerably more than "UFC.com listed this
carrier on the US events page". We link the official page and claim nothing we
have not verified.

---

## Deployment

Migration first, then the Worker.

```bash
# 1. schema  (Supabase SQL editor, or the project's usual migration path)
#    migrations/016_ufc_event_broadcasts.sql
#    supabase/migrations/20260912000001_ufc_event_broadcasts.sql

# 2. secrets  (once)
cd workers/ufc-broadcast-schedule
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ADMIN_TOKEN

# 3. build check, then deploy
npm run build:check
npx wrangler deploy

# 4. prove it
curl https://ufc-broadcast-schedule.<subdomain>.workers.dev/health
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://ufc-broadcast-schedule.<subdomain>.workers.dev/run?dry=1&force=1"   # no writes
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://ufc-broadcast-schedule.<subdomain>.workers.dev/run?force=1"         # first real fill

# 5. confirm the Cron Trigger is live
npx wrangler triggers deploy          # if the schedule needs (re)publishing
# then: Cloudflare dashboard -> Workers -> ufc-broadcast-schedule -> Settings -> Triggers
```

The frontend deploys through its existing Vercel project, unchanged. Nothing
about this feature moves the frontend off Vercel or the scheduling off
Cloudflare.

### Tests

```bash
cd workers/ufc-broadcast-schedule && npm test        # parser, normalize, window, pass
cd web && node --experimental-strip-types --test lib/broadcast-display.test.ts
```
