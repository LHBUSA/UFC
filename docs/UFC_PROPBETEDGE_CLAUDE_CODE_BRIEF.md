# ufc.propbetedge.ai — Claude Code Kickoff Brief

## Who you are working for

Justin Erickson, solo technical founder of PropTechUSA.ai / PropBetEdge. PropBetEdge already ships an MLB product (propbetedge.ai, $29/mo) and an NFL product (nfl.propbetedge.ai). This brief starts the third product line: **ufc.propbetedge.ai**.

Communication style: direct, blunt, no filler. If something in this brief is wrong or a selector doesn't match the live site, say so and propose the fix — don't silently work around it.

## The product (for context — NOT this phase's scope)

A UFC intelligence + props platform: news, card-change/injury tracking, fighter pages, rankings, upcoming events, and a self-improving algo that prices fight winner, method of victory, total rounds, and distance props against the market. Free tier = SEO surfaces (fighter pages, event pages, A-vs-B prediction pages, rankings). Paid = picks, edges, card-change alerts, judge/ref intel, weigh-in report.

Key structural facts that shape every design decision:
- ~40 events/year, ~12 bouts each, almost all Saturdays. Product rhythm is **card week**, not day.
- 15–20% of announced bouts change before fight night. There is no official injury report. Tracking card changes fast is a core differentiator.
- There is no official UFC API. All data is scraped from public pages. Design every scraper to fail loudly, never to write garbage.
- The training set is small (~8k UFC fights all-time). Model evaluation must use calibration + closing-line value (CLV), not hit rate.

## PHASE 1 SCOPE — what to build now

**Goal: a complete, verified, backfilled UFC Stats dataset in Supabase, plus the incremental ingest worker, plus alias resolution. Nothing else.**

Deliverables:
1. Supabase migration creating the `ufc_*` schema below (only the tables marked Phase 1).
2. `backfill_ufcstats.py` — local Python script, resumable, writes directly to Supabase, optionally stores raw HTML to R2.
3. `ufc-stats-ingest` Cloudflare Worker — nightly cron, incremental only.
4. `ufc-fighter-aliases` resolution module (shared logic; used by backfill now, by ESPN/UFC.com scrapers later).
5. Verification report: row counts per table, missing-stats bout count, alias manual-review queue, schema-assertion failures.

Explicitly OUT of scope for Phase 1 (do not start these):
- Card watcher (UFC.com / ESPN diffing)
- Commission medical-suspension scraper
- Odds ingestion or prop scrapers
- Feature builder, Elo/Glicko, any model
- Grader, picks, track record
- UI, SEO pages, auth, Stripe, news digest

Those are Phases 2–5 (roadmap at the bottom). Phase 1 must be verified before any of them start.

## Environment and conventions (non-negotiable)

- Stack: Cloudflare Workers + Supabase (project `rlfyavnhbngwbldebrid`, same instance as MLB/NFL) + Vercel frontend later. Cloudflare R2 for raw HTML.
- Repo: create `LHBUSA/ufc-propbetedge` (public, mirrors how `nfl-propbetedge-new` is organized). Layout:
  ```
  /migrations/            SQL migrations, numbered
  /scripts/backfill/      Python backfill + shared parsers
  /workers/ufc-stats-ingest/
  /shared/                alias resolution, normalizers, enums (used by both Python and JS — keep a JSON enum file both sides read)
  /docs/                  this brief, scraper notes, verification reports
  ```
