# PropBetEdge UFC — Fighter Media + Official Video Addendum

This addendum is mandatory for `ufc-fight-dna-v1` and all subsequent UFC product work.

## Product intent

The V3 shell is now visually credible, but real athlete media coverage is the biggest remaining presentation gap. PropBetEdge UFC should feel like a premium MMA intelligence product, not a database with initials.

At the same time, official video should become a first-class content type: previews, Embedded episodes, Countdown, press conferences, weigh-ins, faceoffs, interviews, highlights and post-fight media should connect directly to the event / fighter / bout / article intelligence graph.

The media layer must remain rights-safe. Do not download/rehost copyrighted UFC, ESPN, Getty, social or YouTube video content without an explicit license. YouTube video should be embedded from YouTube when embedding is permitted. Fighter photography must be either first-party licensed, public-domain, or under an allowed redistributable license.

---

# 1. Fighter-photo coverage is a product KPI

The current free-license pipeline is sound:

`ufc_fighters -> Wikidata identity -> Commons P18 -> license allowlist -> derived portrait/card/thumb -> first-party Storage -> ufc_images`

Keep that path, but change prioritization and coverage reporting.

## Priority order

1. fighters on the next UFC card
2. fighters on the next 4 UFC cards
3. ranked fighters / champions
4. active fighters
5. historical fighters

The pipeline should emit a report per event:

```text
Noche UFC
fighters: 26
licensed_media: 8
coverage: 30.8%
missing: 18
```

and a global report:

- total fighters
- fighters with portrait
- active coverage
- ranked coverage
- next-card coverage
- next-4-card coverage
- source/license breakdown
- unresolved/ambiguous identity count

## Target

The product goal is **100% next-card fighter media whenever rights-safe imagery exists**.

Do not loosen identity or license gates to hit the number.

---

# 2. Expand rights-safe fighter media sources

Do not treat Wikidata P18 as the only possible free source.

Implement source adapters with explicit source family + rights metadata.

Safe classes to support:

- Wikimedia Commons / Wikidata, existing allowlisted licenses
- verified public-domain government imagery where the fighter identity is certain
- manually uploaded first-party/licensed editorial imagery with explicit rights metadata
- future commercial editorial/image provider after contract/license review
- official press-kit imagery only when redistribution rights explicitly permit our use

Do **not** silently ingest:

- UFC.com copyrighted fighter images
- ESPN images
- Getty watermarked/editorial images
- Instagram/X/TikTok profile images
- Google image search results
- random blogs

unless a license/contract specifically authorizes display/redistribution.

## Media registry evolution

Design `ufc_images` / media metadata to support additional kinds without breaking existing rows:

- `wikimedia`
- `public_domain`
- `licensed_editorial`
- `official_press`
- `statcard`

Each real image requires:

- fighter_id
- source family
- source URL / provider asset ID
- author/photographer when supplied
- license/rights label
- attribution text
- rights expiry if applicable
- captured_at
- first-party derivative keys if storage is authorized

If a provider permits display but not storage, store the provider asset reference and serve according to contract rather than copying it to our bucket.

---

# 3. Photo presentation bar

## Event page

The first 3–5 bouts should feel like fight promotion cards, not rows of text.

When both portraits exist:

- larger opposing fighter images
- edge/rim lighting consistent with the PBE UFC design
- names + records + Fight DNA signals
- clear VS focal point
- no image stretching / low-resolution enlargement

The remaining card rows may remain compact, but use actual fighter thumbs whenever available.

## Fighter page

Real portrait should dominate the dossier hero when available.

Add:

- proper responsive art direction
- explicit photo credit/license link
- Fight DNA modules below/adjacent to portrait
- latest related official video module

## Matchup page

When both portraits exist, create a full face-off presentation.

If only one portrait exists, do not make the other side look broken: use the branded identity treatment deliberately.

## Fallback

Initials/octagon fallback remains legitimate only when rights-safe real media is unavailable.

Never use generated realistic fighter portraits as substitutes for real people.

---

# 4. Official YouTube video layer

Yes: official YouTube video should become a structured UFC product surface.

Use YouTube's own iframe/player infrastructure for playback. Do not download or rehost the underlying video.

Initial source strategy: **allowlisted channels only**.

Examples of channel classes that may be allowlisted after verifying exact channel IDs:

- UFC official channels
- official UFC regional/language channels
- ESPN MMA / official broadcast partners where embedding is permitted
- official promotion/broadcast sources relevant to a UFC event

Do not ingest random fan compilations or unverified reuploads by default.

---

# 5. Video ingestion contract

Add a normalized table such as `ufc_videos` / `ufc_media_videos` with fields along these lines:

```text
id
provider                  youtube
provider_video_id
channel_id
channel_name
channel_verified_source   boolean
url
title
description
published_at
duration_sec
thumbnail_url
embeddable
live_broadcast_state
video_type
fighter_ids[]
event_id
bout_id
article_id
resolver_confidence
source_metadata jsonb
captured_at
updated_at
```

Suggested `video_type` taxonomy:

