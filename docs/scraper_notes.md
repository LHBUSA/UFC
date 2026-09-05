# UFC scraper notes

Living document. Every deviation from the kickoff brief that was found against
the live sources goes here, with the date it was observed, plus the decisions
taken on it.

## Decisions (Justin, 2026-09-05)

| Topic | Decision |
|---|---|
| Historical backfill | From the Internet Archive, not live. `backfill_ufcstats.py --source wayback` (default). <=1 req/2s, exponential backoff on 429, resumable via the local HTML cache. ufcstats.com is never contacted. |
| Weekly incremental (Worker) | Solve the ufcstats.com proof-of-work in the fetch layer, keep the cookie, 1 req/s. Abort + loud Discord if the challenge shape changes, the endpoint moves, or difficulty exceeds `MAX_POW_DIFFICULTY` (4). |
| Schedule / results source | ESPN's public MMA API is primary for events, bouts, results and fighter identity. UFC Stats supplies per-round stats only. |
| Supabase | `tkmlnhmylqnttmnsnief` (NFL instance). UFC stays off `rlfyavnhbngwbldebrid` (MLB + PropData). |
| Aliases | `unique(fighter_id, source, normalized)`; the resolver returns every candidate, never merges on name alone. |

## 2026-09-05 — ufcstats.com is no longer static HTML

The brief says: "Static HTML, no JS, no auth." That was true for years. It is
not true as of 2026-09-05.

Every request to `ufcstats.com` (both `http://` and `www.`) from a plain HTTP
client returns HTTP 200 with a ~3 KB interstitial instead of the page:

```
<title>Loading…</title><meta name="robots" content="noindex">
<p>Checking your browser…</p>
<noscript>This site requires JavaScript.</noscript>
```

The page carries an inline JavaScript proof-of-work: a pure-JS SHA-256, a
server-issued `nonce`, and a loop that finds an integer `n` such that
`sha256(nonce + ':' + n)` starts with two hex zeros (difficulty 2, ~256
hashes). It then POSTs `nonce` and `n` as a form body to `/__c` and reloads.

Response headers on the interstitial: `Server: nginx/1.10.1`,
`Cache-Control: no-store, no-cache, must-revalidate`. `/robots.txt` is 404.
`https://` on the bare host does not connect.

The Worker's fetch layer (`workers/ufc-stats-ingest/src/ufcstats.mjs`)
implements exactly this handshake and nothing more adaptive. The exact
script shape it accepts is pinned by three regexes; the test file
`ufcstats.test.mjs` proves that renaming the variable, moving the endpoint,
changing the payload, or raising difficulty past the limit all abort.

Open item: the cookie name/lifetime set by `/__c` has not been observed yet
(no live solve has been run). The first Worker run will record it in the
run notes.

## Internet Archive (backfill source)

Snapshots exist for every page family. Availability API answers observed:

| Page | Closest capture to 2026-09-01 |
|---|---|
| `/statistics/events/completed?page=all` | 20260216225116 |
| `/statistics/events/upcoming` | 20260801022834 |
| `/statistics/fighters?char=a&page=all` | 20260219234617 |
| `/statistics/fighters` | 20260425053449 |

Throttling: after a burst of ~8 requests, `web.archive.org` (page fetches AND
the CDX API) returned HTTP 429 for every request for the rest of the session
(>1 h), including for unrelated URLs. `archive.org/wayback/available` kept
answering 200. `wayback.py` therefore starts at 2 s spacing and backs off
from 30 s doubling to 10 min on 429. Expect the full backfill (roughly 700
events + 8k fights + 4.5k fighters, one fetch each) to take on the order of
10 hours of wall clock at that pace, longer with 429 pauses.

Coverage is not guaranteed: a fight or fighter page with no capture is
counted as `wayback_missing_*` and listed in the run notes. Those gaps are
what the Worker's live path (or a later gap-fill run) has to close.

## ESPN MMA API (schedule / results source)

Verified live 2026-09-05. No auth, no challenge. `site.api.espn.com` returns
403 to non-browser clients; the two hosts below do not.

### Endpoints

