# Combat source review — 2026-09-10

This is an operational review, not a claim that public facts are owned by a
publisher. The question here is narrower: **may our automated system access,
persist and reuse this provider's compiled feed under its current terms?**
`combat_sources` is fail-closed until that answer is explicit.

## Fight Forensics — HOLD / permission required for Career DNA persistence

Public API: `https://fightforensics.com/api/v1`
Terms: `https://fightforensics.com/terms`

Useful characteristics:

- very broad professional MMA graph;
- fighter lookup plus recent bout history;
- events and promotion coverage;
- source-native IDs and JSON API;
- attribution is required.

Current terms also prohibit bulk extraction/systematic downloading and using
the service to train, fine-tune or build machine-learning models. That makes it
a useful human/reference source but not an automatic warehouse/backfill source
for our intended full Career DNA graph without written permission or a changed
agreement.

**Registry state:** `review_required`, disabled.

## UFCalendar Fight API — leading commercial API candidate

Developer page: `https://www.ufcalendar.com/developers`
Terms: `https://www.ufcalendar.com/developers/terms`

Current terms state that paid tiers may use the data in commercial products for
display and analysis. Raw dataset/substantial-portion redistribution is
restricted, with bulk redistribution requiring an Enterprise written contract.
The API advertises UFC/PFL/OKTAGON/BKFC events, fights, round data, fighter
career timelines and rankings in one schema.

That fits a **commercial display/derived-analysis pilot** much better than a
scraper, but we should not mark it `approved_ingest` until the purchased
plan/contract explicitly covers:

1. persistence/cache duration in our database;
2. Career DNA and other derived analytics;
3. API responses to PropBetEdge customers;
4. whether any raw source rows may leave our internal system;
5. attribution/image obligations;
6. bulk/history retrieval method and quota.

If we want raw/full downstream redistribution, negotiate Enterprise rather than
assuming a lower tier covers it.

**Registry state:** `review_required`, disabled.

## Combat Registry / MixedMartialArts.com — BLOCK automated access without consent

ABC material identifies the MMA registry / MixedMartialArts.com as the official
record-keeping database used by commissions. That makes it a very high-quality
potential authority for identity, official records and suspensions.

Current MixedMartialArts.com user terms, however, prohibit scraping/copying data
through any means, distribution without consent, and unauthorized automated
methods. The right path is a direct data/license relationship, not scraping the
site.

**Registry state:** `blocked`, `rights_state=prohibited`, disabled until written
consent/agreement changes the operational state.

## SportsDataIO / Sportradar

Commercial sports-data providers and valid candidates for licensed feeds. They
remain disabled until product coverage and contract rights are confirmed; in
particular we need to know whether they solve only UFC-native live/depth data or
also the cross-promotion career graph.

**Registry state:** `review_required`, disabled.

## Existing UFC Stats / ESPN identities

The combat layer may reuse UFC Stats and ESPN IDs that are **already stored and
resolved on `ufc_fighters`** as identity namespaces. That is not authorization
for a new cross-promotion scraper or new raw-feed redistribution.

**Registry state:** `identity_only`, enabled for bridge identity writes only.

## Wikidata

Wikidata is CC0 and is approved for identity/reference facts. It is not expected
to provide enough bout-level history to solve Career DNA by itself.

**Registry state:** `approved_ingest`, enabled.

## Decision

Do not build a Sherdog/Tapology/Fight Forensics/Combat Registry scraper to make
the row count jump. The first actual non-UFC Career DNA adapter should be a
provider for which persistence + commercial derived use are explicit. Based on
this review, **UFCalendar is the first API to evaluate commercially**, while a
direct Combat Registry agreement would be the strongest authority path if one
can be obtained.
