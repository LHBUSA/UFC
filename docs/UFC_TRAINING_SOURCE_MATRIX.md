# UFC Training & Corner — source matrix

Status: **LIVE 2026-09-26 on option B (owner decision below).** Originally: audit complete, build held at the rights gate. Written 2026-09-26, based on `origin/main` 0315592.
Brief: "UFC FIGHTER CAMPS + COACHING INTELLIGENCE" (owner-approved feature). The brief says to stop before deployment if the source/rights audit does not support reliable production use. The audit does not support it without an owner decision, so nothing has been ingested, migrated or deployed.

## 1. Existing source of truth (audit)

| Place | Camp / affiliation / coach / fighting-out-of? |
|---|---|
| `ufc_fighters` (phase1 core DDL + all later migrations) | **None.** Identity, physicals, record, career stats only. No hometown, birthplace, nationality, gym, camp, coach or training-location column. |
| `web/lib/db.ts` `FIGHTER_COLS`, `web/app/fighters/[slug]/page.tsx` | Nothing camp-related is selected or rendered. |
| `workers/ufc-stats-ingest` | Reads the ESPN core athlete document but keeps only identity/physical fields. No raw payload is stored, so `association` is dropped today. |
| `combat_*` graph (`20260910235900`, `…35910`) | No gym/team entity. **Does own the source registry (`combat_sources`, with rights state) and the generic claims table (`combat_source_claims`).** A new camp model must reference `combat_sources` rather than invent a parallel `source_family` text column. |
| TUF archive (`web/lib/tuf.ts`, `/tuf/coaches`) | "Coach" means **TUF team coach** (Wikipedia provenance). This is a different concept, not a fighter's camp. Do not reuse it. |

Nothing to deduplicate: this would be a new first-class model.

## 2. Candidate sources

Measured 2026-09-26. Coverage numbers are samples, not full crawls.

