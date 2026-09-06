# PropSports UFC API v1

Status: live at `https://ufc-api.propbetedge.ai` (Worker `propbetedge-ufc-api`, `workers/ufc-api`). Contract version `2026-09-06.2` (branch `ufc-production-v3`, Track B). Every change since `2026-09-06` is additive: no field was removed or renamed.

## Architecture

The public UFC product is intentionally split into four layers:

1. Source ingest: ESPN for schedule/results/identity plus UFC Stats for historical and round-level statistics; ufc.com for official rankings; Wikimedia Commons (license allowlist) for fighter portraits.
2. Normalized `ufc_*` tables in Supabase plus the public Storage bucket `ufc-media` (portraits, rankings snapshot). RLS remains closed; the service role is never exposed to browsers or customers.
3. `workers/ufc-api`: read-only Cloudflare Worker that owns the external contract.
4. `ufc.propbetedge.ai`: a client of that API contract, not a direct Supabase consumer.

This keeps the website, future PropSports customers, MCP, mobile apps, and internal tools on one stable data contract.

## Contract principles

- Read-only in v1.
- No browser or customer receives a Supabase service-role credential.
- No fabricated rankings, odds, picks, images, or editorial facts.
- Missing source facts remain `null` or an explicit unavailable response.
- Source-specific IDs are accepted for canonical lookup: internal UUID, UFCStats ID, or ESPN ID.
- Historical/display career snapshots are labeled so they are not accidentally used as as-of model features.
- Responses use a stable envelope: `{ ok, data, meta }`; failures use `{ ok:false, data:null, error, meta }`.
- All responses carry `X-Request-Id` and `X-API-Version`.
- Public GET responses are edge-cacheable. Upcoming/news/search surfaces use shorter TTLs than historical data.
- Expansion is opt-in via `?include=`; default responses never grow because a client asked for more elsewhere.

## Endpoints

- `GET /v1/ufc` — index; advertises every route and `media_base_url`.
- `GET /v1/ufc/events?status=upcoming|recent|all&date=YYYY-MM-DD&limit=N`
- `GET /v1/ufc/events/{id}`
- `GET /v1/ufc/events/{id}/card?include=media,results,stats` — composite event page.
- `GET /v1/ufc/events/{id}/articles?limit=N`
- `GET /v1/ufc/fighters?q=&active=true|false&limit=N&offset=N` — rows carry `primary_image`.
- `GET /v1/ufc/fighters/media?ids=a,b,c` — bulk `primary_image` map, max 150 UUIDs.
- `GET /v1/ufc/fighters/{id}?include=media,ranking,next,history,stats&history_limit=N` — composite fighter page.
- `GET /v1/ufc/fighters/{id}/history?limit=N` — rows add `opponent`, `outcome`, `is_fighter_a`.
- `GET /v1/ufc/fighters/{id}/stats` — career snapshot + `round_stats[]` + `computed`.
- `GET /v1/ufc/fighters/{id}/articles?limit=N`
- `GET /v1/ufc/bouts/{id}`
- `GET /v1/ufc/bouts/{id}/stats` — rounds + per-fighter `totals` + `fight_time_sec` + provenance.
- `GET /v1/ufc/results?limit=N`
- `GET /v1/ufc/rankings?division=&womens=` — verified ufc.com snapshot; `503 rankings_not_available` when no store exists.
- `GET /v1/ufc/news?story_type=&limit=N&offset=N` — rows carry `hero_image_url` + `hero_image`.
- `GET /v1/ufc/articles/{slug}`
- `GET /v1/ufc/search?q=&limit=N` — fighters (with `primary_image`, `slug_id`), events, articles (with hero media).
- `GET /v1/ufc/counts` — adds `images`, `fighters_with_media`, `rounds` (alias of `round_stat_rows`).

## Media contract (B1)

Durable origin: the public Supabase Storage bucket `ufc-media`, configured as `UFC_IMAGE_BASE_URL` in `wrangler.toml`
(`https://tkmlnhmylqnttmnsnief.supabase.co/storage/v1/object/public/ufc-media`). Every `ufc_images.r2_key` resolves to
`image_url = {base}/{r2_key}`. For the portrait layout `fighters/<fighter_id>/portrait.jpg` the pipeline also writes
`card.jpg` (800x1000) and `thumb.jpg` (320x400) beside it, so the API derives `card_url` / `thumb_url`; for any other key
those are `null` (never guessed).

`primary_image` (compact, or `null` when no approved image exists):

