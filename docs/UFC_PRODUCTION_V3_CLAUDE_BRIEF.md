# UFC Production V3 — Claude Code Execution Brief

Branch: `ufc-production-v3`
Base: `542e20645d4b17320648710bb139353366804769`
Production app: `https://ufc.propbetedge.ai`
Production API: `https://ufc-api.propbetedge.ai`

## Mission

PropBetEdge UFC is now a real product. Treat it like one.

The current site has the right information architecture and much stronger typography than the old build, but visually it still reads as premium data on a mostly black canvas. The next pass must add the environmental depth, media, identity and sports-product energy already proven on `nfl.propbetedge.ai`, while preserving the working UFC data product.

At the same time, continue the UFC API. The web app currently still uses server-side Supabase readers for bulk image, article, rankings-snapshot and round-stat use cases that API v1 does not fully expose. The long-term contract is that the web product should be able to operate as a first-party client of the public/internal UFC API instead of reaching around it.

Work in two parallel tracks:

1. **UI / brand / media production pass**
2. **API parity / data contract expansion**

Do not trade one track for the other.

---

# TRACK A — UI / BRAND / MEDIA

## A0. Non-negotiable constraints

- Do **not** restart the site design.
- Do **not** flatten or replace the current information architecture.
- Preserve the existing homepage sections, event pages, fighter pages, fight pages, rankings, newsroom, SEO/schema, footer network and Pro surfaces unless a specific change below improves them.
- Preserve factual/no-fabrication rules. Missing fighter media must stay a deliberate branded fallback.
- Never invent fighter photos, rankings, odds, results, injuries, quotes or editorial facts.
- Do not hotlink random copyrighted UFC/Zuffa promotional photography.
- The cage/background asset must be original, owned, or permissively licensed. It must contain **no UFC, Zuffa, TKO, ESPN or sportsbook marks** unless explicit rights exist.
- The product may call itself PropBetEdge UFC, but the background visual should be a generic professional **octagonal MMA cage**, not official UFC trade dress.
- Preview first. Do not merge to main until desktop/mobile screenshots, build, API smoke and public-route QA are green.

## A1. Use the NFL product as the atmospheric reference

Reference repository: `LHBUSA/nfl-propbetedge-new`.
Reference file: `nfl-brand-media-v1.css`.

The useful NFL pattern is not the football-specific art. It is the **viewport-locked atmospheric image system**:

- `body::before` fixed to viewport
- low-opacity photographic sports environment
- `background-size: cover`
- separate `body::after` gradient atmosphere layer
- transparent app surfaces over it
- dark translucent/glass panels
- no `background-attachment: fixed` mobile repaint problem

Bring that system to UFC with an octagonal MMA cage image.

### Required cage asset

Add durable local media, preferably:

- `web/public/media/ufc-cage-bg-1600.webp`
- optionally a smaller mobile derivative such as `ufc-cage-bg-960.webp`

The frame should feel like a premium arena/cage environment: cage fence visible, arena lights or rim lighting, dark neutral palette, enough negative space that the interface remains legible.

Do not make the photo itself gold. Let PropBetEdge gold remain the accent color.

### Required global treatment

Implement the cage image as a global background atmosphere, not as a hero-only banner.

Suggested behavior:

- desktop opacity roughly `.14`–`.22` depending on contrast
- `filter` may use slight grayscale / brightness / saturation tuning
- add dark ink overlay and subtle PBE gold/crimson radial lighting in `body::after`
- main app areas remain transparent or semi-transparent so the cage breathes through
- header becomes a premium blurred dark rail
- sections/cards use translucent ink surfaces with subtle borders and shadows
- cage must not reduce text contrast
- on small screens keep the fixed pseudo-element approach used by NFL to avoid scroll-jitter
- respect `prefers-reduced-motion`; there should be no required animated cage effect

Primary file: `web/app/globals.css`.

## A2. Canonical PropBetEdge branding

The NFL product uses the canonical PropBetEdge assets:

- `https://propbetedge.ai/logo/pbe-full-400.png`
- `https://propbetedge.ai/logo/pbe-full-600.png`
- `https://propbetedge.ai/logo/pbe-mark-80.png`
- `https://propbetedge.ai/logo/pbe-mark-160.png`
- `https://propbetedge.ai/logo/pbe-mark-240.png`

UFC currently also has its own excellent cage/bolt mark in `web/components/Brand.tsx`. Keep that as the UFC-specific sub-brand mark/fallback, but visually unify the product with the canonical PBE network.

### Header

Upgrade `web/components/Shell.tsx` / `web/components/Brand.tsx` so the desktop header clearly reads as a PropBetEdge network product:

- canonical PropBetEdge full logo or visually identical canonical wordmark
- UFC product tag beside it
- existing octagon/bolt mark may remain as the UFC-specific icon
- same visual quality and proportions as NFL
- keep the fight-week ticker and Go Pro CTA

Do not create a fake UFC shield/logo. Do not imitate the UFC official brand mark.

### Footer / network

