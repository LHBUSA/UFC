# Fighter media pipeline v1: reviewed portraits

Branch `ufc-fighter-media-pipeline-v1`. Migration `supabase/migrations/20260910210000_ufc_fighter_media_pipeline.sql`.

## The rule

A public page shows a fighter photo only when a named reviewer approved that exact image for that fighter, the
identity is marked verified, and the rights fit the surface. Everything else gets the branded placeholder. A
placeholder is always acceptable; a wrong face never is.

What this replaced: public pages picked the newest `ufc_images` row for a fighter, else hotlinked
`a.espncdn.com/i/headshots/mma/players/full/<espn_athlete_id>.png`. Neither proved the face was the fighter: an HTTP
200 from a CDN is availability, not identity (Quentin Pasley, 2026-09-10), and 368 of the 540 stored rows carry no
recorded identity evidence.

## Tables

| Relation | Role |
| --- | --- |
| `ufc_fighter_media_candidates` | The review queue. Anything that might be a portrait, with source, rights, attribution, identity evidence, identity confidence, suitability and priority. Never read by a public page. |
| `ufc_fighter_media_assets` | Approved (and formerly approved) portraits. Constraints: an approved row must have `verified_identity`, non-empty evidence, a reviewer and `last_verified_at`; `commercial_use_allowed` needs an affirmative license basis; a partial unique index allows one `is_primary` per fighter. |
| `ufc_media_quarantine` | Images that must never be used again, for any fighter. Matching candidates are forced to `quarantined` by trigger; matching assets cannot be approved; inserting a quarantine row demotes matching assets everywhere. Matches on the query-stripped, lower-cased image URL or the exact source URL. |
| `ufc_fighter_portrait_eligible` (view) | Approved + verified + primary + not quarantined + not `internal_only`. The only relation public pages read. `security_invoker`, service-role only. |

Review writes go through `ufc_media_review_candidate(candidate, action, reason, reviewer, make_primary)` and
`ufc_media_quarantine_asset(asset, reason, reviewer)`, so promotion and the one-primary swap are atomic. No
function is `SECURITY DEFINER`; EXECUTE is revoked from anon/authenticated.

Seeded: the Pasley ESPN headshot quarantine (formerly `ESPN_DISPLAY_QUARANTINE` in code).

## Resolver: `web/lib/fighterMedia.ts`

- `resolveFighterPortraits(ids, { surface })` and `resolveArticleHero(ufcImagesId, { surface })`. Every public surface
  uses these; `db.ts` no longer has a function that picks a fighter photo.
- `surface` defaults to `high_visibility`; forgetting to classify a surface makes it stricter.
- `high_visibility` (homepage, fight week, fighter profiles, fight/matchup pages, event pages and index, rankings,
  weigh-ins, news, OG share images, RSS) additionally needs `commercial_use_allowed` and `surface_policy = all_surfaces`.
- `standard` (round-by-round archive, A–Z fighter index, Hall of Fame, TUF, injuries) accepts an approved asset whose
  `surface_policy` is `all_surfaces` or `standard_surfaces`, with or without a commercial grant.
- Policy is a pure function (`web/lib/fighterMediaPolicy.ts`, tests in `fighterMediaPolicy.test.mjs`) applied on top of
  the view, so a view regression cannot put an unreviewed face on a page.
- Missing env, missing relation (migration not applied), network error: empty map, placeholders, no error.
- Cached 300 s under the `fighter-media` tag; every review action calls `revalidateTag("fighter-media")`, so a
  quarantine reaches public pages on the next request.

## ESPN

No direct ESPN fallback remains. An ESPN headshot can appear only as a reviewed `ufc_fighter_media_assets` row. The
generator proposes ESPN candidates as `license_type = display_only`, `commercial_use_allowed = false`,
`proposed_surface_policy = standard_surfaces`: approvable for archive/index surfaces, never for high-visibility ones.
Identity evidence is the ESPN athlete API record (id, exact name, DOB against ours, headshot alt text), and the review
UI states plainly that a matching athlete record proves the slot, not the face.

## Review UI: `/admin/media`

Owner/admin accounts only (session role, re-checked inside every server action). Lists in-scope fighters without a
high-visibility portrait, highest priority first, each with its candidates: image, source link, rights, attribution,
identity confidence, suitability, priority, flags, identity evidence (summary and raw JSON).

- **Approve** requires ticking "I checked the face: this is <name>". Promotes into `ufc_fighter_media_assets` and makes
  it primary (unless "keep the current primary" is ticked and one exists).
- **Reject** requires a reason; recorded on the candidate.
- **Quarantine** requires a reason; blocks that image for every fighter and pulls any approved copy out of service.
- The current approved portrait (if only standard-cleared) can be quarantined from the same page.
- `/admin/media/coverage` and `/admin/media/coverage.json`: coverage report.

## Queue generator: `scripts/media/fighter_portrait_queue.mjs`

Scope (rules in `buildScope`): champions and ranked fighters, P4P, the next three cards (main event of the next card
highest), homepage featured fighters (main events of the schedule strips, champions, top-3 contenders), the active
roster, and fighters who had a stored photo before this pipeline (lowest priority). Fighters that already have a
high-visibility portrait are skipped.

Sources: `ufc_images` (stored first-party, evidence carried over or flagged `no_identity_evidence`), the older
`ufc_image_candidates` Commons ledger (non-photo formats auto-rejected), and the ESPN athlete API. It never approves.
Inserts are `on_conflict=fighter_id,image_key` ignore-duplicates, so re-runs never reset a decision.

```
UFC_ENV_FILE=C:/Workers/ufc-propbetedge/.env node scripts/media/fighter_portrait_queue.mjs           # dry run -> JSON in %TEMP%
UFC_ENV_FILE=C:/Workers/ufc-propbetedge/.env node scripts/media/fighter_portrait_queue.mjs --apply   # insert
```

## Coverage: `scripts/media/fighter_portrait_coverage.mjs`

Per group (ranked, next card, next 3 cards, featured, active, legacy-photo, whole scope): what main showed before
(stored + ESPN fallback, ESPN HEAD-probed), what the pipeline serves now (high-visibility / standard-only), and the
ceiling reachable by reviewing the candidates on file. `--queue <dryrun.json>` works before the migration is applied.

## Tests

- `node --experimental-strip-types --test web/lib/fighterMediaPolicy.test.mjs`
- `PG_BIN="C:/Program Files/PostgreSQL/17/bin" node scripts/media/test_media_migration.mjs` applies the migration to a
  throwaway local cluster, runs `supabase/migrations/tests/20260910210000_ufc_fighter_media_pipeline.test.sql`,
  rolls back, re-applies twice and re-tests.

## Rollout order

1. Apply the migration (additive; nothing reads it until the web build that does is live).
2. `fighter_portrait_queue.mjs --apply`.
3. Review in `/admin/media`, next card and ranked fighters first. Coverage report to track.
4. Only then promote the web build. Promoting before review ships placeholders on every public surface: the resolver
   fails closed.

Not covered: the `ufc-api` Worker's media catalog still reads `ufc_images` directly (Workers are frozen); approval
does not copy hotlinked Commons/ESPN bytes into first-party storage (candidates carry a `hotlinked_not_stored` flag).
