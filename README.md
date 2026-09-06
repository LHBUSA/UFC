# ufc.propbetedge.ai

Third PropBetEdge product line: the UFC data layer in Supabase (ESPN
schedule/results + UFC Stats round stats), the nightly ingest Worker, the
newsroom / rankings / portrait pipelines, and the Next.js site in `/web`
(docs/frontend.md).

Read `docs/UFC_PROPBETEDGE_CLAUDE_CODE_BRIEF.md` first, then
`docs/scraper_notes.md` for every place the live site disagrees with it.

## Layout

```
migrations/               SQL migrations, numbered. Applied by hand in the Supabase SQL editor (003 = rankings table, pending).
scripts/backfill/         backfill_ufcstats.py + parsers. Local Python 3.12+.
scripts/news/             seed_sources / ingest_news / write_articles (docs/news_pipeline.md)
scripts/rankings/         ingest_rankings.mjs -> Storage snapshot (docs/rankings.md)
scripts/images/           fetch_fighter_portraits.mjs -> licensed Wikimedia portraits (docs/images.md)
scripts/merge_events.py   one-off: fold ESPN duplicate event rows into UFC Stats rows
workers/ufc-stats-ingest/ nightly incremental Worker (deployed; cron 06:00 UTC)
web/                      Next.js site, ufc.propbetedge.ai (docs/frontend.md)
.github/workflows/        newsroom.yml: news every 2 h, rankings Tue/Wed, portraits daily
shared/                   enums.json, alias_resolver.{py,mjs}, tests. Both languages read enums.json.
docs/                     brief, scraper notes, verification reports, runbooks.
```

## Supabase

Project `tkmlnhmylqnttmnsnief` (the NFL instance; UFC stays off the MLB/PropData box). All tables are `ufc_*`,
RLS on, no anon policies. Writers use the service role.

## Running the alias resolver tests

```
python shared/tests/test_alias_resolver.py
node   shared/tests/test_alias_resolver.mjs
```

Both must print `OK`; they share `shared/tests/fixtures.json` so the two
implementations cannot drift.

## Backfill

```
cp .env.example .env         # fill in
cd scripts/backfill
python backfill_ufcstats.py --phase all --dry-run
python backfill_ufcstats.py --phase all --raw-to-r2
```

Resumable: anything whose `ufcstats_id` is already in Supabase is skipped
unless `--force`. Every schema assertion failure stops the run, prints the
URL, and posts to Discord if `DISCORD_WEBHOOK_URL` is set.

Source defaults to the Internet Archive (`--source wayback`); ufcstats.com is
never contacted by the backfill. ESPN-first rows are LINKED, not duplicated:
events by date (+-1 day), bouts by fighter pair, fighters through the alias
resolver with DOB. Pages with no archive capture are counted as
`wayback_missing_*` gaps. Long runs should be started detached (see
docs/scraper_notes.md); the verification report is
`python scripts/verify_phase1.py` -> docs/phase1_verification.md.

## Worker, run locally (production code path, no mocks)

```
node scripts/run_worker_local.mjs --dates 20251214 --max-events 1     # ESPN-only, one event
node scripts/run_worker_local.mjs --ufcstats                          # + UFC Stats round stats (needs parsers)
python scripts/inspect_event.py --espn-event-id 600056266             # eyeball what was written
```

## Migration verification (PostgREST only, no DB password)

```
python scripts/verify_migration.py --before <pre-migration OpenAPI snapshot>
```