Make the footer feel like the same sports network as NFL:

- canonical PBE logo
- `THE PROPBETEDGE SPORTS NETWORK`
- MLB / NFL / UFC sibling navigation
- `From raw signal to decision infrastructure.`
- maintain current independence/disclaimer language and portrait licensing disclosure

## A3. Homepage: bring the current composition to life

The screenshot composition is fundamentally good. Keep it.

Current strengths to preserve:

- left editorial hero
- right next-card poster
- hard data counts
- card immediately below hero
- strong Playfair/mono/UI type roles
- dark/gold hierarchy

Improve rather than replace.

### Hero

- cage environment visible behind the hero
- subtle arena light/fence depth, never busy
- add canonical PBE network identity to the hero without crowding it
- current headline direction (`Every card. Every fighter. Every round.`) is strong
- the right-side next-card stage should feel like a broadcast fight poster rather than a flat bordered box
- use real licensed fighter portraits when available
- where portraits are unavailable, use the current premium initials/PBE fallback; never fake a face
- add subtle light edge/rim effects to distinguish fighter sides
- preserve factual record, event, venue and days-out data

### Fight card / matchup rows

- raise visual hierarchy with portrait chips or fighter identity blocks when media exists
- make weight class / rounds / title state easy to scan
- use PBE gold primarily as line/accent, not giant filled surfaces
- maintain mobile readability and no clipping

### Fighter archive / champions / rankings

- licensed portrait cards should feel like actual athlete cards
- ranked/champion state should be visually obvious but not imply unsupported facts
- use current verified rankings snapshot only
- add division labels and ranking position as data, not decoration

### Newsroom

Use article/fighter/event media where rights and data allow:

- hero story treatment
- article cards with image when `hero_image_ref` / resolved media exists
- compact source/credit where appropriate
- keep the data-grounded newsroom positioning

## A4. Fighter pages

The current fighter dossier structure is good. Push it to premium sports-profile quality:

- large portrait stage
- cage/arena atmosphere behind profile hero
- clear name / nickname / record / physicals / stance / current ranking if verified
- fight history remains highly legible
- surface career UFC Stats metrics where available: SLpM, Str Acc, SApM, Str Def, TD Avg, TD Acc, TD Def, Sub Avg
- highlight next fight when scheduled
- show portrait author/license/source exactly where media is displayed
- preserve Person JSON-LD and image metadata

Do not overstate `fight_history_count` or current rank when source coverage is partial.

## A5. Event and fight pages

Event pages should look like fight-night control surfaces:

- event hero with venue/date/card status
- main event stage visually dominant
- main card/prelims clearly segmented
- actual fighter portraits where available
- branded PBE fallbacks otherwise
- title bouts visually distinct but restrained
- results state visually different from scheduled state
- round stats remain readable and factual

Fight pages should be the deepest A-vs-B experience:

- two-sided portrait hero
- record, age, height, reach, stance, weight class
- result if completed
- round-by-round stats if present
- no invented win probability until a real model output exists
- Pro lock state remains truthful

## A6. Images and licensing

Existing `ufc_images` is a real licensed media library. Continue expanding it.

Media rules:

- allowed licenses only
- preserve `author`, `license`, `source_url`, `r2_key`
- use durable first-party image URLs once R2 public delivery is configured
- Wikimedia redirect may remain as a temporary fallback, but the target architecture is first-party durable delivery
- never show an uncredited Creative Commons image on a detail page
- never use random Google image results or UFC promotional hotlinks

## A7. SEO / metadata / favicon / schema

Do not regress the current work.

Verify and improve where useful:

- favicon / apple icon / manifest
- homepage OG image
- fighter OG images with portrait when available
- event OG images
- fight OG images
- NewsArticle OG images
- canonical URLs
- Organization / NewsMediaOrganization / WebSite / SportsEvent / Person / NewsArticle / ItemList / BreadcrumbList as applicable
- sitemap coverage
- RSS
- robots

Brand metadata must continue to identify PropBetEdge / PropTechUSA.ai and the UFC product accurately without claiming affiliation.

## A8. Visual QA gates

Use the existing QA tooling (`scripts/qa/shot.mjs` where appropriate) and test at minimum:

- 1440×900 desktop homepage
- 390×844 mobile homepage
- fighter page with portrait
- fighter page without portrait
- event page
- fight page
- rankings page
- news index/article
- Pro page

Acceptance:

- no horizontal clipping
- no unreadable cage background on mobile
- no transparent text over busy image regions
- no broken portrait URLs
- no layout shift caused by missing aspect ratio
- no oversized image downloads when a smaller derivative is sufficient
- Lighthouse/performance should not materially regress because of the cage layer

---

# TRACK B — API PARITY / DATA CONTRACT

Current worker: `workers/ufc-api/src/index.js`.
Current API is real and live, but it does not yet expose all contracts consumed by the rebuilt web app.

Goal: progressively make the web app a first-party client of `ufc-api.propbetedge.ai` again without weakening the current user experience.