- `embedded_episode`
- `countdown`
- `fight_preview`
- `full_fight`
- `highlights`
- `interview`
- `press_conference`
- `media_day`
- `weigh_in`
- `faceoff`
- `post_fight`
- `analysis`
- `other`

Identity linking must use the existing fighter alias/event resolver rather than fuzzy title matching alone.

Ambiguous fighter/event mappings go to review; they do not auto-publish as attached to the wrong fighter.

---

# 6. YouTube discovery / update method

Prefer YouTube Data API v3 with an API key for deterministic ingestion.

Efficient path:

1. maintain allowlisted exact channel IDs
2. `channels.list` -> retrieve each channel's uploads playlist
3. `playlistItems.list` -> ingest newest uploads incrementally
4. `videos.list` -> enrich duration/status/embeddability/live metadata when needed
5. persist the YouTube video ID; construct embed URLs at render time

Avoid expensive global search for routine ingest.

If an API key is temporarily unavailable, a narrow channel-specific public feed may be used as a temporary discovery path, but the persistent contract should remain the same and should be migrated to the official Data API when credentials are available.

---

# 7. Player behavior

Use a lightweight poster-first player:

- render title/thumbnail/source first
- load the YouTube iframe only after user click where practical
- no autoplay
- lazy load
- responsive 16:9 container
- captions remain available through YouTube
- preserve YouTube branding/controls according to platform rules
- prefer privacy-enhanced embed domain where compatible
- if the video becomes unavailable or non-embeddable, remove the player gracefully and keep the metadata/source link where appropriate

Do not create a fake custom player over downloaded YouTube media.

---

# 8. Video product surfaces

## Homepage — `Fight Week Video`

Show 1 prominent current-event video plus 2–4 secondary items when relevant.

Priority:

1. Embedded / Countdown
2. official event preview
3. press conference / media day
4. weigh-in / faceoff
5. recent fighter interview

Hide the whole module when there is no relevant official content.

## Event page — `Watch Fight Week`

Create a chronological official-video rail:

- announcement / preview
- Countdown
- Embedded episodes
- press conference
- weigh-in
- faceoff
- post-fight

This should make the event page increasingly valuable as fight night approaches.

## Fighter page — `Latest Video`

Show the newest high-confidence official video linked to the fighter, with `All videos` expansion if enough content exists.

## Matchup page

Prefer videos involving one or both fighters or the current event. A video should support the matchup analysis rather than displace Fight DNA.

## Articles

Allow related official video to appear after the Bettor's Edge / opening analysis where editorially relevant.

The main PropBetEdge newsroom already uses this pattern; UFC should use the same philosophy with MMA-specific content.

## Newsroom

Add a `Video` filter / visual video cards only if the volume supports it.

---

# 9. API

Expose video through the same canonical UFC API.

Suggested additive routes:

```text
GET /v1/ufc/videos?limit=20&type=&fighter_id=&event_id=
GET /v1/ufc/fighters/{id}/videos
GET /v1/ufc/events/{id}/videos
GET /v1/ufc/bouts/{id}/videos
```

And optionally:

```text
GET /v1/ufc/events/{id}?include=media,videos
GET /v1/ufc/fighters/{id}?include=media,videos,dna
```

API output should include provider/source and embeddability rather than pretending PBE owns the media.

---

# 10. Video + Fight State Ledger

Video events can enrich the fight-week timeline without becoming unverified facts.

For example:

```text
T-72h: UFC Embedded episode published
T-24h: official press conference video published
WEIGH-IN: official weigh-in stream/video published
POST: official post-fight interview published
```

These are media events. Do not infer injuries, weight-cut condition or tactical claims from thumbnails/titles alone.

If transcript analysis is added later, claims extracted from a transcript must retain video ID, timestamp and confidence/source attribution.

---

# 11. Future transcript intelligence

A later high-value layer can index official-video transcripts/captions when the source/API terms and rights permit the intended use.

Potential uses:

- searchable fighter quotes
- camp-change references
- injury statements directly attributed to the speaker
- strategy comments
- weight-cut comments
- timestamped citations in newsroom research

Do not train or publish derived claims from unavailable/private transcripts. Never strip attribution.

---

# 12. Acceptance gates

Before merging the media/video work:

### Photos

- event-by-event image coverage report
- next-card prioritized
- no wrong-fighter identity matches
- all stored images have explicit allowable rights
- 1440 + 390 UI QA
- image error fallback works
- attribution visible where required

### Video

- allowlisted source channels only for automatic publish
- video IDs deduped
- fighter/event mappings confidence-gated
- embeddability handled
- no autoplay
- iframe lazy/poster-first behavior tested
- unavailable video fails gracefully
- homepage/event/fighter/article modules tested at desktop/mobile
- API tests + live smoke
- no downloaded/rehosted YouTube video

## Product bar

The visual goal is simple: when a user opens an upcoming UFC event they should see the actual fighters, feel the arena/cage atmosphere, be able to watch the official fight-week media, read bettor-grade analysis, and inspect Fight DNA in the same product.

Photos make the product human. Video makes it alive. Fight DNA makes it proprietary.
