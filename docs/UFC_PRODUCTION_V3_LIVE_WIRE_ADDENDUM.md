# UFC Production V3 — Live Wire / Headline Ticker Addendum

This addendum is mandatory alongside `docs/UFC_PRODUCTION_V3_CLAUDE_BRIEF.md`.

## Product intent

PropBetEdge UFC should feel alive even when the user is not on the News page. Add a persistent, premium scrolling UFC headline/wire rail across the product, driven by real newsroom data and linked into the site.

This is not a decorative marquee and must never be populated with hardcoded or fabricated breaking-news copy.

## 1. Global live UFC wire

Add a compact ticker directly beneath the main header/sports shell on every primary route:

- `/`
- `/events` and event detail
- `/fighters` and fighter detail
- `/fights/*`
- `/rankings`
- `/news` and article detail
- `/pro`

The rail should visually belong to the same PropBetEdge sports network as NFL while remaining MMA-specific.

Suggested structure:

- left fixed badge: `UFC LIVE WIRE` or `LATEST`
- optional fresh/live dot only when freshness criteria are actually met
- horizontally moving sequence of 8–20 current items
- title + compact source/time treatment
- separators that feel like a broadcast/news desk rail
- right-side `Newsroom →` affordance

Do not make the motion distracting. The rail is supporting chrome, not the hero.

## 2. Data contract — API first

The source-of-truth table is `ufc_news_items`; it already carries title, published timestamp, summary, taxonomy, fighter IDs, event ID, bout ID, URL and source relationship.

Expose an additive API route for the raw attributed wire rather than making the browser reach Supabase directly:

`GET /v1/ufc/wire?limit=20`

Suggested response item:

```json
{
  "id": "uuid",
  "title": "...",
  "published_at": "ISO-8601",
  "summary": "...",
  "taxonomy": "...",
  "source": { "name": "...", "url": "..." },
  "source_url": "...",
  "fighter_ids": [],
  "event_id": null,
  "bout_id": null,
  "internal_url": "/news/... or /events/... or /fighters/... or null"
}
```

Rules:

- preserve source attribution
- no fabricated summary/title
- dedupe by existing news fingerprint/url behavior
- newest first
- include an API-level `generated_at` / freshness timestamp in meta
- use a short CDN cache (15–30 seconds is appropriate)
- update OpenAPI, docs, unit tests and live smoke

If a PropBetEdge article exists for the same story, prefer its internal article URL. If not, map to an internal event/fighter/bout page when confidently linked. Otherwise link the headline to the attributed external source and provide a separate `Newsroom` route affordance.

## 3. Near-real-time behavior

The ticker should update without a full page refresh.

Client behavior:

- initial server-rendered items so the rail is useful before hydration
- client refresh every 30–60 seconds
- pause/reduce polling while the document is hidden
- preserve current items if one refresh fails; do not blank the rail
- no visible layout jump when items refresh
- respect `prefers-reduced-motion`
- keyboard/focus users must be able to navigate links without chasing moving text
- pausing on hover/focus is preferred

Do not call the content `LIVE` if the latest item is outside the defined freshness window. In stale/no-data state use `LATEST UFC` or `NEWS WIRE` instead.

## 4. Upstream freshness must match the promise

The current GitHub newsroom workflow comment describes fight-week ingest every 30 minutes, but the actual scheduled news job is currently the two-hour baseline (`17 */2 * * *`). Fix this mismatch.

Target freshness contract:

- fight week: ingest/check sources at least every 30 minutes
- normal/off week: no worse than every 2 hours
- UI/API rail refresh: every 30–60 seconds against the current stored wire

Implement the cadence cleanly. Prefer a schedule + script gate that prevents unnecessary expensive article-writing work when there is nothing new. News ingest can run more frequently than full article generation if that keeps the wire fresher and cheaper.

A truly instantaneous feed cannot be promised from RSS/source polling, so product language should say `LIVE WIRE` only when the stored feed is within the freshness threshold, not imply sub-second provider connectivity.

## 5. World-class visual treatment

This rail should materially contribute to the premium feel:

- dark translucent ink surface over the new cage atmosphere
- 1px PBE line/border treatment
- restrained gold accent for the label and separators
- optional crimson for genuinely fresh breaking/card-change states
- mono font for timestamp/source metadata
- UI font for headline
- no giant ticker text
- no cheap CSS marquee look
- subtle masked fade at left/right edges
- smooth transform-based animation rather than repeatedly mutating layout
- no horizontal page overflow on mobile

Desktop should resemble a premium sports broadcast/data terminal. Mobile should become a compact single-line rail beneath the header, preserving tap targets and readability.

## 6. Newsroom integration

The ticker and `/news` must feel like one system:

- `Newsroom →` always routes to `/news`
- headline clicks route internally when an internal canonical destination exists
- wire source attribution remains visible in newsroom detail/list context
- article cards may surface `From the live wire` / related-wire context when supported by real links
- do not duplicate the same headline five times because multiple feeds picked it up

## 7. Fight-night mode

When an event is live or within the existing fight-night window, the global rail may prioritize:

1. official/card status changes from our database
2. newly published related headlines
3. completed bout/result facts once ingested and verified
4. relevant newsroom stories

Do not turn this into play-by-play unless the data source actually supports reliable live bout state. Never infer a result from social/news text when structured result data is unavailable.

## 8. Acceptance gates

Before merge, prove:

- ticker visible on homepage, event, fighter, rankings, news and Pro pages
- 1440px and 390px screenshots
- no horizontal overflow
- motion pauses or is disabled under `prefers-reduced-motion`
- keyboard-focus behavior works
- API `/v1/ufc/wire` returns real attributed rows
- refresh does not blank on transient API failure
- stale feed does not present itself as live
- upstream newsroom cadence is verified against the intended fight-week/off-week contract
- existing API smoke stays green
- no production Supabase credentials enter browser code

## Product bar

The finished shell should communicate that something is happening in the UFC world at all times: cage atmosphere behind the application, real athletes and event imagery in the content, the next fight visibly approaching, and a living UFC wire moving through the chrome.

The experience should feel like a premium sports intelligence desk, not a dark-themed database and not a generic sports-news template.
