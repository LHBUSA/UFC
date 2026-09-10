# Official video layer

Implements `docs/UFC_MEDIA_VIDEO_ADDENDUM.md` sections 4-6 and 10. Tables:
`ufc_video_channels` (allowlist) and `ufc_videos` (normalized metadata), both from
`migrations/013_ufc_media_registry_videos.sql`. Code: `scripts/videos/`
(`channels.json`, `seed_channels.mjs`, `ingest_youtube.mjs`, `lib.mjs`,
`lib.test.mjs`). Node 24, no npm dependencies; Supabase creds from `.env`.

**Rights rule.** Nothing is downloaded or rehosted. A row is a YouTube video id
plus metadata (title, description, published time, thumbnail URL, embeddability);
the site builds `https://www.youtube-nocookie.com/embed/<id>` at render time
behind a poster-first click (addendum section 7) and drops the player when
`embeddable` is not `true`.

## Allowlist policy

Automatic publication reads only channels that are **enabled and verified** in
`ufc_video_channels`. Exact channel IDs only; handles are evidence, never keys
(`@UFCBrasil` on YouTube is a Brazilian university, not the UFC).

`scripts/videos/channels.json` lists each channel with its class and the checks
it must pass. `seed_channels.mjs` re-proves those checks live on every run and
writes the result into `verification` (`{method, checks, feed_title,
expected_feed_title, channel_canonical, featured_on, handle, checked_at, ...}`):

| check | proof |
|---|---|
| `feed_title` | `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` has `<title>` equal to `feed_title` |
| `verified_badge` | the channel page at `/channel/<id>` is canonical for that id and carries YouTube's `BADGE_STYLE_TYPE_VERIFIED` |
| `featured_on_ufc_channel` | the id sits in the featured-channels grid (`gridChannelRenderer`) of the verified UFC channel page, `UCvgfXK4nTYKudb0rFR6noLA` |

A channel that fails any expected check is written `verified=false, enabled=false`
(never deleted); a channel removed from `channels.json` is disabled. `enabled` in
the JSON is honoured only for channels that verify.

Seeded on 2026-09-06:

| channel | id | class | proof | enabled |
|---|---|---|---|---|
| UFC | `UCvgfXK4nTYKudb0rFR6noLA` | ufc_official | feed title + verified badge | yes |
| UFC Brasil (`@UFCBR`) | `UCk8XGxi7fsTqQQRVq9LSraw` | ufc_regional | feed title + featured on UFC | yes |
| UFC Espanol (`@ufcespanol`) | `UCYXJFtx4SUkrb2p_8mhLPzQ` | ufc_regional | feed title + featured on UFC | yes |
| ESPN MMA | `UCO4AcsPKEkIqDmbeiZLfd1A` | broadcast_partner | feed title + verified badge | yes |
| UFC FIGHT PASS, UFC Eurasia, UFC Japan, UFC Quebec | see JSON | official / regional | feed title + featured on UFC | no (verified, outside the initial candidate list; flip `enabled` to switch on) |

Left out, with the reason recorded under `_rejected` in the JSON: `@UFCBrasil`
(university), `@UFCEurope` and `@UFCAsia` (empty feeds, no badge, not featured),
UFC Australia & New Zealand (no such handle, not featured). Fan compilations and
reuploads are never added.

## Discovery paths

`ingest_youtube.mjs` picks the path from the environment and records it in
`source_metadata.discovery`:

**`youtube_data_api_v3`** (persistent contract, used when `YOUTUBE_API_KEY` is
set): `channels.list` (uploads playlist id) -> `playlistItems.list` (50 per page,
newest first, stops at the first page entirely older than `--since-days`) ->
`videos.list` in batches of 50 for `contentDetails.duration` -> `duration_sec`,
`status.embeddable`, `status.privacyStatus`, `snippet.liveBroadcastContent` (+
`completed` when `liveStreamingDetails.actualEndTime` exists) and the best
thumbnail. One quota unit per call; no `search.list`.

**`atom_feed`** (temporary path permitted by addendum section 6, used when the
key is absent): the channel's public Atom feed, newest ~15 uploads including
Shorts and live streams, gives id, title, published/updated, alternate link,
thumbnail and description. Embeddability is confirmed once per new video with
oEmbed (`https://www.youtube.com/oembed?url=...watch?v=<id>&format=json`): 200
-> `embeddable=true`; any other status (401 embedding disabled, 403 private,
400/404 unavailable) -> `false`; a transport failure leaves `null` and is
retried on the next run. `duration_sec` and `live_broadcast_state` stay `null`
on this path; `source_metadata.is_short` comes from the `/shorts/` link.

Rows carry the canonical `https://www.youtube.com/watch?v=<id>` in `url`; the
feed's own link (watch or shorts) is kept in `source_metadata.feed_link`.

Usage:

