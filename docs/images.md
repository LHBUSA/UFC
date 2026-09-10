# Fighter portraits

**What public pages render** is decided by the reviewed pipeline in
[fighter_media_pipeline.md](fighter_media_pipeline.md): only an approved, identity-verified
`ufc_fighter_media_assets` row reaches a page, and there is no ESPN fallback. `ufc_images` below is the ingest
store that feeds the review queue; a row there is a candidate, not a published photo.

**Licensing rule.** Never UFC/Zuffa/Getty/ESPN/Sherdog imagery, never an AI-generated likeness. Automated portrait
acquisition uses Wikimedia Commons, and only files whose `LicenseShortName` is CC0, Public domain, CC BY x.x or
CC BY-SA x.x. Fair use, NC, ND and GFDL-only files are rejected. Every stored image carries `license`, `author` and
`source_url` (the Commons file page) in `ufc_images`; the site MUST render that as a credit line next to the image.

## Discovery pipeline

`scripts/images/fetch_fighter_portraits.mjs` runs on Node 24 and uses `web/node_modules/sharp`.

1. Resolve fighter identity through Wikidata `wbsearchentities`; keep candidates whose description identifies an MMA /
   mixed-martial-arts fighter. When a DOB is stored, Wikidata P569 must match. Without a DOB, only one MMA candidate may
   survive. Multiple unresolved candidates fail closed as `ambiguous`.
2. Prefer the verified entity's P18 image.
3. If P18 is missing or its license is not redistributable, inspect a bounded set of files from the **exact Commons
   category linked by that same verified Wikidata entity** (P373 or Commons sitelink). This is not a global/free-text
   image search. Category candidates must pass the same license gate, carry fighter-name evidence in file metadata,
   meet minimum dimensions, and have a portrait-like aspect ratio.
4. For rare cases where Wikidata identity/image linking is incomplete but a human has verified a specific Commons
   file, `scripts/images/commons_overrides.json` may map a fighter UUID to that file. Overrides are fighter-name locked
   and still go through live Commons imageinfo, identity-evidence and license validation. They do **not** bypass rights
   checks.
5. Sharp derives `portrait.jpg` (original composition preserved, <=1200 long edge), `card.jpg` (800x1000 attention
   crop) and `thumb.jpg` (320x400 attention crop).
6. Upload to the public Supabase Storage bucket `ufc-media`, then upsert one `ufc_images` row per fighter
   (`kind='wikimedia'`, `r2_key='fighters/<fighter_id>/portrait.jpg'`, upsert on `r2_key`).
7. Fighters with no identity-safe, acceptable image get NO row. A stored row is then queued for review by
   `scripts/media/fighter_portrait_queue.mjs`; until a reviewer approves it the site renders the branded fallback card.

## Storage layout

`ufc-media/fighters/<fighter_id>/{portrait,card,thumb}.jpg`. Only `portrait.jpg` is recorded in
`ufc_images.r2_key`; derive the other two by replacing the basename:

- `{SUPABASE_URL}/storage/v1/object/public/ufc-media/fighters/<fighter_id>/portrait.jpg` — full-composition hero source
- `.../card.jpg` — 4:5 fighter/fight-card derivative
- `.../thumb.jpg` — lists / avatars

Credit: `"<author>, <license>, via Wikimedia Commons"` linking to `source_url`.

## Frontend art direction

The Sharp derivatives are **not** permission for the browser to crop the image a second time from `top center`.
`web/app/media-fixes.css` is the media art-direction layer:

- avatars and fighter/event portraits use an upper-middle focal bias rather than y=0;
- 16:9 newsroom cards preserve the full 4:5 portrait over the UFC cage/fence atmosphere instead of producing a
  forehead-only strip;
- very wide article heroes use a blurred/dimmed atmospheric background copy plus the full uncropped portrait in the
  foreground;
- `web/components/og.tsx` uses a safe upper-middle focal position for social cards, never `top center`.

If future focal-point metadata is added, it should replace the default percentages here rather than reintroducing a
hard-coded top crop.

## Re-running

`node scripts/images/fetch_fighter_portraits.mjs` walks every row of `ufc_fighters`, prioritizing fighters on events
dated today or later (`--no-priority` disables priority). Results are cached for 30 days in
`scripts/images/cache/lookups.json` (gitignored) per fighter `{status, checked_at}`.

Options:

- `--force` re-checks cached rows
- `--fighter <uuid>` targets one fighter
- `--limit N` caps the run
- `--dry-run` performs discovery/validation but writes nothing
- `--missing-only` skips fighters that already have a stored Wikimedia portrait

Wikimedia calls are rate-limited to roughly 2 requests/sec with the PropBetEdge UFC user agent. Run the production
portrait job after fighter ingest; use `.github/workflows/portrait-media-qa.yml` to dry-run missing-fighter discovery
before broad resolver changes are allowed to write.

## Coverage standard

Photo coverage is a product KPI. Prioritize next card, next four cards, ranked/champion fighters, active fighters,
then historical fighters. The goal is 100% next-card coverage **where rights-safe media actually exists**; the identity
or license gates are never weakened to hit the number. When free/redistributable media does not exist, use the premium
branded fallback until an explicitly licensed editorial/press-media provider is available.
