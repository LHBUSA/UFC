# Official UFC rankings ingest

`scripts/rankings/ingest_rankings.mjs` fetches https://www.ufc.com/rankings (static HTML, Chrome
User-Agent), parses the 13 official lists (men's P4P, 8 men's divisions, women's P4P, 3 women's
divisions: champion + ranks 1-15 with rank movement / NR flags), links every name to `ufc_fighters`
through `shared/alias_resolver.mjs` `normalize()` (fighter names + `ufc_fighter_aliases`, nicknames
excluded; a link is written only when exactly one fighter matches, otherwise `fighter_id` is null),
then writes a JSON snapshot to the public `ufc-media` Storage bucket. Every structural assumption
about the page is asserted; a changed page makes the script fail before it writes anything.

```
node scripts/rankings/ingest_rankings.mjs --dry-run           # parse + link, print per-division counts, write nothing
node scripts/rankings/ingest_rankings.mjs                     # upload snapshot, upsert ufc_rankings
node scripts/rankings/ingest_rankings.mjs --html saved.html   # parse a saved copy of the page
```

Snapshot (what the website reads):
`https://tkmlnhmylqnttmnsnief.supabase.co/storage/v1/object/public/ufc-media/rankings/latest.json`,
with a dated copy at `rankings/YYYY-MM-DD.json`. Shape: `{captured_at, source_url, snapshot_date,
divisions:[{key, label, is_womens, is_p4p, champion:{name, ufc_slug, fighter_id}|null, entries:[{rank,
name, ufc_slug, fighter_id, change, is_new}]}]}`. `change` is signed (positive = moved up), 0 when
unchanged, null when unknown; P4P lists have `champion: null` and their #1 is entry rank 1. Ties are
real (competition ranking: two entries at 10, then 12), so never assume ranks are contiguous.

Table: `migrations/003_ufc_rankings.sql` (`ufc_rankings`, RLS on, no policies) must be applied by hand
in the Supabase SQL editor. Until then PostgREST answers 404, the script logs "migration 003 not applied
yet", still writes the snapshot and exits 0. Once the table exists the same run starts upserting rows
(`on_conflict=snapshot_date,division,is_womens,rank,name_raw`) with no code change. Creds come from `.env`
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Run after each official update (Tuesdays after a card).