- Workers deploy from `C:\Workers\` via wrangler on Windows PowerShell. Never from Downloads. Deliver deployable worker code as a ready-to-unzip folder with `wrangler.toml` included and a numbered zip filename.
- Any file edits via scripts: use Python, never PowerShell heredocs (character corruption).
- All tables prefixed `ufc_`. **Do not touch any existing MLB/NFL tables, workers, KV namespaces, or Stripe objects.**
- Supabase is on a large plan but big UPDATEs still time out on wide tables. Batch writes (500 rows), fresh connection per batch in the backfill script.
- Every scraped row carries `source_url` and `captured_at`. Every parser has a schema assertion (expected headers/column count) that raises and stops. The failure mode we want is "ingest stopped and told Discord," never "wrote wrong data."
- Secrets via wrangler secrets / `.env`, never committed. Discord webhook URL for alerts will be provided.

## Source: UFC Stats (ufcstats.com)

Static HTML, no JS, no auth. Serial requests, ~1 req/sec, real User-Agent. Store raw HTML to R2 at `ufc-raw/{events|fights|fighters}/{id}.html` on first fetch so re-parsing never requires re-scraping.

**IDs:** every entity URL ends in a 16-char hex string. That is `ufcstats_id` — the upsert key for fighters, events, bouts. Never key on name.

**Entry points**
- Completed events: `/statistics/events/completed?page=all` — all events, newest first. Rows: name (link to `/event-details/{id}`), date, location.
- Upcoming events: `/statistics/events/upcoming` — same shape. Seeds `ufc_events.card_status='announced'` and `ufc_bouts.status='announced'`.
- Fighters: `/statistics/fighters?char={a..z}&page=all` — 26 pages. Rows: first, last, nickname, height, weight, reach, stance, W, L, D, belt flag; link `/fighter-details/{id}`.

**Event page → `ufc_bouts`**
Table in card order, main event first (so `bout_order` descends with row index). Columns: W/L flag, two fighter links (winner listed first on completed cards), KD, STR, TD, SUB, weight class, method, round, time. Row links to `/fight-details/{id}`. Page header gives date and location. Card position (main/prelim/early) is NOT on UFC Stats — leave nullable.

**Fight details page → `ufc_bout_results` + `ufc_bout_round_stats`**
Header: fighter names/links, W/L per fighter, weight class line (may include "Title Bout"), result strip with Method, Round, Time, Time format (e.g. "3 Rnd (5-5-5)"), Referee, and a Details line. For decisions Details holds judge names + scores ("Sal D'Amato 29-28. ..."); for finishes it's a finish description ("Punches to Head At Distance").

Stats tables (Totals + Per-round variants each):
1. Totals: KD, Sig. str. ("45 of 90"), Sig. str. %, Total str., Td ("x of y"), Td %, Sub. att, Rev., Ctrl (mm:ss)
2. Significant strikes by target (Head/Body/Leg) and position (Distance/Clinch/Ground), "x of y"

Each cell stacks both fighters' values (two `<p>`s), fighter A first, matching header order. Per-round tables have one section per round. Parse "x of y" into landed/attempted; parse ctrl to seconds. Store round-level rows only; totals are recomputable.

Old/edge-case fights may have no stats tables — write the result, skip stats, count it in the verification report; do not fail the event.

**Fighter page → `ufc_fighters`**
Header: name, nickname, record string "Record: 20-3-0 (1 NC)". Details: Height (5' 11"), Weight (lbs), Reach (in), Stance, DOB. Career stats: SLpM, Str. Acc., SApM, Str. Def., TD Avg., TD Acc., TD Def., Sub. Avg. — store as `career_*` snapshot fields but flag in a comment that these are career-to-date and MUST NOT be used as model features (leakage). Missing values are "--" → NULL. Fight-history table on the page = completeness cross-check (count mismatch vs our bouts for that fighter → log it).

**VERIFY FIRST:** fetch one live page of each type and confirm selectors/headers before writing parsers. The structure above has been stable for years, but treat it as a starting hypothesis, not gospel. Report any deviation.

## Normalization enums (put in `/shared/enums.json`)

- `method`: KO_TKO, SUB, DEC_U, DEC_S, DEC_M, DQ, NC. Map "KO/TKO"→KO_TKO, "Submission"→SUB, "Decision - Unanimous/Split/Majority"→DEC_*, "DQ"→DQ, "Overturned"/"Could Not Continue"/"No Contest"→NC. Unknown string → assertion failure.
- `weight_class`: STRAWWEIGHT, FLYWEIGHT, BANTAMWEIGHT, FEATHERWEIGHT, LIGHTWEIGHT, WELTERWEIGHT, MIDDLEWEIGHT, LIGHT_HEAVYWEIGHT, HEAVYWEIGHT, CATCHWEIGHT, OPEN, plus `is_womens` boolean parsed from "Women's".
- `stance`: ORTHODOX, SOUTHPAW, SWITCH, OPEN_STANCE, NULL.
- `scheduled_rounds`: from time-format string ("3 Rnd" → 3, "5 Rnd" → 5, others → parse the count or NULL for 1-round/no-time-limit oddities).

## Alias resolution (`/shared/alias_resolver`)

UFC Stats is the canonical name source. `ufc_fighter_aliases` starts from UFC Stats name + nickname. Match order for any external name:
1. Exact `ufcstats_id` link if the source exposes it → done.
2. Normalized name (strip accents, punctuation, lowercase, collapse whitespace) + weight class match.
3. Fuzzy (token-sort ratio ≥ 90) AND a second key (DOB or record) matches.
4. Otherwise → `ufc_alias_review_queue` for manual confirmation. Never auto-merge on name alone — duplicate names exist (multiple "Bruno Silva"s).

Phase 1 only needs the resolver built and tested against the UFC Stats fighter list itself (detect internal duplicates/near-duplicates). External sources plug in later.

## Schema — Phase 1 tables

```sql
ufc_fighters
  id uuid pk, ufcstats_id text unique not null, name text, nickname text,
  dob date, height_in numeric, reach_in numeric, weight_lbs numeric, stance text,
  record_w int, record_l int, record_d int, record_nc int,
  career_slpm numeric, career_str_acc numeric, career_sapm numeric, career_str_def numeric,
  career_td_avg numeric, career_td_acc numeric, career_td_def numeric, career_sub_avg numeric,
  is_active bool, source_url text, captured_at timestamptz, updated_at timestamptz

