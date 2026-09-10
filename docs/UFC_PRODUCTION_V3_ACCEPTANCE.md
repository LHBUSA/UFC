# UFC Production V3 — Acceptance Report

Branch `ufc-production-v3` (not merged). Preview: see "Preview" below.
Covers `docs/UFC_PRODUCTION_V3_CLAUDE_BRIEF.md`, the live-wire addendum and
the editorial addendum. Date: 2026-09-06.

## Files changed (by commit on the branch)

| Commit | Scope |
|---|---|
| `UFC V3 Track A: cage atmosphere, canonical PBE branding, fight-stage media` | `web/app/globals.css`, `web/components/{Brand,Shell,ui}.tsx`, `web/app/page.tsx`, `web/app/fighters/[slug]/page.tsx`, `web/lib/site.ts`, `web/public/media/{ufc-cage-bg-1600.webp,ufc-cage-bg-960.webp,ufc-fence-1400.webp,README.md}` |
| `UFC API v1 parity: durable media, verified rankings, article media, composites` | `workers/ufc-api/{src/index.js,src/index.test.mjs,smoke_live.mjs,wrangler.toml}`, `docs/openapi.ufc-v1.yaml`, `docs/ufc_api_v1.md`, `.github/workflows/ufc-api-live-smoke.yml`, `docs/frontend.md` |
| `Global UFC live wire rail (API-first) + 30-minute newsroom cadence` | `web/lib/wire.ts`, `web/components/{LiveWire,LiveWireClient}.tsx`, `web/app/layout.tsx`, `web/app/news/[slug]/page.tsx`, `web/lib/db.ts`, `.github/workflows/newsroom.yml`, `docs/editorial_contract.md` |
| `API: GET /v1/ufc/wire; article-page editorial modules; wire acceptance checks` | `workers/ufc-api/**`, `web/components/editorial.tsx`, `web/app/news/[slug]/page.tsx`, `web/components/ui.tsx`, `scripts/qa/wire-check.mjs` |
| `API: editorial analysis contract on article routes` | `workers/ufc-api/**`, OpenAPI + docs |
| `Newsroom: bettor-angle article writer (fact block v2, editorial gates)` | `scripts/news/write_articles.mjs`, `scripts/news/lib.mjs`, `docs/news_pipeline.md` |
| `Editorial modules: fix class collision with tape rows; mobile brand row` | `web/components/editorial.tsx`, `web/app/globals.css` |

## Visual surfaces changed

- **Global atmosphere**: viewport-locked octagonal MMA cage behind every
  route (`body::before` image at .19 desktop / .15 mobile, `body::after` ink
  gradient + gold/crimson radial light), glass header rail, translucent ink
  surfaces. Fixed pseudo-elements, no `background-attachment: fixed`.
- **Branding**: canonical PBE chrome mark + wordmark + UFC tag + octagon icon
  in the header; PBE full logo, "The PropBetEdge Sports Network" kicker and
  MLB / NFL / UFC siblings in the footer; PBE mark beside the hero eyebrow.
- **Global live wire** beneath the header on every route: badge (truthful
  "UFC Live Wire" / "Latest UFC"), moving belt of 20 attributed items with
  source + age, internal links where mapped, `Newsroom →`. Client polls the
  API every 45 s (hidden-tab aware, keeps items on failure), pauses on
  hover/focus, static + scrollable under reduced motion.
- **Home**: next-card poster with fence texture and per-side rim light;
  "Coming up" limited to UFC cards.
- **Fighter pages**: fence-textured hero stage, portrait glow, UFC Stats
  career tiles (SLpM, Str Acc, SApM, Str Def, TD Avg, TD Acc, TD Def, Sub Avg).
- **Event / fight pages**: title bouts and completed bouts marked in rows;
  face-off portraits with gold/crimson rim light.
- **Articles**: Bettor's Edge callout (impact 1–5, markets, why / risk /
  watch, odds + model availability), inline matchup module with recent-form
  strips, market-watch box, source & methodology panel, "From the live wire"
  context; story cards show "Edge n/5".

## Cage asset source / licence

| File | Source | Author | Licence |
|---|---|---|---|
| `web/public/media/ufc-cage-bg-1600.webp` (124 KB), `-960.webp` (55 KB) | https://commons.wikimedia.org/wiki/File:BRAVE_Darius-7.jpg | Haribhagirath | CC0 1.0 |
| `web/public/media/ufc-fence-1400.webp` (55 KB) | https://commons.wikimedia.org/wiki/File:Mixed-martial_arts_fights_heat_up_Combat_Center_140620-M-ZM882-066.jpg | Lance Cpl. Paul S. Martinez, USMC | Public domain (US government work) |

Re-encoded with sharp (saturation reduced so gold stays the accent); no UFC,
Zuffa, TKO, ESPN or sportsbook marks are legible at the opacities used.

## Image delivery architecture

- Licensed Wikimedia portraits are stored first-party in the public Supabase
  Storage bucket `ufc-media` (`fighters/<fighter_id>/{portrait,card,thumb}.jpg`)
  and registered in `ufc_images` with author, licence, source URL.