| Source | Fields actually available | Access | Cadence | Identity quality | Historic depth | Terms / redistribution | Automatable? | Verdict |
|---|---|---|---|---|---|---|---|---|
| **UFC.com athlete page** (`/athlete/<slug>`) | `Place of Birth`, **`Trains at`** (gym + city, e.g. Pereira: "Teixeira MMA & Fitness-Bethel, CT"), `Fighting style`. Measured athlete pages show **no "Fighting out of" / "Affiliation" labels** (see §4). | HTML only. `node/article` JSON:API returns 403. `crawl-delay: 15`. | Edited ad hoc; stale bios are common. | Slug-based; no id we store. | **Current value only**, no dates. | **PROHIBITED.** ufc.com/terms: no "page-scrape, robot, spider… to access, acquire, copy or monitor"; "may not… enter into a database… any part of this website"; "files may not be used to construct any kind of database". Already recorded as `combat_sources.ufc_official = review_required / unknown`. | Technically yes; contractually no. | Tier 1 on authority, **blocked on rights**. |
| **UFC.com editorial** (fight-week "Fighting Out Of / Affiliation" blocks, camp-change articles) | Fighting-out-of, affiliation; occasional explicit switch statements (e.g. Dillashaw / Team Alpha Male). | HTML prose, not structured. | Per event. | Names in prose; would need an exact fighter_id join. | **Dated** (article date). This is the only official source that supports CONFIRMED_SWITCH. | Same UFC.com terms: **prohibited** for DB entry. | Parsing prose is fragile. | Blocked on rights. Would be the best evidence for confirmed switches if licensed. |
| **ESPN core athlete** (`sports.core.api.espn.com/v2/sports/mma/leagues/ufc/athletes/<id>`) | `association {id, name, location.country}`, `citizenship`, `birthPlace` (null in samples). **No coaches, no training city, no dates.** | Keyless JSON; the production ingest already fetches this document. | Current snapshot. | **Best available:** `espn_athlete_id` is already resolved on `ufc_fighters`, and associations carry a stable ESPN id (e.g. `7027` Teixeira). No fuzzy joins needed. | **None.** History exists only as our own dated observations, so changes are OBSERVED, never CONFIRMED. | **Disney ToU §2.B/§3.H prohibit** automated access, database building and commercial use (network rights notice 2026-09-15, `nba-propbetedge/docs/history/RIGHTS_EXPOSURE_NOTICE.md`). The owner accepted that risk for **NBA only** (2026-09-25). Tennis uses ESPN as reference-only. `combat_sources.espn = identity_only`. **No UFC-scope decision exists.** | Yes, trivially (one field on a document we already fetch). | **Only source with production coverage. Needs an explicit owner decision.** |
| — ESPN measured coverage | 60 randomly sampled fighters from the 297 on the 16 UFC cards 2026-08-01…09-26: **57/60 (95%) have `association.name`**; **0/60 have a city**. `association.location.country` is the *fighter's* country, not the gym's (Kill Cliff FC → "France" for Ziam; Phuket Top Team → "China" for Xiong). | | | | | | | **Never** use `association.location` as a training location. |
| **Wikidata** (CC0) | P54 member of sports team (mixes gyms with **college wrestling teams**), P10449 trained by, P1066 student of, P551 residence. | SPARQL, keyless. | Crowd-edited. | P9722 UFC athlete id; P10073 ESPN MMA id (348 items). | Sometimes P580/P582 qualifiers. | **Approved** (`combat_sources.wikidata = approved_ingest`). | Yes. | **Green but useless for coverage.** Of 1,868 items with a UFC athlete id, ~90 have *any* gym-class team, only 10 have a P54 whose value is classed "mixed martial arts training facility", 2 of those are dated and 5 carry a reference URL (3 are "imported from Wikipedia"). Coaches (P10449): 11 items. At best a supplementary cross-check. |
| **Sherdog Fight Finder** | "Association" (current). | HTML. | Ad hoc. | Sherdog id (Wikidata P2818). | Current only. | Terms (2021-01-10): no automated systems beyond human rate, and "agree not to aggregate or collate any of the content… for use elsewhere". `combat_sources.sherdog = review_required`. | No. | Blocked. |
| **Tapology** | Affiliation (often with history). | HTML. | Community-edited. | Tapology id (P9728). | Some history. | Terms page returns **403 to automated fetch** (bot challenge), so it could not be reviewed. `combat_sources.tapology = review_required`. Community aggregator: the brief forbids it as source of truth anyway. | No. | Blocked / unreviewed. |
| **Official gym websites / verified gym & fighter social announcements** | Rosters, coach staff, join announcements (dated). | Per-gym HTML/social; no common format. | Irregular. | Name-only; manual exact join. | Dated announcements. | Per-site; facts are low-risk for a **manual, cited, human-entered** record, not a crawler. | **No** (manual curation). | Viable only as a **manual editorial lane** for confirmed switches and named coaches, row by row with source_url. |
| **Athletic commission records** (seconds/corner licences) | Licensed corner persons per bout, in some jurisdictions. | PDFs / records requests; per-state. | Per event. | Names only. | Dated. | Public records; per-jurisdiction review (`combat_sources.athletic_commission = review_required`). | Partially. | The only route to **corner** (who was actually in the corner) truth. Separate project, not V1. |
| **Sportradar / SportsDataIO MMA** | Unverified whether gym/coach fields exist. | Paid API. | — | Provider ids. | — | Contract needed. | — | Not evaluated. It would be a paid source and needs approval first. |

## 3. What each field could honestly be sourced from

