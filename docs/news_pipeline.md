# News pipeline (Track B)

Three plain-Node scripts in `scripts/news/` (no npm deps; `.env` supplies `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). Shared helpers live in `scripts/news/lib.mjs`.

## Sources (`ufc_news_sources`)
- RSS: MMA Fighting (`/rss/index.xml`, Atom), ESPN MMA (`/espn/rss/mma/news`), UFC.com News (`/rss/news`). Verified live by `seed_sources.mjs` before every upsert.
- Dropped at seed time because the feed does not verify: MMA Junkie (`/feed` 404), Bloody Elbow (`/feed` returns 403 to Node's fetch). A seeded source whose feed stops verifying is disabled, never deleted.
- `internal` / `propbetedge-tables` (weight 2): the source of every story built from our own tables.

## Cadence (from the brief; event-aware, never fake-hourly)
- Fight week (Mon-Sat of a card): `ingest_news.mjs` every 30 min, `write_articles.mjs` right after; publish as stories qualify, cap ~2/hr. Previews for the next two cards exist all week and refresh only when their fact block changes.
- Off weeks: ingest every 2 h; 3-6 stories a day is the ceiling, and an empty run is the correct output when nothing qualifies. Do not pad.
- Results stories are written the first run after results land (Saturday night / Sunday); add `--relink` to the next ingest so fight-week items pick up fighters and bouts that were loaded after they were captured.

## Running
1. `node scripts/news/seed_sources.mjs [--dry-run]` - verify feeds, upsert sources on `(kind, name)`. Idempotent.
2. `node scripts/news/ingest_news.mjs [--dry-run] [--max-age-days 14] [--relink]` - pull enabled RSS sources -> `ufc_news_items` (dedupe by `url` and `fingerprint`, classify, link fighter/event/bout). Prints per-source and total counts.
3. `node scripts/news/write_articles.mjs [--dry-run] [--types preview,results,external,card_change] [--limit N] [--llm] [--print] [--event <name>]` - builds fact blocks from our tables, then prose -> `ufc_articles`. `--llm` (needs `ANTHROPIC_API_KEY`) rewrites the template draft with `claude-sonnet-5` for flow only; the rewrite is rejected and the template kept if any number, heading, list line, link or the funnel hook changes. `model_version` records `template-1` or the model id.

## Review queue
`select * from ufc_articles where status = 'review'` (all have `needs_human = true`). Today that is every `external` story whose qualifying label is `injury` or `withdrawal` and that names a fighter. Publishing is a manual flip of `status` to `published` (set `published_at`); a refresh never demotes a row an editor has touched. `external` and `card_change` stories are never regenerated once written.

## Rule set (non-negotiable)
- Every story is generated from a stored `fact_block` built from `ufc_events`, `ufc_bouts`, `ufc_bout_results`, `ufc_bout_round_stats`, `ufc_fighters`; prose may not state anything outside that block or the cited news item. `sources` carries the fact-block hash, the tables used and any `news_item` id.
- No odds, picks, probabilities or predictions; previews end with the fixed "Algo lean: locked" hook and the "What to watch" section describes observable tape/archive facts only.
- External reporting: one quoted phrase (max six words of the title), source named and linked, everything else from our tables; items that link no fighter produce no story.
- Idempotent: a slug is never created twice; `results` / `fight_preview` refresh only when the fact-block hash changes (`updated_at` bumped).
- Hero image: `ufc_images.id` of the subject fighter's Wikimedia portrait with `{author, license, source_url}` copied into `hero_credit`; null when none exists (the site renders its own stat card). Never UFC/Zuffa/Getty/ESPN/Sherdog imagery.