ufc_fighter_aliases
  fighter_id uuid fk, alias text, source text, normalized text, created_at
  unique(source, normalized)

ufc_alias_review_queue
  id, raw_name text, source text, candidate_fighter_ids uuid[], context jsonb, status text, created_at

ufc_events
  id uuid pk, ufcstats_id text unique, name text, event_date date, venue text, city text,
  country text, commission text null, is_ppv bool null,
  card_status text check in (announced, locked, complete), source_url, captured_at

ufc_bouts
  id uuid pk, ufcstats_id text unique null (null for announced-only bouts), event_id fk,
  fighter_a_id fk, fighter_b_id fk, weight_class text, is_womens bool, is_title bool,
  scheduled_rounds int null, card_position text null, bout_order int,
  status text check in (announced, confirmed, cancelled, replaced, complete),
  replaced_bout_id uuid null, short_notice_days int null, source_url, captured_at

ufc_bout_results
  bout_id pk fk, winner_id fk null, method text, round int, time_sec int, time_format text,
  referee text, judge_1 text, judge_2 text, judge_3 text, scorecards jsonb, finish_detail text,
  has_stats bool, source_url, captured_at

ufc_bout_round_stats
  bout_id fk, fighter_id fk, round int,
  kd int, sig_str_landed int, sig_str_att int, total_str_landed int, total_str_att int,
  td_landed int, td_att int, sub_att int, rev int, ctrl_sec int,
  head_landed int, head_att int, body_landed int, body_att int, leg_landed int, leg_att int,
  distance_landed int, distance_att int, clinch_landed int, clinch_att int, ground_landed int, ground_att int
  pk (bout_id, fighter_id, round)

ufc_ingest_runs
  id, worker text, started_at, finished_at, events_new int, bouts_new int, fighters_touched int,
  assertion_failures jsonb, status text
