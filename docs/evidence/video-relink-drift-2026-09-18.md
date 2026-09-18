# Video relink drift receipt — 2026-09-18

**Nothing was applied.** This is a dry-run audit of what a full
`node scripts/videos/ingest_youtube.mjs --relink` would rewrite today. No row,
link, status or Worker was changed to produce it.

Machine-readable companion: `video-relink-drift-2026-09-18.json` (one entry per
row: stored vs proposed event, fighters added/removed, status/confidence moves,
the resolver's evidence for a proposed event, and which side appears correct).

## How it was produced (reproducible, read-only)

```
node scripts/videos/ingest_youtube.mjs --relink --dry-run --explain --explain-out drift.json
node scripts/videos/relink_drift_report.mjs drift.json report.json
```

`--explain` is refused without `--dry-run`. The ingest has one write call and it
sits behind the dry-run `continue`; `relink_diff.mjs` does no I/O and
`relink_drift_report.mjs` only SELECTs event, fighter and bout names.
`linked_at` / `updated_at` are ignored at every depth, and jsonb key order is
normalised, so every counted row differs in a projected field.

Run at 2026-09-18T15:36Z on main `ec365df` + this tooling. Stored rows: 728.
Resolver window: events within ±45 days of the run date, 2026-08-04 .. 2026-11-02
(24 events, 174 bouts, 342 card fighters).

## Result

| | |
|---|---|
| rows a full relink would rewrite | **216** (512 unchanged; the 34 Hangul rows repaired earlier today plan no change) |
| HIGH risk | **99** |
| MEDIUM risk | **38** |
| LOW risk (metadata only) | **79** |
| rows where a consumer-visible link moves (event, bout, fighters, article, status) | 137 |

### Buckets (a row can be in several)

| bucket | rows | | bucket | rows |
|---|---|---|---|---|
| B event lost | **74** | | J article link changed | 13 |
| C event changed | **15** | | K confidence changed | 21 |
| A event gained | 2 | | L link status changed | 2 |
| E bout lost | 4 | | M review reason changed | 2 |
| D / F bout gained / changed | 0 / 0 | | N classification only | 0 |
| G fighters gained | 25 | | O TUF metadata only | 16 |
| H fighters lost | 10 | | P harmless normalisation | 63 |
| I fighters replaced | 0 | | `video_type` changes | 0 |

Confidence moves: `medium→none` 8, `none→low` 8, `high→medium` 4, `medium→low` 1.
Status moves: `published→review` 1, `review→published` 1.
Language: 29 rows gain a language that was never stored (`null→en` 13, `pt` 10,
`es` 3, `ko` 3); no stored language changes value.

## Root causes, measured

1. **A relink scores every stored video against the cards around TODAY, not
   around the day the video was published.** `main()` builds one context,
   `loadEventContext(now, ±45d)`, and uses it for all 728 rows; only `--playlist`
   backfills use `contextAt(archive, published)`. The rows it hurts are exactly
   the backfilled archive rows:
   - event lost: **74 of 74** have a stored event outside today's window;
   - event changed: **15 of 15** likewise; bout lost: **4 of 4** follow their event out.
   - In every sampled case the stored link agrees with the publish date (published
     0–3 days from the stored event).
2. **`nearest_date` has no distance limit.** Once the true card is invisible, a
   generic key still matches whatever card is in the window: `"ufc vegas"` (city)
   sends sixteen 2021 *UFC Vegas 35* videos to *UFC Fight Night: Gamrot vs Salkilld
   (2026-08-08)* at a recorded `distance_days` of **1,805–1,809**; `"contender
   series"` sends a 2017 *Contender Stories: Sean O'Malley* to *DWCS Season 10,
   Week 1* at **3,176** days. One of these would also move `review → published`.
3. **Surname uniqueness is evaluated in today's window.** 23 of the 25 fighter
   gains are `surname_unique_window` on rows older than 90 days. Fifteen *After TUF:
   Team McGregor vs Team Chandler* (2023) videos would gain **Chelsea Chandler**,
   who is on a 2026 card; the Chandler in the title is Michael.
4. **Description boilerplate.** Two UFC Paris Octagon Interviews would gain
   **Michael Bisping** — the interviewer, named only in the description.
5. **Alias resolver improved since these rows were linked** (the one genuine
   improvement). Eight recent rows carry a fighter attached through a nickname
   alias matching an ordinary phrase: `"main event"` → Ryan "Main Event" MacDonald
   (6 rows), `"the best"` → Tatsuro Taira, `"the fire"` → Kevin Burns. The current
   resolver drops all eight.
6. **Article coverage moved.** 13 rows, all ≤30 days old, would follow newsroom
   articles published since they were linked.
7. **Evidence wording only.** 42 rows differ only inside `source_metadata.linking`
   (a `method` label, `article_candidates` count, fighter order); 16 only in the
   TUF tag's rule label. **But 11 rows would drop `linking.event_rejected`**, the
   TUF series guard's record of an event it refused: the guard only runs on the
   backfill path, so a relink erases its audit trail without re-making the decision.

Not causes: event dedupe, new canonical events or new fighters account for no
measurable share; no `video_type` changes at all.

## Where the drift is

| video age | rows | high | medium | low |
|---|---|---|---|---|
| 0–7 days | 15 | 1 | 3 | 11 |
| 8–30 days | 47 | 7 | 12 | 28 |
| 31–90 days | 0 | 0 | 0 | 0 |
| > 90 days | **154** | **91** | 23 | 40 |

Oldest affected video 2012-05-31, newest 2026-09-16.

| channel | rows | high |
|---|---|---|
| UFC | 181 | 99 |
| UFC Brasil | 27 | 0 |
| UFC Espanol | 7 | 0 |
| ESPN MMA | 1 | 0 |

The HIGH-risk drift is historical (92% older than 90 days) and entirely on the
main UFC channel's backfilled archive. It is **not** recurring on current uploads:
the scheduled discovery run never relinks stored rows.

### Events producing event-link drift (stored → proposed)

| stored event | rows | proposed |
|---|---|---|
| The Ultimate Fighter: Tournament of Champions Finale (2016-12-03) | 18 | none |
| UFC Fight Night: Barboza vs. Chikadze (2021-08-28) | 16 | **Gamrot vs Salkilld (2026-08-08)** ×15, none ×1 |
| The Ultimate Fighter: Heavy Hitters Finale (2018-11-30) | 11 | none |
| TUF: Team McGregor vs. Team Faber Finale (2015-12-11) | 10 | none |
| TUF: Live Finale (2012-06-01) | 6 | none |
| TUF: Redemption Finale (2017-07-07) | 6 | none |
| TUF: A Champion Will Be Crowned Finale (2014-12-12) | 5 | none |
| TUF: A New World Champion Finale (2017-12-01) | 5 | none |
| UFC 194: Aldo vs McGregor (2015-12-12) | 3 | none |
| 8 other events, 2013–2023 | 9 | none |
| (no stored event) | 2 | Gamrot vs Salkilld (2026), DWCS S10 W1 (2026) |

Proposed side, in total: 74 → none, 16 → one 2026 Fight Night, 1 → one 2026 DWCS week.

## Manual samples (title, publish date, card, resolver evidence)

| bucket | video | stored | proposed | correct side |
|---|---|---|---|---|
| C | `URxf3OfvLGs` *Barboza vs Chikadze … Fight Preview, UFC Vegas 35* (2021-08-24) | Barboza vs. Chikadze, key `"barboza vs chikadze"` unique | Gamrot vs Salkilld 2026, `"ufc vegas"` nearest_date 1,809d | **CURRENT** |
| C | `bsMkdCm7vaA` *Bryan Battle Octagon Interview, TUF 29 Champion* (2021-08-29) | same 2021 card, 1 day after | 2026 card, 1,805d | **CURRENT** |
| B+E | `eFjeoPKi4UU` *TUF Finale: Montano vs Modafferi* (2017-12-01) | TUF 26 Finale + its bout, conf high | no event, no bout, conf medium | **CURRENT** |
| B | `V1dGOdJD2pA` *TUF Finale: Sean O'Malley Octagon Interview* (2017-12-02) | TUF 26 Finale | none | **CURRENT** |
| E+H | `0lynjftMb0s` *UFC Vegas 35: Barboza vs Chikadze Weigh-in* (2021-08-27) | 2021 card, bout, Barboza + Chikadze | 2026 card, no bout, both fighters removed | **CURRENT** |
| H | `AC7L5a1QvXU` *TUF Nations Finale: Kennedy & Bisping* (2014) | Bisping attached | Bisping removed | **CURRENT** |
| H | `H3DtCTuAnyY` *Pantoja vs Kai Asakura, FULL FIGHT* (2026-09-07) | + Ryan MacDonald via `"main event"` in description | removed | **PROPOSED** |
| H | `9nXqBaZO-rc` *The Best of Jean Silva* | + Tatsuro Taira via `"the best"` | removed | **PROPOSED** |
| H | `tWW7csCtSjM` *TOMMY GUN BRINGING THE FIRE* | + Kevin Burns via `"the fire"` | removed | **PROPOSED** |
| G | `B-s6Qk-lYcU` *After TUF: Team McGregor vs Team Chandler, Ep. 9* (2023) | — | + Chelsea Chandler (`surname_unique_window`) | **CURRENT** |
| G | `c44IaeD85Fg` *Salahdine Parnasse Octagon Interview, UFC Paris* | Parnasse | + Michael Bisping (description) | **CURRENT** |
| A+L | `gAMxiXJd-js` *Rise of Giga Chikadze* (2021) | no event, `review: multiple_events` | 2026 card, **published** | **CURRENT** |
| A | `2p_a5R40c2c` *Contender Stories: Sean O'Malley* (2017) | no event | DWCS S10 W1 (2026), 3,176d | **CURRENT** |
| L | `YMdY8z1njjU` *TUF Latin America: Alejandro "El Diablito" Perez* (2014) | published, no links | review `ambiguous_surname` | AMBIGUOUS |

Per-row verdicts (rule-derived from these samples; every rule is stated in the
JSON `why` field): **CURRENT 115 · EQUIVALENT 79 · AMBIGUOUS 14 · PROPOSED 8.**
Of the 99 HIGH-risk rows: 90 CURRENT, 8 PROPOSED, 1 AMBIGUOUS.

## False-positive check

| pattern | found | detail |
|---|---|---|
| city shared across events | **yes, 16 rows** | `"ufc vegas"` → a 2026 card at 1,805+ days |
| generic UFC series tag | **yes** | `"contender series"` at 3,176 days; `"the ultimate fighter"` series keys are what the 74 lost links were correctly made with |
| surname collision | **yes, 23 rows** | Chandler → Chelsea Chandler (15), plus Rodriguez, Hiestand, Smith, Vera, Morales, Peek, "Pitbull" |
| description boilerplate, fighter not the subject | **yes, 2 rows** | Michael Bisping on Octagon Interviews |
| nickname alias matching a phrase | in the STORED rows, 8 | fixed by the current resolver |
| older fight attached to a current event | **yes** | all 16 Barboza–Chikadze rows and `gAMxiXJd-js` |
| TUF season misattachment | no season moves; **11 rows lose the guard's `event_rejected` record** | |
| repeated numbered event names, title naming two events | not observed | |

## Recommendation: **SAFE ONLY IN TARGETED BATCHES — do not run a full relink**

A full relink today would detach 74 archive videos from their correct cards,
attach 17 old videos to 2026 cards, add 25 wrong or unreviewed fighters and
publish one video the resolver had held for review. 115 of the 137 link-moving
rows are better as stored.

Batches, for the owner to decide (none has been run):

1. **Apply — 8 rows, nickname-alias removals.** Each loses exactly one spurious
   fighter; the event, bout, status and type stay put (on some rows the resolver
   confidence follows the fighter count down):
   `--relink --ids CXv0za9tuAA,LmdnDSV66dE,H3DtCTuAnyY,cs-T1Qgb-sk,6kJcliSS8-U,9nXqBaZO-rc,k370XZTj4yQ,tWW7csCtSjM`
2. **Optional, no consumer effect — 69 metadata-only rows** (79 low-risk minus the
   10 of them that would drop `event_rejected`; the 11th such row is already HIGH). No reason to hurry.
3. **Review first — 13 article-link rows** (≤30 days old), and the 2 status moves.
4. **Never through this path — 115 rows.** They need a code fix before any relink
   touches them:
   - relink each stored row against the cards around **its own publish date**
     (`contextAt`, as the backfill does), or skip rows whose stored event is outside
     the window;
   - cap `nearest_date` at the window (a match 1,800 days away is not a match);
   - evaluate `surname_unique_window` against the publish-date card;
   - run `guardTufSeriesEvent` on relink, or preserve `linking.event_rejected`.

Until that fix exists, `--relink` should only ever be run with `--ids`.
