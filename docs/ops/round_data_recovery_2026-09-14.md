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

## 5. Coverage limits (superseded for the Contender Series by section 7)

- Contender Series cards are not on UFC.com event pages, so the official feed does not reach the 5 DWCS gap cards (25 bouts). They stay `awaiting_source` for UFC Stats.
- Issue #49 (two Noche bouts without UFC Stats fight ids): not resolvable from local evidence (no stored event page, no raw HTML, no capture). The official feed does not need those ids; the UFC Stats ids stay open.

## 6. Recovery (production, 2026-09-14)

Evidence: `docs/ops/evidence/round_data_recovery_runs_2026-09-14.json` (per-bout table, mutation check, health).

- **Noche first** (v0.7.1 `9dc990b4`, normal lane `POST /admin/run?espn=false`, 01:54Z): card linked from its UFC.com page to official event 1331; **13/13 bouts written, 70 round rows**, every round with both corners, `source_url` = each official fight document; 0 identity reviews, 0 validation failures, 16 feed requests (all HTTP 200). Two corners matched through aliases stored on 2026-09-06 (Sean King III, Jose Delgado). No Noche bout has a no-round-detail exception.
- **v0.7.2** (`ea0a0757`): unlinked cards no longer use up the official pass's per-run cap (they starved the older linked cards).
- **Older cards** (02:04Z): verified links 1327, 1326, 1321; Cornolle vs Syguła (6 rows), Lui vs Santiago (4), Rębecki vs Prepolec (2) written.
- **Unchanged:** event, bout, result and fighter rows on all four cards (byte-compared before/after); fighter aliases 6,793 before and after. Only `ufc_bout_round_stats` (+82) and queue state changed.
- **Totals:** round rows 41,930 → 42,012; queue 41 `awaiting_source` → 16 `written` + 25 `awaiting_source`; archive `last_event_date` 2026-09-05 → 2026-09-12; Recent analysis leads with Noche.
- **Health:** `round_lane_status` degraded for the 5 remaining Contender Series cards only (25 bouts, source disabled); `cleared_events` names Noche once (01:56:26Z) and the three older cards once (02:06:04Z); no duplicate on further reads.
- **Product:** `/round-by-round` keeps Noche as Latest completed event ("13 results recorded · 13 with round data", archive complete, 13 bouts round-intelligence ready); UFC 331 stays the separate Next event; 0 horizontal overflow at 1440 and 390.

## 7. Contender Series: the official feed covers it (2026-09-14)

UFC Stats is **BLOCKED** (single-bout canary 10:00Z challenged on its only request; owner decision: no scheduled canaries, no sweep, no solver; `UFCSTATS_SOURCE_STATUS = "blocked"` on `/health`).

Source scout: `scripts/sources/dwcs_round_source_scout.mjs --bout <uuid>` (read-only; never requests ufcstats.com). For one missing bout it evaluates the UFC official feed, ESPN, UFC Stats (reported, not requested), Internet Archive CDX and licensed providers (not requested), and records endpoint, HTTP result, event/bout/fighter identity, corners, rounds, fields, freshness, coverage, access and request cost.

| Candidate | Result |
|---|---|
| **UFC official statistics feed** | **viable.** DWCS Season 10 weeks 1–5 are official events 1328, 1329, 1330, 1333, 1334 ("DWCS 10.<week>"), all Final, `OfficialStats: true`, per-round `RoundStats` for both corners |
| ESPN core API | not viable: fight totals only (`splits.type = "total"`, split 1 identical to split 0) |
| UFC Stats | BLOCKED, not requested |
| Internet Archive | not viable: no capture of the anchor fighter page since the event; the other bouts have no UFC Stats id to look up |
| Licensed (Sportradar, Stats Perform) | not requested: not in our architecture, needs a contract and owner approval, unnecessary |

Validation, read-only (evidence `docs/ops/evidence/dwcs_source_scout_*_2026-09-14.json`):

| Bout | Card | Official event / fight | Identity | Result (winner, round, time) | Rounds × corners | Rows |
|---|---|---|---|---|---|---|
| Bilal Hasan vs Mridul Saikia | Week 1 | 1328 / 12983 | both corners exact | agree (KO/TKO R1 0:45) | 1 × 2 | 2 |
| Colton Loud vs Christian Natividad (no UFC Stats ids) | Week 5 | 1334 / 13114 | both corners exact | agree (KO/TKO R1 1:10) | 1 × 2 | 2 |
| Bella Mir vs Alex Apodaca | Week 3 | 1330 / 13041 | both corners exact | agree (U-DEC R3 5:00) | 3 × 2 | 6 |

Card identity for the Contender Series is deterministic: the official name `DWCS <season>.<week>` and our `Dana White's Contender Series: Season <season>, Week <week>` must give the same season **and** week, on the same date (±1 day) (`contenderSeasonWeek` / `sameOfficialEvent`, tested). The cards have no UFC.com event page, so each is linked once with `POST /admin/official-link`, which re-verifies the rule before storing.

Architecture: the official UFC lane is the round source for UFC and Contender Series cards (same writer, same exact corner and result validation, writes only round rows and queue state); UFC Stats stays disabled and blocked. No separate third-party fallback lane is needed.

## 8. Contender Series backfill (production, 2026-09-14, directly on `main`)

One card per batch: verified card link (`POST /admin/official-link`, season + week + date) → normal lane (`POST /admin/run?espn=false`) → snapshot of all five DWCS cards plus the recovered UFC cards → verification (every bout written, rounds contiguous to the stored finish round, both corners every round, event/bout/result/fighter/alias rows byte-identical, totals change only in round rows).

| Card | Official event | Written | Rows | Notes |
|---|---|---|---|---|
| Season 10, Week 1 | 1328 (DWCS 10.1) | 5/5 | 22 | all corners exact |
| Season 10, Week 2 | 1329 (DWCS 10.2) | 5/5 | 22 | Roman Gabriel Puga / Douglas Henrique Rodrigues via identical DOB + registered-name tokens (v0.8.2) |
| Season 10, Week 3 | 1330 (DWCS 10.3) | 5/5 | 16 | Nicholas / Nick Galanti via identical DOB + listed short first name (v0.8.3) |
| Season 10, Week 4 | 1333 (DWCS 10.4) | 5/5 | 22 | all corners exact |
| Season 10, Week 5 | 1334 (DWCS 10.5) | 4/5 | 14 | **Kwon Won Il vs Apollo Gomes held in identity_review** |

- 24 of 25 bouts recovered, 96 round rows (42,012 → 42,108); every request to the official feed returned 200 (6 per card).
- Event, bout, result, fighter and alias rows unchanged on every card (byte-compared before/after each batch); no UFC Stats request; no alias or external id written.
- **Open: Kwon Won Il vs Apollo Gomes.** The official feed names the fighter First "Kwon", Last "WonIl" with DOB 1995-07-24; our canonical row (ESPN) is "Kwon Won Il", DOB 1995-06-24. Apollo Gomes is exact (DOB 2000-07-10 both sides) and the result agrees (Gomes, U-DEC R3), but the DOB conflict means identity would rest on the name, so no rows are written. Needs a reviewed decision on the DOB (evidence: `docs/ops/evidence/dwcs_source_scout_kwon_gomes_w5_2026-09-14.json`).
- Health: every DWCS gap card cleared once by name; `round_lane_status` is `ok`. v0.8.4 adds `round_archive_review` to `/health`, listing completed bouts held for review without round rows, so `ok` does not hide the Kwon bout.

