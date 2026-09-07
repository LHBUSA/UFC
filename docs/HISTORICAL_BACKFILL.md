# Historical backfill: two lanes, two coverage numbers

The UFC archive has two different holes, and one number cannot describe both.

**Structural coverage** asks whether the fight exists at all: does the event
have bout rows, results, fighters and a referee assignment?

**Round-stat coverage** asks how deep a bout we already hold is: are there
per-round strike, takedown and control rows for both corners?

Reporting a single "coverage %" hides whichever hole is larger. Both numbers
are reported from here on.

## What the audit found

`scripts/backfill/structural_audit.mjs` (read-only, no network — Wayback state
comes from the backfill's own cached CDX index):

| Range | Events | UFC Stats id | Wayback capture | Events with bouts |
|---|---|---|---|---|
| 1994–2016 | 384 | 384 | 384 | **0** |

Every event from UFC 2 through the end of 2016 exists as a row, carries a UFC
Stats id and is archived — and none of them has a single bout. That is not
shallow data. It is a missing fight graph: no bouts, no results, no historical
fighters, no referee assignments.

It also explains a reporting defect the referee pages had. John McCarthy showed
9 assignments, which read as a career total for the sport's most recognisable
official. It was archive coverage. Backfilling one event, UFC 2, moved him to
24 and his first archived assignment to 1994-03-11.

`scripts/backfill/coverage_audit.mjs` reports the round-stat side, which is a
different and mostly modern problem (2017–2019 sat at 0%, 2020–2023 near 4%).

## Lane A — round-stat depth

Years that already have bouts but thin per-round data, newest first, because
recency is what the product surfaces: 2025, 2024, 2023–2020, 2019–2017.

## Lane B — structural breadth

1994–2016, where the whole chain has to be created:

    event -> bouts -> fighter identity -> result -> referee -> round stats

Round stats are the last step and an optional one. UFC Stats has no per-round
data for much of the 1990s, and a bout must not be rejected for lacking it. A
1994 result with a referee and no round stats is correct and useful; a missing
one is not.

Fighter identity is the step that can do lasting damage. The engine resolves
each UFC Stats fighter against existing rows by canonical id, alias, date of
birth and record. An ambiguous same-name match goes to
`ufc_alias_review_queue`, never a silent merge, and a fighter whose page has no
archived capture becomes a UFC Stats-keyed stub that stays separate until it
can be resolved. Duplicates are worse than gaps.

DWCS and Contender Series stay out of both lanes and get their own pass.

## Running it

`scripts/backfill/run_backfill_queue.ps1` walks both lanes as one detached
sequential queue, one year per window, appending a summary line per window to
`logs/queue_status.txt`.

Sequential is deliberate. Two concurrent jobs double the request rate against
the Internet Archive, and a rate-limited queue produces nothing. Windows are
re-runnable — an event whose bouts are all present and enriched is skipped
without a fetch — so a failed window costs only what it had not finished, and
the queue continues past it.

`--until` exists because `phase_fights` walks events newest-first. Without a
closed window, targeting an old year still spends the first requests on the
newest events, which for upcoming cards are not archived at all.

## After the queue

1. `node scripts/referees/sync-profiles.mjs` — the referee directory is
   `ufc_referee_stats` LEFT JOINed to `ufc_referee_profiles`, and that profiles
   table was seeded once at migration time. Every referee the backfill
   introduces would otherwise appear with a null slug and a broken profile
   link. The script also reports spelling variants as candidates and never
   merges two officials on string similarity alone.
2. `node scripts/hof/resolve-fighters.mjs` — Hall of Fame inductees whose
   canonical fighter row only exists once their era is loaded.
3. `node scripts/backfill/structural_audit.mjs` and
   `node scripts/backfill/coverage_audit.mjs` — report both numbers.

## What must not happen

A missing stat is NULL. A source that reported zero is 0. Nothing is inferred
from a page that does not state it, and a bout that cannot be sourced stays
absent rather than becoming a guess.
