# Video resolver — surname invariant, Garcia cleanup, autopilot v0.2.3 (2026-09-18)

Third and final receipt of the 2026-09-18 video resolver work. Earlier:
`video-relink-drift-2026-09-18.md` (audit) and `video-relink-after-fix-2026-09-18.md`
(historical-context relink).

> **A surname by itself is not a fighter identity. It becomes usable only after the
> video is already scoped to the fighter's actual event/card.**

Database writes in this block: **the 11 reviewed Garcia rows, and nothing else.**

## 1. The 11 Rafa Garcia false links — removed

`--relink --ids 8NYz8GLgRT8,35QMmEPfbx8,Z2zN2w5tTaw,k370XZTj4yQ,YofWJr_3Dro,NHeIzmfbykE,BU6urLFjFlU,ucWfDgTfnUE,Q8zyH9mCvOY,Jc13C6uYnp8,umHWg_7Iy0U`

Eleven *Garcia vs Benn* (Zuffa Boxing, boxer Ryan Garcia) uploads on UFC, UFC Brasil
and ESPN MMA carried UFC lightweight **Rafa Garcia**, attached by `surname_unique_window`.

| check | result |
|---|---|
| targeted dry-run + explain | exactly 11 updates |
| fighter removed | Rafa Garcia on all 11 (one distinct fighter id) |
| fighters added | 0 |
| event / bout / article / `link_status` / `video_type` | unchanged, 11 / 11 |
| other fields | `linking` evidence on all; `resolver_confidence low → none` on 10 (derived: they lost their only link), `medium → medium` on 1 |
| applied | `upserted 11 rows` (after autopilot v0.2.3 was live — see §5) |
| before/after snapshot diff | 0 violations |
| rerun | `0 updates, 11 unchanged` |

**Order mattered.** The dry discovery run in §4 showed `8NYz8GLgRT8` was still in ESPN
MMA's feed window: the old Worker would have re-attached Rafa Garcia on its next
half-hourly run. The Worker was deployed first, then the batch was applied.

## 2. `7HUYpQ5OyGU` — Movsar Evloev kept, on purpose

*"Volk preparing for Evloev"* (2026-09-02) is about Movsar Evloev. The automatic
resolver now withholds it: there is no event key in the title, and UFC 333
(2026-10-24) is 52 days from the upload, outside the ±45-day window. That is a
statement about what can be PROVEN automatically, not about the link, which is
correct and stays. Verified untouched after all writes: `fighter_ids = [Evloev]`,
`published`.

No exception was written for it: `WINDOW_DAYS` is still 45, there is no per-surname
rule, and the `nearest_date` limit is unchanged. The video model has no "verified
link" concept (`link_status` is `published | review | rejected`, and `rejected`
would hide the video), so none was invented for one row. It remains the single
intentional high-risk difference in a relink plan, and the write guard refuses any
un-targeted full relink while it is there. **A false negative is better than a
false identity.**

## 3. The rule, before and after

| | before | now |
|---|---|---|
| surname, event linked | unique on that event's card → attach (`surname_unique_event_card`) | unchanged |
| surname, no event — **live discovery** | unique among fighters on any card within ±45d of the RUN → **attach** (`surname_unique_window`) | **never attaches.** Recorded as `linking.surnames_withheld` (evidence, not a review item: it does not hide the video) |
| surname, no event — relink | withheld (since `3abf6d5`) | withheld, same code path as live |
| full names | alias-resolver rules | unchanged |
| title pairing | fighters had to attach first, then a bout could imply the event | **`A vs B` / `A x B` naming both corners of exactly ONE bout in the video's window resolves that bout's event first** (`linking.event.method = via_title_pairing`); surnames then attach on that card. A roundup that merely lists two names has no versus marker and pairs nothing. *Garcia vs Benn* can never pair: there is no UFC bout with a Benn |
| discovery context | the cards within ±45d of the run date, for every feed entry | the cards within ±45d of **each upload's own publish date** (`contextAt(ctx.raw, entry.published)`; the load is widened by `--since-days`). An entry with no date at all is treated as published now |

`surname_unique_window` no longer exists as a method that writes. It survives only
in stored evidence on rows linked before today.

## 4. Proof on the production code path

**Golden tests** (`scripts/videos/relink_golden.test.mjs`) run `main()` — the module
`ufc-video-autopilot` imports — end to end over a stubbed YouTube feed + PostgREST,
with Rafa Garcia as the ONLY Garcia on any UFC card in the window:

- five fresh *Garcia vs Benn* / Ryan Garcia uploads → no fighter, no UFC event, no
  bout, no surname attachment; the collision is recorded in `surnames_withheld`
- *Team McGregor vs Team Chandler* → no Chelsea Chandler
- a roundup naming Smith, Rodriguez, Morales and Pitbull → nobody
- *Octagon Interview* with "talk with Michael Bisping" in the description → the
  subject only; `hosts_ignored = ["michael bisping"]`