```

Phase 2+ tables (define later, do not create now): `ufc_bout_changes`, `ufc_medical_suspensions`, `ufc_weigh_ins`, `ufc_officials`, `ufc_bout_officials`, `ufc_odds`, `ufc_fighter_features`, `ufc_model_runs`, `ufc_predictions`, `ufc_picks`, `ufc_model_metrics`, `ufc_news_items`, `ufc_rankings_history`, `ufc_subscriptions`.

## Backfill script requirements

- `python backfill_ufcstats.py --phase {events|fighters|fights|all} --since YYYY-MM-DD --limit N --raw-to-r2`
- Resumable: skips any `ufcstats_id` already present unless `--force`.
- Order: fighters list → events list → per event: bouts → per bout: fight page → touch both fighter pages if not yet fetched.
- Batched Supabase writes (500 rows), fresh connection per batch, retry with backoff on 5xx.
- Logs to stdout + a JSONL run log; on any schema assertion failure: stop, print the offending URL, and (if configured) post to Discord.
- Dry-run flag that parses and prints counts without writing.

## Incremental Worker requirements (`ufc-stats-ingest`)

- Cron: daily 06:00 UTC (Sunday-after-card is the important one; daily is fine).
- Steps: fetch completed list → rows not in `ufc_events` → for each new event: event page → bouts → fight pages → results + round stats → refresh both fighter pages. Fetch upcoming list every run; an announced bout that vanished writes a note to `ufc_ingest_runs.assertion_failures` (the Phase 2 card watcher takes over real change tracking).
- Set `card_status='complete'` when every bout on the event has a result.
- Write one `ufc_ingest_runs` row per run. Post a one-line Discord summary on success, a loud message on assertion failure.
- Keep it under Workers subrequest limits: one event per invocation is the normal case; if more than 3 new events are found, process 3 and leave the rest for the next run.

## Verification / acceptance criteria for Phase 1

Produce `/docs/phase1_verification.md` with:
- Row counts: fighters, events, bouts, results, round-stats rows.
- Events on UFC Stats completed list vs `ufc_events` — must be 100%.
- Bouts per event vs event-page row count — must match per event.
- Count of results with `has_stats=false` (expected to be non-zero for early-era fights; list them).
- Fighter fight-history count vs our bout count per fighter — list mismatches.
- Alias review queue size and the top 20 suspicious near-duplicate names.
- Any assertion failures encountered and how they were resolved.
- Spot-check: pick 5 recent fights, compare parsed round stats to the live page by hand, confirm exact match.

Phase 1 is done when all of the above is true and the Worker has run successfully on a real new event.

## Roadmap after Phase 1 (context only)

- **Phase 2 — availability:** `ufc-card-watcher` (UFC.com + ESPN diffing → `ufc_bout_changes`, Discord/X alerts, weigh-in mode Fridays), `ufc-commission-scraper` (NSAC/CSAC medical suspensions → `ufc_medical_suspensions`).
- **Phase 3 — market:** extend the existing odds cache worker for `mma_mixed_martial_arts` h2h + totals (The Odds API covers fight winner and limited total rounds only — no method/round props), then per-book prop scrapers with kill switches → `ufc_odds`.
- **Phase 4 — model:** `ufc-feature-builder` (as-of features, Elo/Glicko, short-notice and weight-miss adjustments), `ufc-model-runner` (win prob, method multinomial, rounds hazard), `ufc-grader` (results, CLV, void on cancelled bouts), metrics + track record. Out-of-time holdout on 2025+ events.
- **Phase 5 — product:** clone NFL auth (signed-cookie sessions + Resend magic links), Stripe webhook → `ufc_subscriptions` ($14.99/mo or $5.99/card pass), news digest with UFC taxonomy, free SEO pages (fighter, event, A-vs-B), paywall.

## TRACK B — News outlet (top of funnel), runs in parallel with Phase 1

Track B depends only on `ufc_fighters`, `ufc_events`, `ufc_bouts` and the alias resolver. It does NOT depend on odds, models, or picks. Start it once Phase 1's migration is applied and the fighter/event backfill is loaded; do not block it on Phase 1 verification of round stats.

Reference: propbetedge.ai (MLB) already runs a news-outlet top of funnel with photos and frequent updates. Same idea here, tuned to UFC's cadence.

### Cadence — event-aware, never fake-hourly
- Fight week (Mon–Sat of an event): ingest every 30 min; publish as stories qualify, cap ~2/hr.
- Off weeks: ingest every 2h; 3–6 stories/day.
- Always-on triggers from our own tables, regardless of schedule: bout added/cancelled/replaced, weight miss, ranking change, medical suspension posted, line move >10% (once odds exist). Internal triggers are the stories nobody else has first.
- Do not pad volume. Empty hours are fine. Scaled thin content is the main risk to the whole domain.

### Story types
Every story must include data from our own tables so it is never a rewrite of someone else's reporting.
1. Card change / injury — what changed, replacement's stats, short-notice history, line move if available.
2. Rankings update — movers and the fights that moved them.
3. Fight preview — one per bout, auto-generated A-vs-B: tale of the tape, style matchup, market odds; refreshed when lines move. Primary SEO surface.
4. Weigh-in report — Friday; misses flagged with historical weight-miss performance.
5. Results + what's next — Saturday night per bout, with stats; suspension follow-up Monday.
6. Line movement — with a chart (Phase 3+ once `ufc_odds` exists).
7. Aggregated external news — short, attributed, linked to the original, never more than a phrase reproduced. Smallest share of output.

### Photos — licensing rules (hard)
- NEVER use UFC/Zuffa/Getty/ESPN/Sherdog imagery.
- NEVER AI-generate a real fighter's likeness.
- Hero image options, in order: (a) server-rendered stat cards (tale of the tape, rankings ladder, odds move) via satori/resvg in a Worker, cached in R2 — default; (b) Wikimedia Commons CC-licensed fighter portraits — store `license`, `author`, `source_url` per image and render the credit line; fall back to (a) when coverage is missing; (c) embedded X posts for breaking news (their content stays theirs).

### Tables
```sql
ufc_news_sources   id, kind (rss|x_list|internal), url, name, weight, enabled
ufc_news_items     id, source_id, url unique, title, published_at, summary, taxonomy jsonb,
                   fighter_ids uuid[], bout_id, event_id, fingerprint text unique, captured_at