| Purpose | URL |
|---|---|
| Event list for a year | `https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events?dates=2025&limit=200` -> `items[].$ref` (52 events for 2025) |
| Event with inline competitions | `.../leagues/ufc/events/{eventId}?lang=en&region=us` |
| Competition status (result lives here) | `.../events/{eventId}/competitions/{compId}/status` |
| Officials (referee) | `.../events/{eventId}/competitions/{compId}/officials` |
| Plays (round-by-round play log; not used) | `.../competitions/{compId}/plays` |
| Athlete | `https://sports.core.api.espn.com/v2/sports/mma/athletes/{athleteId}` (also under `/leagues/ufc/athletes/{id}`) |
| Athlete records | `.../athletes/{athleteId}/records` -> `items[]` with `name: "overall"`, `summary: "16-2-0"` |
| Whole-card scoreboard (one call, no result method) | `https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=YYYYMMDD` |

### Fields used

Event: `id`, `name` ("UFC Fight Night: Hooker vs. Parnasse"), `shortName`,
`date` (UTC, e.g. `2026-09-05T16:00Z`), `status.type.{name,state,completed}`,
`venues[0].$ref` -> `{fullName, address.{city,state,country}}`,
`competitions[]`.

Competition: `id`, `matchNumber` (1 = MAIN EVENT, counting down the card;
competitions are listed last-fight-first. Verified on event 600056266:
matchNumber 1 = Kape vs Royval. `bout_order` = n + 1 - matchNumber so the
main event stays highest), `description` ("3 Rnd (5-5-5)" -> `time_format`),
`format.regulation.periods` (scheduled rounds), `type.text` (weight class,
long form: "Women's Strawweight"; the scoreboard's `type.abbreviation` is
"W Strawweight"), `cardSegment.description` ("Main Card" | "Prelims" |
"Early Prelims" -> `card_position`), `competitors[2]` with `id`
(= athlete id), `order`, `winner`, `athlete.$ref`, `record.$ref`,
`status.$ref`, `officials.$ref`.

Status: `type.name` (`STATUS_SCHEDULED`, `STATUS_FINAL`, ...), `period`
(= final round), `displayClock` ("4:27" = time of stoppage; "5:00" for
decisions), `result.displayName` (method), `result.description` (finish
detail: "Punches", "Armbar", "Elbows"), `result.target.description`
("Head").

`result.displayName` values seen across 6 events (74 bouts): `Decision -
Unanimous`, `Decision - Split`, `KO/TKO`, `Submission`, `Draw`, `TKO -
Doctor's Stoppage`. All mapped in `shared/enums.json`; anything else is a
schema assertion.

Athlete: `id`, `fullName`, `displayName`, `firstName`, `lastName`,
`dateOfBirth` ("2001-08-04T07:00Z"), `height` (inches, float), `reach`
(inches), `weight` (lbs), `stance.text` ("Orthodox"), `weightClass.text`,
`active`, `citizenship`, `association.name` (gym). `nickname` is not
present on the athletes sampled; treated as optional.

### Identity linking

ESPN athlete ids and UFC Stats ids are unrelated. The Worker links them
with `shared/alias_resolver` using name + DOB (both sources publish DOB) or
name + record. An ESPN athlete that resolves to nothing becomes a new
espn-first `ufc_fighters` row; one that is ambiguous ALSO becomes a new row
and lands in `ufc_alias_review_queue`. A duplicate row is recoverable by a
manual merge; a wrong merge is not.

Events are matched ESPN <-> UFC Stats by date within +-1 day (ESPN dates are
UTC; UFC Stats prints US-local dates). Two candidate events on the same
day is recorded as `EventMatchAmbiguous` and left for a human.

## UFC Stats selector hypothesis (from the brief, unverified)

Kept here so the verification pass has something concrete to diff against.

| Page | Expectation |
|---|---|
| `/statistics/events/completed?page=all` | table rows: name link `/event-details/{16hex}`, date, location |
| `/statistics/events/upcoming` | same shape |
| `/statistics/fighters?char=a&page=all` | first, last, nickname, height, weight, reach, stance, W, L, D, belt |
| `/event-details/{id}` | rows in card order, main event first; W/L, two fighter links, KD, STR, TD, SUB, weight class, method (2 lines), round, time; row link `/fight-details/{id}` |
| `/fight-details/{id}` | header names/links + W/L; weight-class line; Method / Round / Time / Time format / Referee / Details; Totals table + per-round; Sig. strikes table + per-round; two `<p>` per cell |
| `/fighter-details/{id}` | name, nickname, `Record: W-L-D (n NC)`; Height/Weight/Reach/Stance/DOB; SLpM … Sub. Avg.; fight history table |
