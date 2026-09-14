# Round-for-Round data recovery (2026-09-14)

The product rollover shipped in PR #47 and #48. This document covers the data: production still had Noche UFC at 13/13 results and 0 round rows, 41 bouts `awaiting_source`, and UFC Stats challenged from Cloudflare.

## 1. Where else the same round observations exist

Checked before fetching anything again. Evidence: `docs/ops/evidence/round_source_audit_2026-09-14.json`.

| Path | Noche round data? | Usable as a round source? |
|---|---|---|
| `ufc_bout_round_stats` | 0 rows | — |
| R2 `ufc-raw` (UFC Stats page cache `ufc-raw/{events,fights}/{id}.html`) | event page and all 11 known fight pages **absent**; key convention verified against an existing object | — |
| `combat_round_stats` (combat direct-source system) | table is empty (0 rows in total) | no: Wikipedia/Wikidata career layer, no rounds |
| Internet Archive (existing `scripts/backfill/wayback.py` path, CDX only, ufcstats.com never contacted) | event page + 11 fight pages: **0 captures** | not for Noche |
| ESPN core API | competitor statistics are `splits.type = "total"` for every split index (`/statistics/0..4` identical); linescores are judges' scores; fightcenter has only `period` | **no** — fight totals only (already documented in `20260912000002_ufc_bout_fight_stats.sql`) |
| **UFC official statistics feed** (`d29dxerjsp82wz.cloudfront.net/api/v3`, the JSON behind UFC.com event pages) | **yes**: all 13 Noche fights, `Status: Final`, `OfficialStats: true`, `RoundStats[].Rounds[]` per fighter per round | **yes**, see §2 |

No Noche round observation existed anywhere in our storage. The only place it exists is at the source: UFC Stats (challenged) and UFC's official feed.

## 2. The official feed is the same data (proved before any write)

The feed publishes per-round, per-fighter statistics directly; nothing is decomposed from a total. Column map (`src/ufcOfficial.mjs` `ROUND_COLUMNS`): kd ← Knockdowns; sig/total strikes ← SigStrikes/TotalStrikes; td ← Takedowns; sub_att ← SubmissionsAttempted; rev ← Reversals; ctrl_sec ← ControlTime (m:ss); head/body/leg and distance/clinch/ground ← the significant-strike breakdowns.

Read-only comparison against cards whose UFC Stats rows were already stored (`docs/ops/evidence/ufc_official_round_feed_equivalence_2026-09-14.json`):

| Card | Official event | Bouts compared | Cells | Mismatches | Result disagreements |
|---|---|---|---|---|---|
| UFC Fight Night: Hooker vs. Parnasse (2026-09-05) | 1327 | 12 | 1,188 | 0 | 0 |
| UFC Fight Night: Nurmagomedov vs. Song (2026-08-29) | 1326 | 11 | 968 | 0 | 0 |
| **Total** | | **23** | **2,156** | **0** | **0** |

Three bouts were not compared because our names did not match the feed exactly (Syguła/Sygula, "Letho" Duclos, Xiong Jingnan name order); the lane treats those as identity work, never as a fuzzy match.

## 3. What was built (ufc-stats-ingest v0.7.0)

`src/ufcOfficial.mjs` (pure) + an official pass in the round-stat lane:

- Used **only** while UFC Stats cannot be read (`UFCSTATS_ENABLED=false` or challenged) and `UFC_OFFICIAL_ROUNDS_ENABLED=true`. UFC Stats stays primary; its challenge stays fail-closed; the solver stays off.
- Card identity: the card's UFC.com event page (`ufc_event_broadcasts.ufc_slug`) or a verified stored link (`POST /admin/official-link`), always re-checked against the official event document (same date ±1 day, same event name).
- Bout identity: both corners exactly (canonical name, stored alias, or family-name-first rendering), one-to-one, exactly one official fight on the card.
- Validation before a write: `Final` + `OfficialStats`; winner, finish round and finish time equal our stored result; rounds contiguous from 1 to the finish, both corners in every round; every value a valid count or m:ss.
- Write: the lane's idempotent upsert on `(bout_id, fighter_id, round)` with the row-count assertion; `source_url` = the official fight document; queue `written`, `identity_method = ufc_official_feed`, evidence with the official ids and URLs. Results, bouts, events and UFC Stats ids are never written by this pass.
- Outcomes use the existing queue states: `not_yet_published` (not final/official), `validation_failed`, `identity_review`, `awaiting_source` (no official link, with the reason).
- `POST /admin/official-canary` compares the feed to stored rows from Cloudflare egress and writes nothing but its run row.
- Public copy no longer says round rows come only from UFC Stats (Round-for-Round deck line, About page).

## 4. Production canary and enablement

`POST /admin/official-canary` from Cloudflare egress on Worker v0.7.0 (version `9aeedd44`, flag off), official events 1327 and 1326: **clean**. 25 bouts matched (alias-aware identity also resolved Letho Duclos and Xiong Jingnan), 2,244 cells, 0 mismatches, 0 validation problems, 29 feed requests all HTTP 200 (`docs/ops/evidence/ufc_official_canary_2026-09-14.json`). Owner approved enabling: `UFC_OFFICIAL_ROUNDS_ENABLED = "true"` in v0.7.1; `UFCSTATS_ENABLED` and `UFCSTATS_SOLVE_CHALLENGE` stay `"false"`.

v0.7.1 also names each gap card that clears while other gaps remain (`ROUND ARCHIVE GAP CLEARED · <card>`, sent once, recorded in the alert state's `cleared_events`).

## 5. Coverage limits

- Contender Series cards are not on UFC.com event pages, so the official feed does not reach the 5 DWCS gap cards (25 bouts). They stay `awaiting_source` for UFC Stats.
- Issue #49 (two Noche bouts without UFC Stats fight ids): not resolvable from local evidence (no stored event page, no raw HTML, no capture). The official feed does not need those ids; the UFC Stats ids stay open.
