// THE PREDICTION MARKET MUST NOT LEAK INTO A PBE MODEL (owner 2026-10-03).
//
// pbe-fight-model-v1 is independent of BOTH prediction-market venues (Kalshi,
// Polymarket). Venue prices are benchmark/context only and may never enter a
// model input (fighters, Fight DNA snapshots, bout-feature rows), the feature
// vector, or a table/endpoint a model input is read from.
//
// Adapted from propbetedge-workers workers/propsports-markets/src/leakage-guard.js.
//
// BOUNDARY, NOT RUNTIME (owner: PBE Algo V1 is ARMED + FROZEN): this module is
// deliberately NOT imported by the deployed Worker, so the armed bundle stays
// byte-identical. It is enforced at the feature-builder input boundary by
// src/leakage.test.mjs, which runs the real loadCard -> assembleBoutRow ->
// predictOne path and the real runCycle against a fake PostgREST. Wiring it into
// cycle.js at runtime is an owner-gated change to the armed Worker.
//
// Sportsbook h2h prices (ufc_market_run_quotes / ufc_market_observations) are a
// separate, post-model comparison (PBE Edge, market freshness, the reserved
// elite tier label). They are not model features either; the regression test
// proves the vector and probability do not depend on them.

export const MARKET_KEY_PATTERN = /(kalshi|polymarket|prediction_?market|clob|gamma|market|venue|consensus|yes_bid|yes_ask|no_bid|no_ask|best_bid|best_ask|\bbid\b|\bask\b|_bid|_ask|bid_|ask_|mid_?point|\bmid\b|mid_bp|_mid\b|comparable_mid|spread|last_?trade|last_price|order_?book|book_hash|depth|open_interest|liquidity|implied_prob|resolution_value|traded|volume|outcome_token|token_id|condition_id)/i;

// Tables whose rows are market data. A model input read may never touch them.
export const MARKET_TABLE_PATTERN = /^(market_|algo_market_|pred_venue_|kalshi|polymarket|ufc_market_)/i;

// Endpoints that serve venue data. A model input is never fetched from them.
export const MARKET_ENDPOINT_PATTERN = /(propsports-markets|kalshi|polymarket|clob\.|gamma-api)/i;

export class MarketLeakageError extends Error {
  constructor(path) { super(`market-derived field "${path}" cannot enter a PBE feature vector`); this.name = 'MarketLeakageError'; this.path = path; }
}

export function findMarketKeys(value, path = '$', seen = new Set()) {
  const hits = [];
  if (value instanceof Map) { for (const [k, v] of value) hits.push(...findMarketKeys(v, `${path}<${k}>`, seen)); return hits; }
  if (value instanceof Set) { [...value].forEach((v, i) => hits.push(...findMarketKeys(v, `${path}{${i}}`, seen))); return hits; }
  if (!value || typeof value !== 'object' || seen.has(value)) return hits;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findMarketKeys(v, `${path}[${i}]`, seen)));
  else {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (MARKET_KEY_PATTERN.test(k)) hits.push(p);
      hits.push(...findMarketKeys(v, p, seen));
    }
  }
  return hits;
}

/** Throws on the first venue-derived key anywhere in `features`; returns it unchanged otherwise. */
export function assertMarketFree(features) {
  const hits = findMarketKeys(features);
  if (hits.length) throw new MarketLeakageError(hits[0]);
  return features;
}

/** A PostgREST path ('table?select=...') a model input is read from. */
export function assertModelSourceTable(path) {
  const table = String(path).split('?')[0].replace(/^\/?rest\/v1\//, '');
  if (MARKET_TABLE_PATTERN.test(table)) throw new MarketLeakageError(`table ${table}`);
  const select = decodeURIComponent(String(path).split('?')[1] || '').match(/(?:^|&)select=([^&]*)/)?.[1] || '';
  if (/kalshi|polymarket|venue|best_bid|best_ask|token_id|clob/i.test(select)) throw new MarketLeakageError(`select ${table}.${select}`);
  return table;
}

/** A URL a model input is fetched from. */
export function assertModelSourceUrl(url) {
  if (MARKET_ENDPOINT_PATTERN.test(String(url))) throw new MarketLeakageError(`endpoint ${url}`);
  return url;
}

/**
 * The feature-builder input boundary: the exact arguments of assembleBoutRow
 * (fighters, snapsOf, rowsOf) and, optionally, the assembled named vector.
 */
export function assertModelInputsMarketFree({ fighters, snapsOf, rowsOf, featureVector } = {}) {
  assertMarketFree({ fighters, snapsOf, rowsOf });
  if (featureVector) assertMarketFree(featureVector);
  return true;
}
