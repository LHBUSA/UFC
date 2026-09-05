# ufc.propbetedge.ai — frontend runbook

Next.js 15 (App Router, TypeScript, no Tailwind) in `/web`. Design tokens are
copied verbatim from `nfl-propbetedge-new/PROPBETEDGE_DESIGN_SYSTEM.md`
(warm ink, paper, gold rules, Playfair for brand moments, JetBrains Mono for
data). Gold is a line before it is a surface.

## Routes

| Route | Source | Empty state |
|---|---|---|
| `/` | next event + bouts, upcoming, recent, articles, counts | hero renders; "Next card loading" |
| `/events`, `/events/[slug]` | `ufc_events`, `ufc_bouts` joined to fighters + results | "Card not published yet" |
| `/fighters?q=`, `/fighters/[slug]` | `ufc_fighters`, fight history via bouts | "Fighter archive loading" / "History backfilling" |
| `/fights/[a]-vs-[b]-[event]` | resolved from event date + fighter names | 404 page |
| `/news`, `/news/[slug]` | `ufc_articles` (published only) | "Nothing published yet" |
| `/rankings` | none yet (Phase 2 table) | honest empty state, division grid |
| `/pro`, `/login`, `/about` | static | — |
| `/feed.xml`, `/sitemap.xml`, `/robots.txt`, `/opengraph-image` | generated | — |

Slugs carry the source id so they need no lookup table:
`manel-kape-3155416`, `ufc-fight-night-royval-vs-kape-2025-12-14`.

Every reader in `lib/db.ts` fails EMPTY (never throws) when the env is
missing, a table does not exist, or PostgREST errors. A fresh database
renders the whole shell with intentional empty states. Verified locally with
no env: 16 routes return 200 with content, unknown paths return the branded
404.

Funnel slots from the brief render as `ProLock`: a blurred placeholder that
never shows a number the model did not produce.

## Vercel

| Setting | Value |
|---|---|
| Team | justin's projects (`team_fNvGcQj9hijhsrIMDZbv0DJQ`) |
| Project | `ufc-propbetedge` (`prj_7jhcaeuQSl4gpjFcEe3XdBqRfC8V`) — new, dedicated. `backfill` / `backfill-r154` are NOT the website. |
| Git | connected to `LHBUSA/UFC` main |
| Env (Production) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (tkmlnhmylqnttmnsnief service key; server-only) |
| Domain | `ufc.propbetedge.ai` attached to the project |
| Deployment protection | team default: vercel.app URLs behind SSO, custom domain public |

### Two manual settings the CLI cannot set

1. **Root Directory = `web`** and **Framework Preset = Next.js** in
   Vercel → Project → Settings → General. Until this is set, git-triggered
   builds run from the repo root and fail (they do not replace the current
   production deployment). CLI deploys from `/web` work regardless.
2. **DNS**: `ufc.propbetedge.ai` has no public DNS record (NXDOMAIN). The
   zone is on Cloudflare (`igor/sunny.ns.cloudflare.com`). Add
   `CNAME ufc -> cname.vercel-dns.com` (DNS only, grey cloud) or
   `A ufc -> 76.76.21.21`. Vercel verifies automatically.

### Deploy by hand

```
cd web
vercel deploy --prod --yes --scope justins-projects-ad4f4bb7
```

Vercel refuses Next.js 15.5.4 as vulnerable; the app pins 15.5.25.