- API: `UFC_IMAGE_BASE_URL` is set in the Worker; every `r2_key` resolves to
  `image_url` / `card_url` / `thumb_url`; compact `primary_image` on lists,
  full `images[]` on detail; bulk `/v1/ufc/fighters/media?ids=`.
- Web renders branded octagon/initials fallbacks where no licensed image
  exists and prints the credit line wherever a portrait appears. Coverage:
  156 of 867 fighters with media.

## API endpoints / fields added (all additive, deployed to ufc-api.propbetedge.ai)

- Media: `primary_image`, `card_url`, `thumb_url`, `slug_id`; `/v1/ufc/fighters/media?ids=`.
- `/v1/ufc/rankings` (verified store: `ufc_rankings` table when applied, else the dated Storage snapshot; `?division=`, `?womens=`; explicit `rankings_not_available`).
- `hero_image_url` / `hero_image` on news, article, search; `/v1/ufc/events/{id}/articles`, `/v1/ufc/fighters/{id}/articles`; `offset` on lists.
- Composites: `/v1/ufc/fighters/{id}?include=media,ranking,next,history,stats`, `/v1/ufc/events/{id}/card?include=media,results,stats`.
- Stats parity on `/bouts/{id}/stats`, `/fighters/{id}/stats`; `/search` covers fighters, events, articles; `/counts` adds images.
- `GET /v1/ufc/wire?limit=` (attributed, deduped, `internal_url` mapping, `meta.generated_at / freshness_minutes / live / fight_week`, 15/30 s cache, CORS *).
- Article analysis contract: `analysis` (bettor_angle, market_watch, matchup, story_class, sources), `analysis_summary`, `word_count`, `reading_minutes`, `?story_class=`.

## Tests executed

| Check | Result |
|---|---|
| `web` `tsc --noEmit` + `next build` | pass |
| `workers/ufc-api` `npm run check` + `npm test` | 40/40 pass |
| `workers/ufc-api/smoke_live.mjs` vs production | PASS, 1198 checks (v2 analysis branch exercised) |
| `scripts/qa/shot.mjs` local, 13 routes × 1440/390 | 26 captures, scrollWidth == innerWidth on every one |
| `scripts/qa/wire-check.mjs` (/ and /rankings) | 11/11 each: items, links, transform motion, hover/focus pause, reduced-motion static, mobile |
| Writer gates (negative tests) | short body, `-150`, "favourite", "% chance", "injured", unresolvable link, duplicate headline all rejected |
| Preview routes (share cookie) | 20 routes 200, 404 page 404, OG images 200 |

## Freshness proof (live wire)

- Ingest run at 15:04Z inserted 1 new item; newest item age **5 min** at that moment.
- `GET /v1/ufc/wire` at 15:46Z: `newest_published_at 15:00Z`, `freshness_minutes 46`, `live true`, `fight_week true` (Noche UFC Sept 12), `linked 10/20`, cache `max-age=15, s-maxage=30`.
- Cadence: SUPERSEDED 2026-09-10. GitHub schedules nothing; `newsroom.yml` is
  disabled_manually. Detection runs on Cloudflare every 2 minutes
  (`ufc-news-ingest`), the article factory every 5 (`ufc-news-enrich`), and
  event-level articles on `ufc-event-editorial`. The note below is kept as the
  record of why the GitHub cadence was never trustworthy: the workflow failed to
  parse for a period, and even once valid its scheduled runs were dropped by hours.

## Preview

CLI preview of commit `fc1c67e` (database env injected at deploy):
https://ufc-propbetedge-45k28cvvi-justins-projects-ad4f4bb7.vercel.app
(protected by Vercel SSO; a 23-hour share link is in the report message).
Verified through the share cookie: 19 routes 200 including RSS, sitemap,
robots, OG images and the cage asset; the 404 page returns 404; the home
page carries the live wire rail (`wire-rail live`) and the article page the
Bettor's Edge, matchup, market-watch and methodology modules; 18 device
captures (1440 / 390) with scrollWidth equal to innerWidth.

The git-integrated preview (`ufc-propbetedge-git-ufc-production-v3-…vercel.app`)
renders empty states because the Vercel Preview environment has no
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; the CLI refuses to add
Preview-wide variables non-interactively, so add them in the Vercel
dashboard (Settings → Environment Variables → Preview) once.

## Known gaps

- `migrations/003_ufc_rankings.sql` still unapplied (no DB password on this machine); rankings serve from the verified Storage snapshot, API and web switch to the table automatically.
- Career UFC Stats coverage is 53 of 867 fighters and round stats cover 24 bouts, so previews mostly run in the concise class with impact capped at 3; depth rises automatically as coverage lands.
- No odds or model tables exist: `odds_status` / `model_status` are `unavailable` everywhere by construction.
- No `ANTHROPIC_API_KEY` locally; the Claude rewrite path is code-complete and validator-tested but only runs in CI when the secret is present.
- The web still reads Supabase server-side for bulk page shapes (fail-empty readers); the API now exposes composite contracts to migrate those readers incrementally. The wire rail is already API-first.
- Contender Series placeholder competitions are skipped by the ingest with a logged note rather than aborting the run.
