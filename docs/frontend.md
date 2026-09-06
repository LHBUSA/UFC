# ufc.propbetedge.ai — frontend runbook

Next.js 15 (App Router, TypeScript, no Tailwind) in `/web`. Design tokens are
copied verbatim from `nfl-propbetedge-new/PROPBETEDGE_DESIGN_SYSTEM.md`
(warm ink, paper, gold rules, Playfair for brand moments, JetBrains Mono for
data). Gold is a line before it is a surface. The whole stylesheet is
`app/globals.css`; components are `components/ui.tsx` (cards, bouts, tape,
avatars, story cards), `components/Shell.tsx` (header with the live
next-card pill, footer), `components/Brand.tsx` (vector octagon mark + logo)
and `components/og.tsx` (OG card frame).

## Routes

| Route | Source | Empty state |
|---|---|---|
| `/` | next UFC card (Contender Series excluded) + bouts, headline tape, latest stories, schedule, wire, champions, recent results, counts | poster renders; "Next card loading" |
| `/events`, `/events?year=` | `ufc_events` upcoming + per-year archive, main events, bout counts | "No upcoming events loaded" / "No completed events" |
| `/events/[slug]` | event + bouts (main / prelims / early), tale of the tape, related stories, SportsEvent + subEvent JSON-LD | "Card not published yet" |
| `/fighters` | booked fighters + champions by default; `?q=`, `?letter=`, `?page=` browse the archive | search / letter empty states |
| `/fighters/[slug]` | record, physicals, rankings badge, next fight, striking/grappling totals from `ufc_bout_round_stats`, fight history, stories, Person JSON-LD | "No bout scheduled" / "History backfilling" |
| `/fights/[a]-vs-[b]-[event]` | face-off portraits, result + scorecards, round-by-round stats, tale of the tape with archive form, coverage, neighbours | 404 |
| `/rankings` | Storage snapshot `ufc-media/rankings/latest.json` (see docs/rankings.md), movers, P4P, ItemList JSON-LD | "Rankings snapshot not loaded yet" |
| `/news`, `/news?type=`, `/news/[slug]` | `ufc_articles` (published) + `ufc_news_items` wire; NewsArticle JSON-LD | "Nothing published yet" |
| `/pro`, `/login`, `/about` | static | — |
| `/feed.xml` (RSS 2.0 + content:encoded + media), `/sitemap.xml`, `/robots.txt` | generated | — |
| `/opengraph-image`, `/events/[slug]/opengraph-image`, `/fighters/[slug]/opengraph-image`, `/fights/[slug]/opengraph-image`, `/news/[slug]/opengraph-image` | edge `ImageResponse`, Google Fonts fetched at render (`lib/og.ts`) | branded fallback |
| `/icon.svg`, `/apple-icon`, `/site.webmanifest`, `/brand/*.svg` | brand system | — |

Slugs carry the source id so they need no lookup table:
`manel-kape-3155416`, `ufc-fight-night-royval-vs-kape-2025-12-14`.
`lib/resolve.ts` resolves them for pages and OG routes alike.

Every reader in `lib/db.ts` fails EMPTY (never throws) when the env is
missing, a table does not exist, or PostgREST errors. A fresh database
renders the whole shell with intentional empty states.

## Images

Fighter portraits are licensed Wikimedia Commons files stored in the public
Supabase Storage bucket `ufc-media` (`fighters/<fighter_id>/{portrait,card,thumb}.jpg`)
and registered in `ufc_images` with author, licence and source URL
(docs/images.md). `getImagesForFighters()` returns a `PortraitSet`; `Portrait`
and `Avatar` render a branded octagon/initials fallback when no licensed
image exists, and `Credit` renders the attribution line. Never add ESPN, UFC,
Getty or Sherdog imagery.

Funnel slots from the brief render as `ProLock`: a blurred placeholder that
never shows a number the model did not produce.

## Data freshness

- `ufc-stats-ingest` Worker (deployed 2026-09-06, cron 06:00 UTC) refreshes
  the ESPN schedule, bouts, results and fighters. It links ESPN events onto
  UFC Stats rows by date + name (see `scripts/merge_events.py` for the one-off
  dedupe that fixed 45 duplicate cards).
- `.github/workflows/newsroom.yml` runs the news ingest + article writer
  every 2 h, rankings Tue/Wed, portraits daily. Secrets: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, optional `ANTHROPIC_API_KEY` (enables `--llm`).
- Pages revalidate every 300 s; rankings snapshot every 1800 s.

## Vercel

| Setting | Value |
|---|---|
| Team | justin's projects (`team_fNvGcQj9hijhsrIMDZbv0DJQ`) |
| Project | `ufc-propbetedge` (`prj_7jhcaeuQSl4gpjFcEe3XdBqRfC8V`) |
| Env (Production) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-only) |
| Domain | `ufc.propbetedge.ai` |

Root Directory must be `web` for git-triggered builds. CLI deploys from
`/web` work regardless:

```
cd web
vercel deploy --prod --yes --scope justins-projects-ad4f4bb7
```

## Local QA

```
cd web && cp ../.env .env.local   # SUPABASE_URL + service key
npx next build && npx next start -p 3311
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --window-size=390,3400 --virtual-time-budget=8000 --screenshot=home-390.png http://localhost:3311/
```