## B1. Fix durable fighter image delivery first

Current behavior:

- `fighterDetail()` attaches `images`
- event-card bouts attach fighter images
- `/v1/ufc/fighters` list does **not** attach images
- `image_url` only resolves when `UFC_IMAGE_BASE_URL` is configured

Implement:

1. Configure/verify a durable public media origin for UFC image objects.
2. Set `UFC_IMAGE_BASE_URL` in the Worker environment.
3. Return first-party `image_url` wherever `r2_key` exists.
4. Extend fighter-list responses with a compact media contract. Prefer an additive field such as `primary_image` or `images` without breaking current consumers.
5. Keep author/license/source metadata available.
6. Add tests and live smoke for one fighter with media and one without media.

Do not make the list endpoint explode in payload size. A compact `primary_image` object is preferable for archive grids; full media arrays can remain on detail.

## B2. Implement verified rankings API

Current `/v1/ufc/rankings` returns 501 even though the new web product has a verified rankings snapshot pipeline.

Implement the API against the actual verified rankings store produced by `scripts/rankings` / migration state.

Requirements:

- no synthetic ranks
- include source and captured/published timestamp
- division label
- champion when verified
- ranked fighters with position and fighter identity
- stable ordering
- null/unavailable if source snapshot is absent
- API tests and production smoke

Update OpenAPI/docs.

## B3. Article/news media parity

Current article list includes `hero_image_ref` / `hero_credit` but consumers should not have to reverse-engineer media references.

Add a resolved media shape where possible:

- `hero_image_url`
- `hero_credit`
- source/reference metadata

Do not fabricate a hero image when no approved media exists.

## B4. Composite page contracts to remove web-side Supabase fan-out

Do not blindly replace working web readers with N API calls per page.

Design compact composite contracts for the high-value page shapes the web needs. Choose clean additive routes or expansion flags.

Targets:

### Fighter page
Need one efficient contract capable of returning:

- fighter detail
- primary/full media
- verified ranking state
- next scheduled bout
- fight history
- career stats / round-stat summary

Possible pattern:

`GET /v1/ufc/fighters/{id}?include=media,ranking,next,history,stats`

or a dedicated profile route. Pick one consistent API design and document it.

### Event page
Need an efficient contract capable of returning:

- event
- card/bouts
- fighter compact identities + media
- results
- optional round stats for completed bouts

Possible pattern:

`GET /v1/ufc/events/{id}/card?include=media,results,stats`

Avoid making the default response unnecessarily huge.

## B5. Round stats parity

The API already has fighter and bout stats routes. Verify they expose everything the web currently reads directly.

If the web still needs unsupported bulk shapes, add them in a way that prevents N+1 requests.

Preserve source provenance and null semantics.

## B6. Search and counts

Keep `/search` and `/counts` aligned with the product as coverage expands.

Search should eventually surface:

- fighters
- events
- articles

Do not return unsupported ranking or model claims.

## B7. OpenAPI, tests, live smoke

Every additive API contract must update:

- OpenAPI specification
- `docs/ufc_api_v1.md`
- Worker unit tests
- `smoke_live.mjs` where production-safe

Production promotion gate:

- tests green
- `wrangler` check/dry validation green
- live current endpoints unchanged unless deliberately additive
- new endpoints/fields proven on real production rows

---

# TRACK C — INGEST / CONTENT CONTINUES

Do not pause the existing pipelines while UI/API work happens.

Existing streams include:

- ESPN schedule/bout/result/fighter refresh through `ufc-stats-ingest`
- UFC Stats historical enrichment/backfill
- newsroom source ingest / article writer
- rankings snapshot ingest
- licensed fighter image ingest

Keep those jobs operational and improve failure visibility where necessary.

Priorities:

1. keep current/upcoming cards fresh
2. keep completed results/result_source correct
3. continue historical UFC Stats coverage
4. expand fighter portrait coverage under the license allowlist
5. keep rankings/news snapshots fresh
6. persist failures; never silently mark incomplete work complete

---

# BUILD / RELEASE RULES

Work only on `ufc-production-v3` until acceptance.

Before PR:

1. `web` production build passes.
2. UFC API unit/check suite passes.
3. Existing production API smoke passes.
4. New API tests pass.
5. Desktop/mobile visual screenshots captured.
6. Public routes manually inspected through preview.
7. Cage asset licensing/source documented in repo.
8. No secrets committed.
9. No direct production DB writes except through already-approved ingest/deploy workflow.
10. No production merge without a final summarized acceptance report.

The acceptance report must state exactly:

- files changed
- visual surfaces changed
- cage asset source/license
- image delivery architecture
- API endpoints/fields added
- tests executed
- preview URL
- known gaps still remaining

## Product bar

This should no longer feel like a side project or a styled database.

It should feel like a coherent PropBetEdge sports product that belongs beside NFL and MLB: cinematic enough to feel alive, restrained enough to feel credible, and backed by a real API/data system that can become a standalone commercial UFC intelligence product.