```
node scripts/videos/seed_channels.mjs [--dry-run]
node scripts/videos/ingest_youtube.mjs [--dry-run] [--since-days N] [--channel <id>] [--relink]
node --test scripts/videos/lib.test.mjs
```

`--dry-run` prints the plan (new / updated / unchanged per video) and writes
nothing. `--since-days` (default 30) drops older uploads. `--relink` recomputes
classification and links for the stored rows without touching YouTube; run it
after a fighter/event load. Upserts are on `(provider, provider_video_id)`;
rows whose persisted columns, links or evidence did not change are not
rewritten, so a rerun is a no-op. A row a human set to `link_status='rejected'`
keeps its links and status across reruns.

## Classification

`video_type` comes from the title; the first family in this order whose pattern
hits wins, and every hit is kept in `source_metadata.classification.evidence`
(`{video_type, source, match}`):

| video_type | title patterns |
|---|---|
| `embedded_episode` | "Embedded" |
| `countdown` | "Countdown"; "Cuenta regresiva", "Contagem regressiva" |
| `post_fight` | "Post-Fight", "Post Fight", "Post Show" (beats press conference: a post-fight presser is the POST media event); "Pós-Show", "Pós-Luta", "Post-Pelea" |
| `press_conference` | "Press Conference", "Presser"; "Coletiva", "Conferencia/Rueda de prensa" |
| `media_day` | "Media Day"; "Dia de Mídia", "Día de Medios" |
| `weigh_in` | "Weigh-In", "Weigh In", "Weigh-ins"; "Pesagem", "Pesaje" |
| `faceoff` | "Faceoff", "Face Off", "Staredown", "Stare Down"; "Encarada(s)", "Careo(s)" |
| `full_fight` | "Free Fight", "Full Fight"; "Luta/Pelea completa", "Evento completo", "Maratón" |
| `highlights` | "Highlights", "Every Knockout/Finish/Submission", "Best Finishes/Knockouts/Moments"; "Melhores/Mejores momentos", "Nocautes", "Finalizações", "Resumen" |
| `fight_preview` | "Preview", "Promo", "Fight Week"; "Pré-Show", "Prévia", "Previa", "Cartelera", "Panorama" |
| `analysis` | "Breakdown", "Recap", "Analysis", "Film Room", "Round-by-Round"; "Análise", "Análisis" |
| `interview` | "Interview", "sits down with", "1-on-1", "Q&A", "Exclusive"; "Entrevista" |
| `other` | nothing matched |