```json
{
  "id": "006e6554-f441-4892-8a49-30409d01e52e",
  "image_url": ".../ufc-media/fighters/<id>/portrait.jpg",
  "card_url": ".../ufc-media/fighters/<id>/card.jpg",
  "thumb_url": ".../ufc-media/fighters/<id>/thumb.jpg",
  "author": "MMAnytt",
  "license": "CC BY-SA 4.0",
  "source_url": "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png",
  "kind": "wikimedia"
}
```

Where it appears: `/fighters` list rows, `/fighters/media`, fighter detail (alongside the full `images[]`, whose entries
also carry `image_url`/`card_url`/`thumb_url`), event-card `fighter_a`/`fighter_b`, search fighter hits, history/next-bout
`opponent`, and computed-stats `opponent`. The full `images[]` array stays on fighter detail and event-card fighters only.
Render `author`, `license`, `source_url` as the credit wherever the image is shown.

## Rankings contract (B2)

`/v1/ufc/rankings` serves the verified store written by `scripts/rankings/ingest_rankings.mjs` (see `docs/rankings.md`):
the `ufc_rankings` table when migration 003 is applied and populated, else the Storage snapshot `rankings/latest.json`.
The table is probed once per isolate (re-probed every 10 minutes); a PostgREST 404 means "not applied". `meta.store` is
`table` or `snapshot`. When neither exists the response is `503 rankings_not_available` with `data: null`.

```json
{
  "source": "ufc.com official rankings",
  "source_url": "https://www.ufc.com/rankings",
  "snapshot_date": "2026-09-06",
  "captured_at": "2026-09-06T14:05:11.339Z",
  "divisions": [
    {
      "key": "MIDDLEWEIGHT", "label": "Middleweight", "is_womens": false, "is_p4p": false,
      "champion": { "name": "Sean Strickland", "ufc_slug": "sean-strickland", "fighter_id": "ec94…", "fighter": { "id": "ec94…", "name": "Sean Strickland", "slug_id": "3093653" } },
      "entries": [ { "rank": 1, "name": "…", "ufc_slug": "…", "fighter_id": "…", "change": 0, "is_new": false, "fighter": { "id": "…", "name": "…", "slug_id": "…" } } ]
    }
  ]
}
```

- Division order is the official page order (men's P4P, men's Flyweight→Heavyweight, women's P4P, women's Strawweight→Bantamweight); entries are sorted by rank then name. Ties are real (competition ranking), so ranks are not always contiguous.
- P4P lists have `champion: null`; their #1 is entry rank 1.
- `fighter` is `null` when the ingest could not link the name unambiguously; `fighter_id` is then `null` too. Nothing is guessed.
- `slug_id` = `espn_athlete_id || ufcstats_id`, the id the web uses in `/fighters/<slugified-name>-<slug_id>`.
- Filters: `?division=MIDDLEWEIGHT` (case-insensitive, `-` accepted for `_`), `?womens=true|false`. An unmatched `division` is `404 division_not_found`.

Per-fighter ranking state is available on fighter detail via `include=ranking` (`ranking.positions[]`, `rank: 0` = champion; `ranking: null` when no store exists; `positions: []` when unranked).

## Article media contract (B3)

`ufc_articles.hero_image_ref` is a `ufc_images.id` (or a storage key); `hero_credit` is `{author, license, source_url}`.
`/news`, `/articles/{slug}`, `/events/{id}/articles`, `/fighters/{id}/articles` and search article hits add:

- `hero_image_url` — durable URL, or `null`.
- `hero_image` — `{id, image_url, card_url, thumb_url, author, license, source_url, kind, fighter_id, ref}` or `null`. The article's `hero_credit` wins over the image row's credit.

A `hero_image_ref` that resolves to nothing yields `null` for both; nothing is fabricated. `hero_image_ref` and `hero_credit` remain as before.

## Composite contracts (B4)

### Fighter page — `GET /v1/ufc/fighters/{id}?include=media,ranking,next,history,stats`

Default response unchanged (fighter + `slug_id` + `images[]` + `primary_image`). Each include adds one block:

| include | adds | notes |
| --- | --- | --- |
| `media` | — | accepted for symmetry; media is always on |
| `ranking` | `ranking` | `FighterRanking` or `null` |
| `next` | `next_bout` | next scheduled bout (event date ≥ today, no result, not cancelled/replaced) with `event`, `opponent`, `is_fighter_a`; or `null` |
| `history` | `history[]` | bout rows with `fighter_a`/`fighter_b`/`result`/`event` plus `opponent` (compact, with `primary_image`), `outcome` (`W`/`L`/`D`/`NC`/`null`), newest first; `history_limit` 1..250 |
| `stats` | `stats` | `career_snapshot` + `warning` (display-only leakage note) + `computed` (see below) |