ufc_articles       id, slug unique, headline, dek, body_md, story_type, status (draft|review|published),
                   hero_image_ref, hero_credit jsonb, sources jsonb, fighter_ids uuid[], bout_id, event_id,
                   model_version, published_at, updated_at, needs_human bool
ufc_images         id, kind (statcard|wikimedia), r2_key, license, author, source_url, fighter_id, created_at
```

### Workers
- `ufc-news-ingest` — pulls `ufc_news_sources` on the cadence above; dedupes by URL + title fingerprint; classifies with the taxonomy (withdrawal, replacement, weight_miss, bout_moved, injury, suspension, rankings, contract, result, other); links entities via `/shared/alias_resolver`; writes `ufc_news_items`.
- `ufc-news-writer` — turns qualified items + internal triggers into `ufc_articles`. Sonnet-class model, strict system prompt, and a fact block injected from Supabase (records, physicals, last 5 results, event/date/venue) — the model may not state a fact that isn't in the fact block or the source item. Anything classified `injury` or `withdrawal` naming a fighter is written with `needs_human=true` and `status='review'` until Justin flips a config flag. Output must be short, sourced, and end with the funnel hook (see below).
- `ufc-image-render` — stat cards on demand from a template set; cache to R2; return key.
- Distribution: on publish → post to X with the stat card; card-change stories also → Discord. The existing MLB `propbet-news-digest` pattern is the model; here the digest reads from `ufc_articles` rather than running its own pipeline.

### Frontend (Vercel, same repo `/web`)
- Routes: `/news`, `/news/[slug]`, `/fighters/[slug]`, `/events/[slug]`, `/fights/[a]-vs-[b]-[event]`. Fighter and event pages list related articles.
- `NewsArticle` + `SportsEvent` JSON-LD, RSS feed at `/feed.xml`, sitemap with `lastmod`, canonical URLs, an About/Editorial-policy page (required for Google News / Publisher Center — apply at ~50 published articles).
- ISR/revalidate on publish webhook.

### Funnel hooks inside stories
Fight previews end with an "algo lean: locked" block and a blurred edge number; card-change stories show the line move but not the re-priced pick; results stories link to the track record page. All of these render as placeholders until Phase 4 exists — build the slots now.

### Track B acceptance
- 20 published articles across at least 4 story types, all with a licensed/rendered hero image and correct credit.
- Zero articles containing a fact not present in the fact block or source item (spot-check 10).
- Injury/withdrawal stories correctly held in `review`.
- RSS validates; JSON-LD validates in Google's Rich Results test; one X auto-post round-trips with the stat card.

## First message to send Claude Code

> Read `/docs/UFC_PROPBETEDGE_CLAUDE_CODE_BRIEF.md` in full. Phase 1 first, then Track B. Start by fetching one live page of each UFC Stats type (completed events list, one event page, one fight-details page, one fighter page) and report whether the selectors/headers in the brief match. Do not write parsers until you've confirmed. Then create the migration (Phase 1 + Track B tables together), the backfill script, and the ingest Worker in that order. Once fighters and events are loaded, start Track B: news tables, `ufc-news-ingest`, `ufc-image-render`, `ufc-news-writer`, then the `/web` routes. Ask me before creating the GitHub repo, before any Supabase migration is applied, and before the first X auto-post goes live.
