# Fighter portraits

**Licensing rule.** Never UFC/Zuffa/Getty/ESPN/Sherdog imagery, never an AI-generated likeness. The only source is
Wikimedia Commons, and only files whose `LicenseShortName` is CC0, Public domain, CC BY x.x or CC BY-SA x.x. Fair use,
NC, ND and GFDL-only files are rejected. Every stored image carries `license`, `author` and `source_url` (the Commons
file page) in `ufc_images`; the site MUST render that as a credit line next to the image.

**Pipeline** (`scripts/images/fetch_fighter_portraits.mjs`, Node 24, uses `web/node_modules/sharp`):
1. Wikidata `wbsearchentities` on the fighter name; keep candidates whose description mentions MMA / mixed martial arts / fighter.
   With a DOB on file the candidate's P569 must match; without one, accept only a single candidate. 2+ live candidates = `ambiguous`.
2. Entity JSON -> P18 filename -> Commons `imageinfo` (url, 1200px thumb, extmetadata). License allowlist applied here.
3. sharp derives `portrait.jpg` (<=1200 long edge, q82 mozjpeg), `card.jpg` (800x1000 attention crop), `thumb.jpg` (320x400 cover).
4. Upload to the public Supabase Storage bucket `ufc-media`, then upsert one `ufc_images` row per fighter
   (`kind='wikimedia'`, `r2_key='fighters/<fighter_id>/portrait.jpg'`, upsert on `r2_key`).
5. Fighters with no acceptable image get NO row; the site renders the branded fallback card.

**Storage layout.** `ufc-media/fighters/<fighter_id>/{portrait,card,thumb}.jpg`. Only `portrait.jpg` is recorded in
`ufc_images.r2_key`; derive the other two by replacing the basename:
`{SUPABASE_URL}/storage/v1/object/public/ufc-media/fighters/<fighter_id>/portrait.jpg` (hero / OG image),
`.../card.jpg` (fight-card tiles), `.../thumb.jpg` (lists). Credit: `"<author>, <license>, via Wikimedia Commons"` linking to `source_url`.

**Re-running.** `node scripts/images/fetch_fighter_portraits.mjs` walks every row of `ufc_fighters`, fighters on
`ufc_bouts` for events dated today or later first (`--no-priority` to disable). Results are cached for 30 days in
`scripts/images/cache/lookups.json` (gitignored) per fighter `{status, checked_at}`; `--force` re-checks,
`--fighter <uuid>` targets one fighter, `--limit N` caps the run, `--dry-run` looks up but writes nothing.
Wikimedia is called at ~2 req/s with the `PropBetEdgeUFC/1.0` User-Agent. Run it after every fighter ingest.