Unknown include values return `400 invalid_include`. `meta.include` echoes what was applied.

### Event page — `GET /v1/ufc/events/{id}/card?include=media,results,stats`

Default response unchanged (`event` + ordered `bouts[]` with fighter `images[]`/`primary_image` and `result`). `stats` adds
`round_stats[]` (both fighters, every round) and `stat_totals` (keyed by fighter id, `RoundStatTotals`) to every bout in one
extra query; bouts without rows get `[]` / `{}`. `meta.round_stat_rows` reports the total.

### Archive grids — `GET /v1/ufc/fighters/media?ids=…`

`data.media[fighter_id] = primary_image | null` for up to 150 UUIDs; `meta.requested` / `meta.found`. Non-UUID ids are
`400 invalid_ids`; more than 150 is `400 too_many_ids`. Cached for an hour at the edge.

## Round stats (B5)

`/bouts/{id}/stats` returns every `ufc_bout_round_stats` column the web reads (`kd`, `sig_str_*`, `total_str_*`, `td_*`,
`sub_att`, `rev`, `ctrl_sec`, `head/body/leg/distance/clinch/ground _landed/_att`) plus `totals` per fighter,
`fight_time_sec` / `fight_time_basis` and `provenance`. `/fighters/{id}/stats` returns all of the fighter's round rows plus:

```
computed.provenance  { source: "ufcstats_round_stats", bouts_with_stats, rounds, fight_time_sec, fight_time_basis: {result, rounds_x_5min}, method, coverage_note }
computed.career_totals  RoundStatTotals (null only when every round is null)
computed.career_rates   sig_str_landed_per_min, sig_str_accuracy, total_str_accuracy, td_per_15min, td_accuracy, sub_att_per_15min, kd_per_15min, ctrl_share, head/body/leg/distance/clinch/ground_share (null when the denominator is unknown)
computed.bouts[]        { bout_id, event, opponent, result, outcome, rounds, fight_time_sec, fight_time_basis, totals, rounds_detail[] } newest first
```

Fight time comes from the recorded result (`(round-1)*300 + time_sec`, basis `result`) or, without a result, rounds-with-stats × 5:00
(basis `rounds_x_5min`). Coverage is partial while the UFC Stats backfill runs; these are not as-of model features.

## Authentication

During internal beta, `REQUIRE_API_KEY=false` can be used while the website migration is proven.

For commercial mode set `REQUIRE_API_KEY=true` and use either:

- `INTERNAL_API_KEY` Wrangler secret for the first-party website/server; or
- an `API_KEYS` KV binding. Customer keys are stored only as `key:<sha256(raw-key)>` records, for example:

```json
{
  "id": "customer_123",
  "tier": "developer",
  "enabled": true,
  "expires_at": null
}
```

The raw customer key is never stored in KV.

## Deployment gate

Before production promotion (`workers/ufc-api`):

1. `npm install`
2. `npm test` — unit tests drive the Worker end-to-end against a PostgREST/Storage mock (fighter with/without media, rankings from snapshot / table / absent, article with/without hero, includes, bulk media, counts).
3. `npm run check`
4. `npx wrangler deploy --dry-run`
5. `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (already set in production)
6. `npx wrangler deploy`
7. `node smoke_live.mjs` — read-only production smoke; proves every new field on real rows (Sean Strickland media, a fighter without media, the next card with `include=stats`, rankings, an article with and without a hero).
8. Set Vercel server env `UFC_API_BASE_URL` to the deployed worker origin.
9. If auth is enabled, set Vercel server env `UFC_API_KEY` to the internal key.
10. Deploy the web branch and verify parity against the current production site.
11. Only then merge to `main`.

`.github/workflows/ufc-api-live-smoke.yml` runs steps 2–3 and 7 on pushes to `ufc-api-v1` / `ufc-production-v3` that touch `workers/ufc-api/**`, on PRs to `main`, and on manual dispatch.

## Commercial follow-on

The same contract can later be mounted behind a PropSports API hostname and extended without breaking the website:

- card-change history
- weigh-ins
- officials/judges/referees
- medical suspensions where permitted
- odds and line movement
- verified rankings history (the `ufc_rankings` table keeps every snapshot day; the API serves the latest)
- as-of matchup features
- model probabilities and grading history
- MCP tools backed by these endpoints

Image licensing is independent of factual data licensing. Only image references with appropriate redistribution rights should be returned to third-party API customers.