Only when the title says nothing are the description's strong, format-naming
families consulted (embedded, countdown, press conference, media day, weigh-in,
full fight). The description boilerplate every UFC upload carries ("Watch UFC
on ...", "UFC Video Archive") therefore classifies nothing.

## Linking and confidence

Context: `ufc_events` within +-45 days of today (deduped ESPN/UFC Stats copies as
the newsroom does), their non-cancelled `ufc_bouts`, the fighters on those bouts
("card fighters"), and published `ufc_articles` per bout. Hashtags are expanded
before matching (`#ufcparis` -> "ufc paris", `#UFC331` -> "ufc 331", `#NocheUFC`
-> "noche ufc", `#DWCS` -> "contender series").

**Event.** Keys per event, strongest first: number ("ufc 331"); full name and
the "A vs B" tail; series head ("noche ufc", "contender series"/"dwcs"); city
("ufc paris", "ufc vegas" -> Las Vegas, never for Contender Series cards);
headliners (both surnames of the "A vs B" tail, >= 4 chars each). Title hits
outrank description hits at the same level. The strongest hit wins; if that key
belongs to several cards (a series or city shared by two events) the card nearest
the publish date wins only when it is at least 2 days nearer than the next one.
Two different events at the same strength ("UFC 330 recap and UFC 331 preview"),
or a date tie, produce no event and a `multiple_events` review.

**Fighters** (via the alias resolver's names and aliases, multi-token only):
1. full name found in title or description, searched among the linked event's
   card, then the +-45d card fighters, then the whole table; attached only when
   exactly one fighter carries the name in the first pool that contains it;
2. surname (>= 4 chars, title only, not on the stoplist of ordinary words and
   "White"), scoped to the linked event's card when an event is known (a surname
   absent from that card attaches nothing: "Lopes vs. Silva" replayed under a
   `#NocheUFC` tag is a past bout), otherwise to the +-45d card fighters;
   attached only when exactly one fighter in scope has it;
3. anything with 2+ candidates becomes an `ambiguous_fighter_name` /
   `ambiguous_surname` review item and is **not** attached. No guesses.

**Bout.** Both fighters of one bout must be attached **from the title**
(descriptions name the main event of every fight-week upload). The linked event's
bouts are searched first; a bout found without an event sets the event.

**Article.** Set only when exactly one published article exists for the linked
bout.

`resolver_confidence`: `high` = event + bout (both fighters); `medium` = event, or
a full-name fighter; `low` = surname-only fighters, no event; `none` otherwise.
`link_status` is `review` whenever any ambiguity was recorded
(`source_metadata.review_reason`, details in `source_metadata.review`); the
unambiguous parts of the link are still stored so a reviewer only decides the
open question. `published` otherwise; `rejected` is set by people.
`source_metadata.linking` records the key, kind and method behind every link.

## Ledger note

Video publications are **media events only** (addendum section 10): "Embedded
episode published", "post-fight press conference published". They may enrich the
fight-week timeline of `docs/fight_state_ledger.md`, but nothing about injuries,
weight cuts, camp or tactics is inferred from a title, thumbnail or description.
If transcript analysis is added later, every extracted claim must keep the video
id, timestamp and speaker attribution.

## Adding the Data API key

1. Create an API key in Google Cloud with **YouTube Data API v3** enabled
   (restrict it to that API).
2. Add `YOUTUBE_API_KEY=<key>` to `.env` (or the environment of the scheduler).
3. Run `node scripts/videos/ingest_youtube.mjs --dry-run` and confirm
   `discovery=youtube_data_api_v3`; then run for real. Existing rows are updated in
   place with `duration_sec`, `status.embeddable` and `live_broadcast_state`, and
   `source_metadata.discovery` flips to the API path. Nothing else changes: the
   same table, same classification, same linking.

Routine cost at 4 channels is about 3-5 quota units per channel per run, far
below the 10,000/day default.

## Cadence and deployment (autopilot)

`.github/workflows/video-autopilot.yml` runs `seed_channels.mjs` (re-verifies the
allowlist) and `ingest_youtube.mjs` (feed/oEmbed or Data API when
`YOUTUBE_API_KEY` is set, classify, resolve, upsert on
`(provider, provider_video_id)`) at `:17` and `:47` every hour, plus
`workflow_dispatch` (`since_days`, `relink`, `dry_run`). It checks out
`ufc-fight-dna-v1` and needs the repository secrets `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (present); `YOUTUBE_API_KEY` is optional and
upgrades discovery to the Data API (durations, live state, exact embeddability).

GitHub fires `schedule` only from the default branch. While this file lives on
`ufc-fight-dna-v1` the cadence is branch-ready, not live; run it on demand with
`gh workflow run video-autopilot.yml --ref ufc-fight-dna-v1`. Once the workflow
file exists on `main` (this was written when `newsroom.yml` scheduled production;
it no longer does -- video ingest is `workers/ufc-video-autopilot`, cron
`13,43 * * * *`) checking out the
release branch), the 30-minute cadence is live with no further change.

## Content language (V1 strategy)

Every row carries `source_metadata.language` (`en` · `es` · `pt` · `unknown`, with
`language_method` = channel | title | none) written by the ingest from the channel
(UFC Brasil → pt, UFC Espanol → es, UFC / ESPN MMA / other official English
channels → en) with a title check for the rare Spanish/Portuguese-titled clip on an
English channel. When the Data API key is present, `source_metadata.region_restriction`
records YouTube's `contentDetails.regionRestriction` (allowed / blocked country lists).

The web (`web/lib/videoPolicy.ts`) derives the same language when metadata is missing,
labels every card (ENGLISH · SPANISH · PORTUGUESE), and ranks surfaced videos by:
language (English-first by default) → embeddable → viewable (not region-blocked for US
where recorded) → official tier (UFC, ESPN MMA → Fight Pass / other official English →
regional non-English) → freshness → relevance. Freshness never outranks usability.

Rails carry an All · English · Spanish · Portuguese filter (default English when at
least two English clips exist, otherwise All, always labelled). The filter can be
preset from the URL: `?lang=en|es|pt|all`. This is content-language filtering only —
no locale-routed page tree, no application translation. A later language-aware
surfacing layer can read the same `lang` state.

Embed fallback: the player is created with `enablejsapi=1`; if YouTube reports error
100/101/150 (removed, embedding disabled, region-restricted) the card keeps its poster,
shows "Not available for embedded playback in your region." and a Watch on YouTube CTA.
Rows with a recorded US block never start as a player.

## Surfaces

The web layer reads only `link_status='published'` rows from verified channels
with `embeddable` not false (`web/lib/db.ts` video helpers) and renders them
poster-first through `components/OfficialVideo.tsx` / `components/VideoRail.tsx`:
homepage video desk (`getFightWeekVideos`: this fight week's videos ranked
embedded → countdown → press conference → weigh-in → …, then the freshest
official uploads), event page timeline (`sortVideosTimeline`, grouped by
fight-week stage), fighter page rail (`getVideosForFighters`, medium/high
resolver confidence only), article rail (article → bout → event links), and
the Dana White profile (`getVideosMentioning("Dana White")` on the official
channel). An empty result renders nothing; no surface ever shows an unrelated
dump.
