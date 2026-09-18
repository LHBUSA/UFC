# Video relink — after the historical-context fix (2026-09-18)

Follow-up to `video-relink-drift-2026-09-18.md`. Same 728→729 stored rows, same
day, full `--relink --dry-run --explain`. **The corrected full relink has NOT been
applied.** The only database write in this work was the reviewed 8-row batch in §1.

Companion: `video-relink-after-fix-2026-09-18.json` (every remaining row, the 13
held article links, and the before/after summary).

> A historical video is resolved in historical context. The date the maintenance
> command happens to run never changes what event that video belongs to.

## 1. The 8 proven nickname-alias fixes — applied

`--relink --ids CXv0za9tuAA,LmdnDSV66dE,H3DtCTuAnyY,cs-T1Qgb-sk,6kJcliSS8-U,9nXqBaZO-rc,k370XZTj4yQ,tWW7csCtSjM`

| check | result |
|---|---|
| dry-run plans exactly these 8 rows | yes |
| each row loses exactly one fighter, gains none | 8 / 8 |
| event, bout, article, `link_status`, `video_type` unchanged | 8 / 8 |
| applied | `upserted 8 rows` |
| snapshot diff before/after | 0 violations |
| rerun | `0 updates, 8 unchanged` |

One row (`k370XZTj4yQ`, *Garcia vs Benn | Cold Open*) also moved confidence
`medium → low`: confidence is computed from the links, and it lost one of two.

## 2. What changed in the resolver

| | before | now |
|---|---|---|
| relink context | one window, ±45d around **the run date**, for every stored row | `loadArchiveEvents()` once, then `contextAt(archive, video.published_at)` **per row** — the path playlist backfills already used |
| no valid `published_at` | resolved against today's cards | stored links kept untouched; counted as `publish_date_unavailable`; `linkEvent` refuses `nearest_date` without a date (never "nearest to today") |
| `nearest_date` | nearest visible card, any distance (1,805 and 3,176 days observed) | hard limit `<= WINDOW_DAYS`; beyond it no event is linked and `linking.event_refused = { reason: "nearest_date_outside_window", distance_days, … }` is recorded |
| surnames | unique among fighters on cards around the run date | archive context requires a linked event for a surname-only attachment (`surnameRequiresEvent`), evaluated on the publish-date card |
| interviewer in description | attached as a fighter | under a title that says *interview*, a name found only in the description as the object of talk-with / interviewed-by / sits-down-with is a host: skipped and recorded in `linking.hosts_ignored` |
| TUF series guard | ran only on playlist backfill, so a relink erased `event_rejected` | runs on relink, using the stored TUF tag when the playlist title is no longer available; the refusal is reproduced |
| `article_id` | rewritten by any relink | **held** on relink unless `--allow-article-change`; reported, never written |
| `published ↔ review` | flipped by any relink | **held** on relink unless `--allow-status-change` |
| full relink write | unconditional | planned in full first; **refused in full** if any row would lose/change an event, lose/change a bout, lose or replace a fighter, flip status, or take an event from outside the window. No override flag: reviewed rows are applied with `--ids` |

## 3. Before → after

| | before | after |
|---|---|---|
| rows a full relink would rewrite | **216** | **73** |
| HIGH | 99 | 12 |
| MEDIUM | 38 | 0 |
| LOW (metadata only) | 79 | 61 |
| event lost | 74 | **0** |
| event changed (old card → 2026 card) | 15 | **0** |
| event gained from outside the window | 2 | **0** |
| bout lost | 4 | **0** |
| 2021 *UFC Vegas 35* → 2026 *Gamrot vs Salkilld* | 16 | **0** |
| 2017 *Contender Stories* → 2026 DWCS | 1 | **0** |
| *Team McGregor vs Team Chandler* → Chelsea Chandler | 15 | **0** |
| fighters gained (all causes) | 25 | **0** |
| interviewer attached (Bisping) | 2 | **0** |
| rows dropping TUF `event_rejected` | 11 | **0** |
| status flips | 2 | **0** (neither is proposed any more) |
| article-link changes | 13 written | 13 **held**, 0 written |
| rows older than 90 days at HIGH risk | 91 | **0** |

The 8 rows of §1 are gone from the plan because they were applied.

## 4. What remains (73 rows)

**61 LOW — no consumer effect.** 27 gain a `language` that was never stored
(`null→en` 13, `pt` 10, `es` 3, `ko` 3), 2 of those with evidence wording; 23 differ
only in the TUF tag's rule label; 9 only in fighter-evidence wording inside
`linking`. No link, status, type or fighter differs on any of them.

**12 HIGH — fighter removals, all recent, all blocked by the write guard.** These
are current-window rows, not archive damage: the live ingest attaches a surname that
is unique among the cards around *its* run date, and a relink (archive semantics)
does not attach a surname without a linked event.

| rows | video | removed | correct side |
|---|---|---|---|
| 11 | *Garcia vs Benn* press conference, weigh-in, cold open, highlights, post-show (UFC + UFC Brasil, 2026-09-10…15) | **Rafa Garcia** | **PROPOSED** — the Garcia is boxer Ryan Garcia (Zuffa Boxing); the stored link is a surname collision with a UFC lightweight |
| 1 | `7HUYpQ5OyGU` *Volk preparing for Evloev* (2026-09-02) | **Movsar Evloev** | **CURRENT** — it is Evloev; UFC 333 is 52 days after the publish date, outside the ±45d window |

Garcia batch, if the owner wants it (not run):
`--relink --ids 8NYz8GLgRT8,35QMmEPfbx8,Z2zN2w5tTaw,k370XZTj4yQ,YofWJr_3Dro,NHeIzmfbykE,BU6urLFjFlU,ucWfDgTfnUE,Q8zyH9mCvOY,Jc13C6uYnp8,umHWg_7Iy0U`

## 5. Still needs a human decision

1. **The 11 Garcia rows** — apply the batch above, or leave.
2. **`7HUYpQ5OyGU` (Evloev)** — keep as stored. It will keep appearing in the plan, and
   keep blocking an un-targeted full relink, until the live and relink surname rules
   agree. That disagreement is real and is the next thing worth fixing: the live path
   is still run-date dependent for surnames (it re-scores rows while they are in the
   feed window), which is how Rafa Garcia got onto eleven boxing videos.
3. **13 held article links** (all ≤30 days old; listed in the JSON). Policy decision,
   separate from link repair: `--allow-article-change` exists and was not used.
4. **The 61 metadata-only rows** — safe; a full relink cannot write them while the 12
   above are in the plan, so they would go by `--ids` or wait.

## 6. Is a full relink safe now?

It no longer wants to destroy historical links: **0** event or bout moves across 729
rows, where there were 93. It is also no longer possible to run one destructively —
today's plan is refused with `full relink refused: 12 destructive change(s); nothing
was written`. It remains **targeted-batches only** until the 12 are decided.

## 7. Not deployed

`ufc-video-autopilot` still runs v0.2.2 (`dc95b6ee`). It bundles `scripts/videos/lib.mjs`,
so the `nearest_date` limit, the no-date refusal and the interviewer rule reach live
discovery only at its next deploy; the bundle builds (192 KiB). The scheduled run never
relinks stored rows, so nothing in §2's relink path is exercised by it.
