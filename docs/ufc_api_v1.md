# PropSports UFC API v1

Status: beta contract on branch `ufc-api-v1`.

## Architecture

The public UFC product is intentionally split into four layers:

1. Source ingest: ESPN for schedule/results/identity plus UFC Stats for historical and round-level statistics.
2. Normalized `ufc_*` tables in Supabase. RLS remains closed; the service role is never exposed to browsers or customers.
3. `workers/ufc-api`: read-only Cloudflare Worker that owns the external contract.
4. `ufc.propbetedge.ai`: a client of that API contract, not a direct Supabase consumer.

This keeps the website, future PropSports customers, MCP, mobile apps, and internal tools on one stable data contract.

## Contract principles

- Read-only in v1.
- No browser or customer receives a Supabase service-role credential.
- No fabricated rankings, odds, picks, images, or editorial facts.
- Missing source facts remain `null` or an explicit unavailable response.
- Source-specific IDs are accepted for canonical lookup: internal UUID, UFCStats ID, or ESPN ID.
- Historical/display career snapshots are labeled so they are not accidentally used as as-of model features.
- Responses use a stable envelope: `{ ok, data, meta }`; failures use `{ ok:false, error, meta }`.
- All responses carry `X-Request-Id` and `X-API-Version`.
- Public GET responses are edge-cacheable. Upcoming/news/search surfaces use shorter TTLs than historical data.

## Endpoints

- `GET /v1/ufc`
- `GET /v1/ufc/events?status=upcoming|recent|all&date=YYYY-MM-DD&limit=N`
- `GET /v1/ufc/events/{id}`
- `GET /v1/ufc/events/{id}/card`
- `GET /v1/ufc/fighters?q=&active=true|false&limit=N`
- `GET /v1/ufc/fighters/{id}`
- `GET /v1/ufc/fighters/{id}/history`
- `GET /v1/ufc/fighters/{id}/stats`
- `GET /v1/ufc/bouts/{id}`
- `GET /v1/ufc/bouts/{id}/stats`
- `GET /v1/ufc/results?limit=N`
- `GET /v1/ufc/rankings` — returns explicit `501 rankings_not_available` until a verified rankings table is populated.
- `GET /v1/ufc/news?story_type=&limit=N`
- `GET /v1/ufc/articles/{slug}`
- `GET /v1/ufc/search?q=&limit=N`
- `GET /v1/ufc/counts`

## Authentication

During internal beta, `REQUIRE_API_KEY=false` can be used while the website migration is proven.

For commercial mode set `REQUIRE_API_KEY=true` and use either:

- `INTERNAL_API_KEY` Wrangler secret for the first-party website/server; or
- an `API_KEYS` KV binding. Customer keys are stored only as `key:<sha256(raw-key)>` records, for example:

```json
{
  "id": "customer_123",
  "tier": "developer",
  "enabled": true,
  "expires_at": null
}
```

The raw customer key is never stored in KV.

## Deployment gate

Before production cutover:

1. `cd workers/ufc-api && npm install`
2. `npm test`
3. `npm run check`
4. `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
5. `npx wrangler deploy`
6. Exercise every endpoint against the real database.
7. Set Vercel server env `UFC_API_BASE_URL` to the deployed worker origin.
8. If auth is enabled, set Vercel server env `UFC_API_KEY` to the internal key.
9. Deploy the web branch and verify parity against the current production site.
10. Only then merge to `main`.

## Commercial follow-on

The same contract can later be mounted behind a PropSports API hostname and extended without breaking the website:

- card-change history
- weigh-ins
- officials/judges/referees
- medical suspensions where permitted
- odds and line movement
- verified rankings history
- as-of matchup features
- model probabilities and grading history
- MCP tools backed by these endpoints

Image licensing is independent of factual data licensing. Only image references with appropriate redistribution rights should be returned to third-party API customers.
