# combat-wikipedia-ingest

Cloudflare-owned direct Career DNA ingestion from English Wikipedia's Wikimedia
Action API.

This worker exists so PropBetEdge can own its cross-promotion normalization
instead of paying a downstream aggregator for UFCStats/Wikipedia-derived facts.
It is independent from `ufc-stats-ingest`; UFC-native rows remain in `ufc_*`.

## Safety defaults

`wrangler.toml` ships with:

```toml
SCHEDULE_ENABLED = "false"
WRITE_ENABLED = "false"
```

Deploying the Worker therefore does **not** start a backfill and does not write
Career DNA. The Cloudflare cron exists but exits immediately while scheduling is
disabled.

The Worker never attempts to solve or bypass an access challenge. Wikimedia is
called through the documented Action API with an identifying User-Agent,
`maxlag`, sequential throttling, retry/backoff and a hard per-run request cap.

## Secrets

From the Worker directory:

```powershell
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ADMIN_TRIGGER_TOKEN
```

Optional:

```powershell
wrangler secret put DISCORD_WEBHOOK_URL
```

Do not commit secret values.

## Tests

```powershell
npm install
npm test
npx wrangler deploy --dry-run
```

The parser test deliberately includes a larger kickboxing table after the MMA
table; the worker must still select the `Mixed martial arts record` section.
The logic tests pin the UFC-history identity checksum and the rule that unknown,
undated or unlinked rows never auto-promote.

## Deploy

Workers for this repo deploy from `C:\Workers\` with Wrangler. GitHub is source;
Cloudflare owns execution and scheduling.

```powershell
npm install
wrangler deploy
```

## Canary — no writes

After deploy, call:

```text
POST /admin/canary
Authorization: Bearer <ADMIN_TRIGGER_TOKEN>
```

With no fighter query, the canary checks:

- Kayla Harrison — positive UFC + PFL multi-promotion case.
- Patricio Pitbull — positive UFC + Bellator/PFL/Rizin-style history case.
- Salahdine Parnasse — deliberate one-completed-UFC-bout freshness case plus KSW history.

The identity checksum uses **completed UFC bouts only**. Announced/upcoming bouts
must never make a valid career page fail verification merely because Wikipedia
does not list a fight that has not happened yet.

Kayla and Patricio should normally be positive controls when their Wikipedia
records are current. Parnasse is intentionally useful as a fail-closed control:
if Wikipedia has not yet added his completed UFC bout, the correct canary result
is `unverified` / identity review. That proves freshness cannot be forced through
the identity gate.

A multi-UFC-fight page needs at least two exact opponent+date overlaps and zero
unexplained Wikipedia UFC rows. A one-completed-UFC-bout fighter requires
matching DOB plus the exact completed UFC bout.

No database writes occur on `/admin/canary`, regardless of `WRITE_ENABLED`.

Target a specific fighter with either:

```text
POST /admin/canary?combat_fighter_id=<uuid>
POST /admin/canary?fighter=Kayla%20Harrison
```

Name lookup is exact-normalized and refuses ambiguous names; use the combat UUID
for names such as Bruno Silva.

## Manual audit run

```text
POST /admin/run?limit=5
```

This automatically selects ranked/upcoming fighters first, then active UFC
fighters, then the rest of the UFC-linked graph. It is audit-only unless both:

1. the request includes `write=1`; and
2. `WRITE_ENABLED="true"` in the Worker environment.

If either is missing, no Career DNA write occurs.

## Rollout

1. Deploy with both flags false.
2. Run `/admin/canary` and inspect identity/coverage output.
3. Run a 5–10 fighter manual audit.
4. Only after the positive controls pass and any fail-closed cases make sense,
   set `WRITE_ENABLED="true"` and redeploy.
5. Run one explicit `/admin/run?limit=5&write=1`.
6. Verify `combat_*` counts, review queue, idempotency and UFC-only DNA regression.
7. Then set `SCHEDULE_ENABLED="true"` and redeploy.

The production cron is `17 */6 * * *` with five fighters per pass by default.
The worker skips already verified inactive careers and periodically refreshes
active Wikipedia identities after `REFRESH_DAYS` (default 30).

## What writes

For a verified fighter page, the write lane may create/update:

- `combat_fighter_identities`
- `combat_fighter_aliases`
- source-native `combat_fighters` for unambiguous linked opponents
- recognized `combat_promotions`
- `combat_events`
- `combat_bouts`
- `combat_bout_results`
- `combat_ingest_packets`
- `combat_identity_review_queue`

It does **not** write Wikipedia UFC rows into `combat_bouts`; those rows are used
only to prove page identity against completed `combat_career_bouts` rows where
`source_scope='ufc'`.

The same external fight seen from both fighters is deduped by event + unordered
fighter pair, and conflicting result claims go to review rather than silently
overwriting the stored result.

Unrecognized promotions, missing dates, missing stable opponent links, identity
collisions and result conflicts fail closed or enter review rather than being
guessed.
