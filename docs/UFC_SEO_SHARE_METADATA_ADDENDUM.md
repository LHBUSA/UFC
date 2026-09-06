# PropBetEdge UFC — SEO / Metadata / Schema / Favicon / Share Card Addendum

This addendum is mandatory for `ufc-fight-dna-v1` before production merge.

## Current baseline

The site already has a strong technical foundation:

- Next.js Metadata API in `web/app/layout.tsx`
- canonical URLs
- robots directives
- sitemap
- RSS alternate
- SVG favicon in `web/app/icon.svg`
- generated Apple icon
- `site.webmanifest`
- Organization / NewsMediaOrganization / WebSite JSON-LD
- page-level SportsEvent, Person, NewsArticle, ItemList, Product and AboutPage JSON-LD
- generated 1200x630 OpenGraph images for the root, events, fighters, fights and articles

Do not remove or regress any of this. The task is to take it from technically correct to premium / world-class.

---

# 1. Metadata quality

Audit every primary indexable route:

- `/`
- `/events`
- `/events/[slug]`
- `/fighters`
- `/fighters/[slug]`
- `/fights/[slug]`
- `/rankings`
- `/news`
- `/news/[slug]`
- `/pro`
- `/about`

Each must have:

- unique title
- unique useful meta description
- canonical URL
- OpenGraph title / description / URL / type
- Twitter/X large image card where appropriate
- route-specific OG image
- no accidental homepage canonical inheritance
- sensible robots state
- images with correct absolute URLs and dimensions where metadata supports it

Titles should lead with the thing the user searched for, not boilerplate.

Examples:

`Jean Silva UFC Record, Fight DNA, Stats & Next Fight | PropBetEdge`

`Noche UFC: Silva vs. Delgado — Full Card, Fight DNA & Matchups | PropBetEdge`

`Jean Silva vs. Jose Miguel Delgado — Tale of the Tape & Fight DNA | PropBetEdge`

Article titles should preserve the editorial headline.

Do not keyword-stuff.

---

# 2. Dynamic social share cards

The existing `opengraph-image.tsx` routes are an excellent base. Upgrade them so a shared URL looks like a premium sports network asset.

## Global / homepage

- canonical PropBetEdge logo / UFC sub-brand
- cage / arena atmosphere consistent with the product UI
- clear `FIGHT INTELLIGENCE` positioning
- readable at feed-thumbnail size
- no excessive small text

## Fighter

Use when rights-safe portrait exists:

- fighter portrait
- name / nickname
- record
- current ranking / champion state when available
- 1–3 high-value Fight DNA signals once the DNA API is available
- `PBE FIGHT DNA` label when using derived metrics

Fallback must remain branded and intentional when no photo exists.

Do not crop into foreheads. Reuse focal-aware image handling from the editorial-image fix.

## Matchup

- both fighter portraits where available
- A VS B
- event / date / weight class
- records
- optionally one concise matchup-DNA signal only when sample/coverage is sufficient

Never put fake odds, model probabilities or an unsupported edge on an OG card.

## Event

- main event faceoff
- event name / date / venue or city
- bout count
- `FULL CARD · FIGHT DNA · NEWS` style supporting line
- final/result treatment after completion

## Article

- editorial headline
- correct hero / matchup media with safe crop
- story type
- date
- `BETTOR'S EDGE` badge only if the stored article fact block actually has a bettor angle
- do not let long headline text obscure the image

All OG images should remain 1200×630, return HTTP 200, carry a correct content type and have meaningful `alt` exports.

---

# 3. Share controls

Add a restrained reusable share action to the high-value detail surfaces:

- fighter
- fight / matchup
- event
- article

Preferred behavior:

1. native Web Share API when available
2. copy canonical link fallback
3. optional direct X / LinkedIn links in a small menu if visually clean

Do not add huge rows of social icons.

The copied/shared URL must always be the canonical production URL, never a Vercel preview URL or query-string state.

Accessible requirements:

- button has clear label
- keyboard reachable
- copy success is announced / visible
- no dependency on hover

---

# 4. Favicon / app-icon completeness

The UFC octagon + PBE bolt mark is the correct identity and should remain the icon.

Audit appearance at:

- 16×16 browser tab
- 32×32 browser tab/bookmark
- 180×180 Apple touch
- 192×192 PWA
- 512×512 PWA
- maskable app icon where practical

Keep:

- dark PBE ink background
- gold octagon / bolt
- enough internal padding that the mark is not clipped by circular/squircle masks

The current SVG icon can remain the scalable browser icon, but generate/serve raster sizes required by the manifest and mobile platforms if missing.

Update `site.webmanifest` to reference proper 192 and 512 assets, including `purpose: "any maskable"` only if the asset is designed with a valid mask-safe zone.

