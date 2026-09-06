# UFC Final Release Handoff — 2026-09-06

Work only in `C:\Workers\ufc-propbetedge` on `ufc-fight-dna-v1`.

Current release branch includes the accepted V3 product, Fight DNA, sitewide media fallback, passwordless account/auth code, owner entitlement UX, nav fix, favicon/PWA identity, social metadata/share controls, and the world-class editorial desk. PR #3 is intentionally draft and mergeable.

Do not redesign the product. Do not reset/clean/stash over unrelated work. Do not print or paste secrets. Do not merge PR #3 until explicitly instructed.

## 1. Sync and prove exact branch

```powershell
cd C:\Workers\ufc-propbetedge
git fetch origin
git switch ufc-fight-dna-v1
git pull --ff-only origin ufc-fight-dna-v1
git status --short
git rev-parse HEAD
```

Expected branch includes merge commit `226398af6b002a83ec2b64479b640d7ca0d2600b` or a later fast-forward commit.

Run:

```powershell
cd web
npm ci
npm run build
npx tsc --noEmit
```

## 2. Resend runtime readiness — required release gate

Canonical Vercel project is `ufc-propbetedge`, project id `prj_7jhcaeuQSl4gpjFcEe3XdBqRfC8V`, team `justins-projects-ad4f4bb7`.

The UFC auth routes intentionally expect `RESEND_API_KEY` only server-side. The Resend account already has verified `propbetedge.ai` and the sender is `PropBetEdge UFC <picks@propbetedge.ai>`.

Use the logged-in Vercel CLI to inspect variable NAMES only:

```powershell
vercel env ls
```

Confirm whether `RESEND_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` exist for Production and Preview. Do not echo or print secret values.

If `RESEND_API_KEY` already exists, proceed to the auth smoke below.

If it is missing, first check whether an existing secure local environment/secret source already supplies it without printing the value. If yes, add it to the UFC Vercel project non-interactively and do not log the secret. If no accessible secret value exists, STOP and report exactly `RESEND_API_KEY missing; value not available locally`. Do not create a new key, scrape one from another system, or expose a secret in terminal/chat.

Auth smoke against the branch preview:

1. `GET /api/auth/health` must return 200 with `{ ok:true, database:true, email:true }`.
2. Request one magic link for `sales@localhomebuyersusa.com` through the UI/API.
3. Confirm Resend returns success; do NOT paste the token/link in the report.
4. Follow the link in the authenticated browser and confirm `/account` renders `OWNER · UNLIMITED`.
5. `/pro` must show active owner access and no purchase CTA for this session.
6. Sign out, then confirm account becomes unauthenticated.

Never send or display session cookies/tokens in the report.

## 3. Fighter-photo acceptance — every surface

The central `getImagesForFighters()` contract is now:

1. rights-cleared canonical PropBetEdge asset from `ufc_images`;
2. otherwise that fighter's own ESPN MMA headshot via `espn_athlete_id` as DISPLAY ONLY;
3. otherwise branded initials fallback.

ESPN fallback must never be written into `ufc_images`, marked redistributable, or exposed as a PropBetEdge-owned media asset.

Verify the next card and at least one later card at 1440 and 390. Check:

- homepage poster / matchup faces
- event card rows
- fighter profile hero
- fighter index / booked roster
- rankings
- matchup page
- article face modules
- fighter/event/matchup OpenGraph images where the renderer uses the portrait set

For the next card, report:

- unique fighters
- canonical PBE media count
- ESPN display fallback count
- true initials fallback count

Expected true fallback should be near zero because every currently canonical-missing upcoming fighter had an ESPN athlete ID when audited.

Explicitly look for broken ESPN 404s. If an athlete URL is 404, keep that fighter on the branded fallback; do not show broken media.

## 4. Header/nav visual acceptance

The next-event pill must no longer read as a chopped fragment.

Capture at:

- 1440
- 1280
- 1024
- 390

Acceptance:

- event label/name/date legible at large widths
- graceful progressive collapse at smaller desktop widths
- no overlap with Sign in/Account or Go Pro
- no horizontal overflow
- mobile nav still clean
- canonical PropBetEdge branding intact

## 5. Sign-in visual acceptance

Capture `/login` desktop + mobile.

Check:

- premium split layout
- no disabled/mock language
- email form usable by keyboard
- success and error states readable
- network links correct
- no overflow
- no secret or technical implementation detail exposed

## 6. Favicon / metadata / share acceptance

Verify:

- `/icon.svg`
- `/apple-icon`
- `/pwa-icon-192`
- `/pwa-icon-512`
- `/site.webmanifest`
- browser tab at normal tab scale

Representative metadata matrix:

- `/`
- one upcoming `/events/[slug]`
- one `/fighters/[slug]`
- one `/fights/[slug]`
- one `/news/[slug]`
- `/pro`

Check title, description, canonical, og:title, og:description, og:url, 1200×630 og:image, Twitter large card, valid JSON-LD, no preview hostname in canonical metadata.

Share control must appear only on fighter/fight/event/article detail pages and share/copy canonical `https://ufc.propbetedge.ai/...` URLs.

## 7. Article quality + automation proof

The default-branch scheduler was updated to run source ingest every 30 minutes while explicitly checking out `ufc-fight-dna-v1` until release. The branch writer now performs:

`source ingest -> deterministic fact-block writer -> optional first rewrite -> fail-closed world-class editorial desk`

The final desk is `scripts/news/polish_world_class.mjs`.

Inspect the latest `newsroom` workflow run. Prove:

- ingest ran
- gate decision is visible
- deterministic writer ran when gated
- `World-class editorial desk (fail closed)` ran when `ANTHROPIC_API_KEY` is configured
- no secret output

Then inspect at least:

- one upcoming main-event preview
- one standard main-card/prelim preview
- one results story
- one external/source brief

Acceptance:

- no repeated template opening across stories
- evidence-led headline
- real matchup/fight meaning, not data recitation
- Bettor's Edge includes supporting evidence + counter-case/risk
- missing data mentioned once rather than becoming the article
- no invented odds, injuries, probabilities, model output, rankings, or quotes
- every number traceable to stored packet
- article hero crop is clean

If the editorial desk is holding most articles, inspect validator reasons and patch false-positive validation only. Never loosen the no-new-facts/no-new-numbers/no-new-links gates.

## 8. Production release

The latest known release-candidate Vercel deployment before this handoff is associated with the `ufc-fight-dna-v1` branch and PR #3. Resolve the current newest READY deployment from the branch rather than assuming an old ID.

Only after all gates above pass:

- promote the newest READY `ufc-fight-dna-v1` deployment to Production/custom domain using the logged-in Vercel CLI;
- do NOT merge PR #3 as part of this promotion;
- smoke `https://ufc.propbetedge.ai/`, `/login`, `/events`, a fighter, a matchup, an article, `/robots.txt`, `/sitemap.xml`, and the auth health endpoint;
- confirm zero fatal/error runtime logs from the release smoke.

Stop with:

- exact promoted commit
- exact production deployment id
- screenshot paths
- photo source counts
- auth health booleans (not secrets)
- newsroom workflow result + editorial desk counts
- production smoke matrix
- any remaining blockers

Do not merge main unless Justin explicitly approves the release PR after this acceptance report.
