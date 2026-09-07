# UFC preservation inventory — baseline `461b383` (ufc-fight-dna-v1)

Recorded 2026-09-06 before starting task branch `ufc-preservation-guard`. This is the
surface every subsequent task must keep. Machine-readable copy:
`web/scripts/preservation-baseline.json` (checked by `npm run preserve:check`, which runs
automatically as `prebuild`).

## Rule

- `ufc-fight-dna-v1` is the product authority. Branch every task from its head.
- Every task is additive. Nothing below may be removed or replaced unless Justin says so.
- Before a preview: `npm run preserve:diff -- <start-sha> --strict`, then BEFORE/AFTER
  screenshots at 1440 and 390.
- New work may improve the current site. New work may not recreate an older version.

## Navigation (`web/lib/site.ts` NAV)

Home · Schedule · DWCS (Contender Series) · Fighters · Rankings · History · News · Pro

(DWCS was added to the primary nav by this task; it was previously reachable only from the
homepage strip, the schedule page and the footer.)

## Routes (18)

`/`, `/about`, `/account`, `/contender-series`, `/events`, `/events/[slug]`, `/fighters`,
`/fighters/[slug]`, `/fights/[slug]`, `/hall-of-fame`, `/history`, `/login`, `/news`,
`/news/[slug]`, `/pro`, `/qa/preview` (dev-only fixtures, 404 on Vercel), `/rankings`,
`/voices/[key]` (joe-rogan, daniel-cormier, dana-white)

Generated icon/OG routes: `/icon.svg`, `/icon1.png`, `/icon2.png`, `/apple-icon`,
`/pwa-icon-192`, `/pwa-icon-512`, `/opengraph-image`, `/events/[slug]/opengraph-image`,
`/fighters/[slug]/opengraph-image`, `/fights/[slug]/opengraph-image`,
`/news/[slug]/opengraph-image`, `/voices/[key]/opengraph-image`, `/site.webmanifest`,
`/robots.txt`, `/sitemap.xml`, `/feed.xml`.

## Homepage modules (in order)

1. Hero with next-event poster (fighter faces, countdown, hero stats)
2. Pregame Desk (marquee + supporting briefs, evidence packet)
3. Next card segments + official fight-week video rail (when video rows exist)
4. Headline matchups (tale of the tape)
5. Champions stage (portrait cards, original belt, top-3 contenders)
6. Newsroom (timestamped story cards)
7. Notable voices (Joe Rogan, Daniel Cormier, Dana White)
8. Coming up + The wire, then the Contender Series strip
9. Heritage close (History, Hall of Fame, UFC.com)
10. Recent cards
11. Official UFC destinations
12. Free vs Pro plans

## Visual assets (must not vanish)

- Backgrounds: `public/media/ufc-cage-bg-1600.webp`, `ufc-cage-bg-960.webp`,
  `ufc-fence-1400.webp` (body cage atmosphere, fence texture behind heroes/stages)
- Brand: `public/brand/mark.svg`, `logo.svg`, `logo-wide.svg`; app icons under `web/app/`
- Voice portraits: `public/media/voices/joe-rogan-660.webp`, `daniel-cormier-660.webp`,
  `dana-white-660.webp`, `dana-white-900.webp` (provenance in `public/media/README.md`)
- Fighter portraits: `ufc_images` canonical assets → ESPN display fallback → branded initials
- Event imagery: event OG cards, poster faces
- Theme: dark near-black surfaces, gold accents, Playfair display / Inter / JetBrains Mono

## Data / features

Fight DNA (`lib/dna.ts`, `components/dna.tsx`), DWCS separation (`lib/contender.ts`,
`/contender-series`, homepage strip), historical archive + per-year coverage
(`lib/archive.ts`, history-gap-repair workflow), official video layer (`ufc_videos`,
`components/OfficialVideo.tsx`, `components/VideoRail.tsx`), newsroom (`scripts/news/*`,
timestamped cards), rankings snapshot, fighter career stats, round stats, event cards,
image provenance (credits on every portrait), Pregame Desk brief builder
(`lib/pregame.ts`), voices profiles (`lib/voices.ts`), heritage data (`lib/heritage.ts`).