| Brief field | Realistic source | Coverage if unblocked |
|---|---|---|
| FIGHTING OUT OF | UFC.com editorial / broadcast announcer data. **No structured source with rights.** ESPN `citizenship` is nationality, **not** fighting-out-of. | ~0 without UFC.com |
| PRIMARY CAMP / AFFILIATION | ESPN `association` (≈95% of active roster) or UFC.com `Trains at` | ≈95% via ESPN |
| TRAINING LOCATION | UFC.com `Trains at` suffix only. ESPN has none (country is the fighter's). | ~0 without UFC.com |
| COACHING TEAM + roles | **No structured source anywhere.** Manual announcements only; Wikidata has 11 fighters. | Near 0; manual only |
| CONFIRMED SWITCH | Dated editorial / gym / fighter announcements (manual) | Manual only |
| OBSERVED AFFILIATION CHANGE | Our own dated snapshots of ESPN `association` (from the first capture onward; no back history) | Accrues forward |

## 4. Brief corrections

1. **"UFC bios publish Fighting Out Of and Affiliation."** Measured athlete pages publish `Place of Birth` and `Trains at`, not those labels. The labels in the brief come from editorial / fight-week pieces. Both surfaces fall under the same terms.
2. **"Do not copy copyrighted bios; store the factual fields + provenance."** This does not clear UFC.com. The terms prohibit automated access and *entering any part of the site into a database*, not only copying prose.
3. **Provenance on the page vs the network brand standard.** `scripts/guard-source-brand.mjs` (CI on main) blocks upstream provider branding in consumer UI ("DATA · PropSports"). A visible "Source: ESPN" or ESPN link on the fighter module would fail CI unless the owner adds the module to the guard's ALLOW list. Provenance can still live in full in the API `provenance[]` and in the DB.
4. **`source_family` text column** would duplicate `combat_sources`. Use `source_id → combat_sources` so rights state (`access_mode`, `enabled`) gates ingestion in the database itself.
5. **"ACTIVE UFC FIGHTERS: X"**: `ufc_fighters.is_active` is known to be unreliable (DWCS source scout 2026-09-12: 692 true vs 280 who fought in 18 months). The denominator should be "fought in the UFC in the last 18 months or booked", computed from bouts.
6. **Coaches**: no source with coverage exists. "COACH COVERAGE" will be near zero in any V1 that respects "never infer". That is correct behaviour, not a defect.

## 5. Proposed schema (NOT applied)

Draft at `docs/ufc-training/proposed_schema.sql`. Deliberately **not** placed in `supabase/migrations/` so nothing can apply it by accident. Changes from the brief: `source_id` FK to `combat_sources` replaces `source_family`; camps carry `external_ids` (ESPN association id) for exact joins; `ufc_training_observations` is an append-only raw ledger, and `history` rows are derived from it; `change_kind` separates CONFIRMED from OBSERVED at the data layer.

## 6. Decision required (owner)

| Option | What ships | Coverage | Risk |
|---|---|---|---|
| **A. Manual-only** (green) | Schema + manual editorial entry (cited gym/fighter/UFC-editorial *links* entered by a person, facts only) + Wikidata cross-check + UI/API that hides empty rows | Tens of fighters; grows by hand | Lowest. Slow. |
| **B. ESPN `association` as the camp signal** | A + Stats-ingest captures `association` into the observation ledger; OBSERVED changes accrue forward; no fighting-out-of / training-location / coaches from ESPN | ≈95% current camp; 0 back history | Extends the open Disney exposure to a new UFC surface. The NBA acceptance does not cover UFC. |
| **C. License / written permission** (UFC/Zuffa or a data provider) | Full field set incl. Trains at, fighting-out-of, editorial switches | High | Cost / time. Needs approval under the paid-source rules. |

Until one is chosen: no ingest, no migration, no deploy.

## 7. Owner decision (2026-09-26)

Justin Erickson approved **option B** for UFC: ESPN athlete `association` (id + name) is the current-camp signal. Build, migrate, backfill and deploy approved. Do not reopen the source-rights discussion unless the source materially changes or access breaks. Customer-facing attribution stays "Data source · PropSports" (no brand-guard exception). Runbook: `docs/ufc-training/README.md`.