Verify `/favicon.ico` compatibility if needed for older clients/crawlers. Do not add a generic Next.js favicon.

---

# 5. Structured data graph

Treat schema as one connected entity graph rather than disconnected JSON snippets.

Stable IDs:

- `${SITE.parent}/#org` — PropBetEdge organization
- `${SITE.url}/#desk` — UFC newsroom
- `${SITE.url}/#site` — UFC website
- route URL + fragment for event / fighter / fight / article entities

## Organization / NewsMediaOrganization

Audit:

- name
- legal publisher relationship
- logo
- URL
- contact point
- editorial / ethics / corrections policy
- relevant PropBetEdge network identity relationships

Do not misuse `sameAs` for sibling products merely because they share a parent brand. Use `parentOrganization`, `isPartOf`, publisher/brand relationships, or explicit network links appropriately.

## SportsEvent

Event pages should include where supported:

- name
- startDate
- location
- sport
- organizer
- eventStatus
- attendance mode
- image
- URL
- competitor / subEvent fight relationships

Correct eventStatus semantics: completed/cancelled/postponed should not all be emitted as EventScheduled.

## Fight / matchup pages

Represent the bout as a SportsEvent/subEvent where appropriate:

- competitors
- parent event relationship
- date
- sport
- result context only when supported by schema semantics

## Fighter / Person

Use:

- name
- image when licensed media exists
- birthDate if public and stored
- height / weight only where schema representation is valid and useful
- same canonical page URL
- member/affiliation only if factually supported

Fight DNA is derived data; do not force proprietary metrics into unrelated schema properties.

## NewsArticle

Ensure:

- headline
- description
- image
- datePublished
- dateModified
- author
- publisher
- mainEntityOfPage
- articleSection
- wordCount
- about event/fighter entities
- isAccessibleForFree state accurate to actual page access

## BreadcrumbList

Add structured BreadcrumbList to primary detail pages if not already emitted by the shared breadcrumbs component.

## Product / Pro

Do not claim availability or pricing states that are not actually live. If Pro is not purchasable yet, structured data must remain truthful.

---

# 6. Search / crawler infrastructure

Verify:

- `/robots.txt` 200 and references sitemap
- `/sitemap.xml` 200 and contains canonical production URLs only
- `/feed.xml` 200
- no preview/Vercel hostnames in metadata or sitemap
- no login/private pages indexed
- dynamic event/fighter/article/fight URLs included as expected
- stale/cancelled content is not incorrectly removed if it remains useful historical content

Sitemap `lastModified` should use meaningful source/update dates when available rather than blindly assigning the current build time to every historical URL.

---

# 7. Share-card art direction / image safety

The existing shared `OgFace` uses a top-centered crop. That can recreate the same forehead problem seen in article cards.

Fix it.

OG/card image components should accept focal metadata / object position, or use a safe face-aware derivative created by the media pipeline.

A share card with a bad face crop fails acceptance even if technically valid.

Test actual fighter images at 1200×630, including:

- portrait near top of source frame
- full-body source
- two-fighter matchup
- long fighter names
- accented/non-ASCII fighter names
- no-image fallback

---

# 8. Social preview QA

Create an automated/local QA script that requests representative production or preview routes and validates their document metadata plus OG image route.

Minimum representative cases:

- homepage
- one upcoming event
- one completed event
- one fighter with photo
- one fighter without photo
- one upcoming matchup
- one completed matchup
- one fight-preview article
- one results/news article

Check:

- `<title>`
- meta description
- canonical
- `og:title`
- `og:description`
- `og:url`
- `og:image`
- `og:image:width/height` where emitted
- `twitter:card`
- no preview hostname
- OG image returns image/png + 1200×630
- JSON-LD parses as JSON

Save representative OG PNGs as QA artifacts or screenshots for human review.

Where feasible validate JSON-LD against Google's Rich Results / schema expectations manually or with a local structural validator. Do not claim Google eligibility merely because JSON parses.

---

# 9. Acceptance bar

Before merge, show:

- browser-tab favicon screenshot
- iOS/PWA icon source assets and manifest proof
- homepage OG
- fighter OG with real portrait
- fighter OG fallback
- event OG
- matchup OG
- article OG
- at least one LinkedIn/X-style social preview screenshot or equivalent rendered preview
- metadata dump for the representative route matrix
- JSON-LD entity types by route
- robots/sitemap/feed checks
- Next build + type check green
- no metadata regression in mobile UI

## Product standard

A link to `ufc.propbetedge.ai` should look expensive before the user even clicks it.

The browser favicon should be unmistakably PropBetEdge UFC. A fighter link should look like a fighter card. An event link should look like a fight poster. An article link should look like premium sports journalism. Metadata, schema and social previews are part of the product, not SEO cleanup after launch.