- *UFC 331 Countdown: Joshua Van vs Alexandre Pantoja* → event, bout, both fighters,
  confidence high; *Ceremonial Weigh-In* → event; *Tsarukyan vs Ruffy staredown* →
  event + bout via the pairing; *Pantoja is confident #ufc331* → Pantoja on the 331 card
- a lone *Evloev* → withheld; `WINDOW_DAYS === 45`
- the same upload is linked identically whether the feed is read four days or
  sixty days after it was published

**Dry discovery against the real feeds** (`ingest_youtube.mjs --dry-run --explain`,
no writes), new code vs the stored rows: 60 rows in the four feed windows, **59
unchanged, 1 change — `8NYz8GLgRT8`, the Garcia row.** Every UFC 331 fight-week row
in the feeds kept its links.

## 5. `ufc-video-autopilot`

| | |
|---|---|
| previous | v0.2.2, version `dc95b6ee-b963-4bbc-8e93-f64a9aafd1a1` (**rollback**) |
| deployed | **v0.2.3**, version `7f461aca-e76a-4f03-89c5-c9c8a33e4fd4` |
| schedule | `13,43 * * * *` — unchanged |
| health | `/health` → `v0.2.3`, `last_error: null` |
| bundle | 193.67 KiB (gzip 46.70 KiB) |

## 6. Full relink plan after all of the above (dry-run; NOT applied)

729 stored rows → **77 would change** (652 unchanged).

| | 1st audit | after historical fix | now |
|---|---|---|---|
| rows | 216 | 73 | **77** |
| HIGH | 99 | 12 | **1** |
| MEDIUM | 38 | 0 | **1** |
| LOW | 79 | 61 | **75** |
| event lost / changed | 74 / 15 | 0 / 0 | **0 / 0** |
| bout lost / changed | 4 / 0 | 0 / 0 | **0 / 0** |
| fighters lost | 10 | 12 | **1** (Evloev, intentional) |
| fighters gained | 25 | 0 | **1** (correct, below) |
| status flips | 2 | 0 | 0 |
| article links | 13 written | 13 held | **13 held** |
| blocked by the write guard | — | 12 | **1** |

- **HIGH (1):** `7HUYpQ5OyGU`, Evloev — §2. Blocks an un-targeted full relink; intended.
- **MEDIUM (1):** `XA0XV_cWvII` *Turcios vs Hiestand | TUF 29 Bantamweight Final | Fight
  Preview* (2021-08-26) would GAIN *UFC Fight Night: Barboza vs. Chikadze* (2021-08-28),
  its bout and both fighters, through the new title pairing. That is the card the TUF
  29 final was on, two days after the upload: a correct, historical-context gain. Not
  applied; it is additive, so the guard would allow it.
- **LOW (75):** 29 gain a never-stored `language`; 23 differ in the TUF rule label;
  23 only in `linking` evidence — 14 of those solely because the new
  `surnames_withheld` evidence key now appears. No link, status, type or fighter moves.
  Deliberately left unwritten: they have no consumer effect.
- **Held (13):** article links, untouched.

A full relink remains **not authorized and not possible**: the plan is refused with
one destructive change. Failing closed on one reviewed disagreement is preferable to
deleting known-correct information.

## 7. Post-deploy canary (first scheduled run on v0.2.3)

`ufc_ingest_runs` 9c54e0d5, cron `13,43 * * * *`, 2026-09-18T16:43:35Z → 16:43:46Z, `success`:
fetched 60, **new 0, updated 0, unchanged 60**, failed channels 0, assertion failures none.
The Garcia row still in ESPN MMA's feed (`8NYz8GLgRT8`) was re-scored and left alone.

| check | result |
|---|---|
| Hangul titles stored as `en` | 0 of 37 |
| rows written since deploy carrying `surname_unique_window` | 0 |
| UFC 331 linked rows | 145, none rewritten |
| Evloev row `7HUYpQ5OyGU` | untouched (last updated 2026-09-09) |
| `/fight-week` | unchanged: curated English desk, Korean under All |
| Worker `/health` | v0.2.3, `last_error: null` |

## 8. Known residual — found by the canary, NOT changed

`T3G-YgpFjlQ` (UFC Espanol, 2026-09-11, *#GarciaBenn "Listo para hacer mi trabajo" Ryan Garcia*)
still carries a fighter through `garcia: surname_unique_event_card`. It satisfies the invariant as
written — an event IS resolved — but the event comes from a `"noche ufc"` series key found only in
the DESCRIPTION (`in_title: false`; the boxing card shared that weekend's promotion), and the
surname then matches that card. It was not in the reviewed batch, so it was not written. It is a
different class from the eleven: a description-only event key lending its card to a title surname.
The narrow fix, if wanted later, is to let a surname use an event's card only when the event key is
in the title or the event came from a title pairing. One row; a relink plans no change to it.
