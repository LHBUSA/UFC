// PBE-vs-market comparison at evaluation / lock time. PURE.
//
// The market is never a model input. This decides only what the official
// comparison may say about it.
//
//   Source          the newest complete provider snapshot (ufc_market_run_quotes,
//                   one shared observed_at per fetch) at or before `nowIso`;
//                   change history (ufc_market_observations) only when no
//                   snapshot exists. Nothing observed after `nowIso` is read, and
//                   the lock pass runs with `nowIso` before the database stamps
//                   locked_at, so no post-lock price can reach a locked row.
//   FRESH           the snapshot is CURRENT under the fight-week contract
//                   (scripts/odds/fight_week_cadence.mjs, shared with the capture
//                   lane): age <= 730 min at T-7d, <= 370 min at T-72h, <= 60 min
//                   in the final 24h before the lock deadline, where both lock
//                   passes run. The PBE delta is the official comparison.
//                   (Status value kept as 'FRESH' so eligibility, stored rows and
//                   the lock gates read it unchanged; the product label is CURRENT.)
//   STALE           older than its band allows: the last observed odds and age
//                   are shown, the delta is NOT published as current, no
//                   market-edge language, no elite/market-aware tier.
//   UNAVAILABLE     no usable two-sided price.
//
// Owner decision 2026-09-15: the previous universal 60-minute rule contradicted
// the 12h / 6h / 1h capture cadence we deliberately operate, so every pre-final-
// day cycle read a scheduled snapshot as STALE. The final-24h rule is unchanged.
//
// PRICES (presentation). Only from the newest complete snapshot, never a book
// carried forward from an older run, never guessed:
//   consensus odds  median implied probability across that snapshot's books,
//                   converted back to American (web/lib/market.ts definition;
//                   raw American numbers are never averaged). Vig included: a
//                   price a customer could take.
//   best odds       the price most favourable to the bettor in that snapshot
//                   (lowest implied probability), with its bookmaker.
// PBE EDGE is unchanged and never computed from vigged prices:
//   pbe_delta_pts = (model pick probability - de-vigged consensus probability) x 100
//
// A stale market never blocks a model call; model eligibility does not read it.

import { consensusForBout, impliedFromAmerican } from '../../../scripts/model/market_baseline.mjs';
import { marketFreshness } from '../../../scripts/odds/fight_week_cadence.mjs';

/** The final-24h (lock-time) limit; earlier bands are wider, see fight_week_cadence.mjs. */
export const MARKET_FRESH_MINUTES = 60;

const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** Implied probability to American odds; an exactly even market is +100 (web/lib/market.ts). */
export function americanFromImplied(p) {
  if (!(p > 0 && p < 1)) return null;
  return p > 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

/** The rows the comparison is built from: newest snapshot at or before now, else change history. */
export function comparisonRows({ snapshots = [], observations = [], nowIso }) {
  const snap = snapshots.filter((r) => r.market_key === 'h2h' && r.observed_at && r.observed_at <= nowIso);
  if (snap.length) {
    const newest = snap.map((r) => r.observed_at).sort().pop();
    return { source: 'snapshot', rows: snap.filter((r) => r.observed_at === newest) };
  }
  const obs = observations.filter((r) => r.market_key === 'h2h' && r.observed_at && r.observed_at <= nowIso);
  return { source: obs.length ? 'change_history' : 'none', rows: obs };
}

/** Consensus and best price for one fighter from ONE snapshot's rows. */
export function sidePrices(rows, fighterId, side) {
  const mine = rows.filter((r) => r.outcome_fighter_id === fighterId && r.price != null);
  if (!mine.length || !side) return null;
  const best = [...mine].sort((x, y) => impliedFromAmerican(x.price) - impliedFromAmerican(y.price) || String(x.bookmaker_key).localeCompare(String(y.bookmaker_key)))[0];
  return {
    fighter_id: fighterId,
    consensus_odds: americanFromImplied(side.implied),
    best_odds: best.price,
    best_book: best.bookmaker_name || best.bookmaker_key,
    best_book_key: best.bookmaker_key,
    books: side.books,
  };
}

export function marketComparison({ snapshots, observations, pickFighterId, pickProbability, nowIso, eventDate }) {
  if (!pickFighterId || pickProbability == null) return null;
  const { source, rows } = comparisonRows({ snapshots, observations, nowIso });
  const sides = rows.length ? consensusForBout(rows, nowIso) : null;
  const m = sides ? sides.find((s) => s.fighter_id === pickFighterId) : null;
  const now = Date.parse(nowIso);
  if (!m) {
    const f = marketFreshness(eventDate, null, now);
    return { status: 'UNAVAILABLE', source, fresh_limit_minutes: f.limit_minutes, freshness_band: f.band };
  }
  const o = sides.find((s) => s.fighter_id !== pickFighterId);

  /* Age of the comparison = age of its NEWEST contributing observation (when we
   * re-checked the market); the oldest/newest book updates are provenance only. */
  const latestPerBook = new Map();
  for (const r of rows) {
    const k = `${r.bookmaker_key}|${r.outcome_fighter_id}`;
    const p = latestPerBook.get(k);
    if (!p || (p.source_last_update || p.observed_at) <= (r.source_last_update || r.observed_at)) latestPerBook.set(k, r);
  }
  const used = [...latestPerBook.values()];
  const observedAt = used.map((r) => r.observed_at).sort().pop();
  const updates = used.map((r) => r.source_last_update || r.observed_at).sort();
  const f = marketFreshness(eventDate, observedAt, now);
  const fresh = f.current;
  const delta = round((pickProbability - m.devigged) * 100, 2);

  /* Odds only from a single complete snapshot: change history mixes fetches. */
  const pick = source === 'snapshot' ? sidePrices(rows, pickFighterId, m) : null;
  const opp = source === 'snapshot' && o ? sidePrices(rows, o.fighter_id, o) : null;

  return {
    status: fresh ? 'FRESH' : 'STALE',
    source,
    freshness_band: f.band,
    fresh_limit_minutes: f.limit_minutes,
    age_minutes: round(f.age_minutes, 1),
    current_until: f.current_until,
    observed_at: observedAt,
    oldest_book_update: updates[0],
    newest_book_update: updates[updates.length - 1],
    books: m.books,
    raw_implied_pick: round(m.implied, 4),
    devigged_pick: round(m.devigged, 4),
    opponent_fighter_id: o?.fighter_id ?? null,
    raw_implied_opponent: o ? round(o.implied, 4) : null,
    devigged_opponent: o ? round(o.devigged, 4) : null,
    pick_consensus_odds: pick?.consensus_odds ?? null,
    pick_best_odds: pick?.best_odds ?? null,
    pick_best_book: pick?.best_book ?? null,
    opponent_consensus_odds: opp?.consensus_odds ?? null,
    opponent_best_odds: opp?.best_odds ?? null,
    opponent_best_book: opp?.best_book ?? null,
    /* Published only when current. A stale delta is kept for audit under a name
     * no surface renders as a current edge. */
    pbe_delta_pts: fresh ? delta : null,
    stale_delta_pts: fresh ? null : delta,
  };
}

/** The official comparison columns a draft may carry: only a FRESH (current) market. */
export function officialMarketColumns(market) {
  if (market?.status !== 'FRESH') {
    return { market_implied_prob_pick: null, market_books: null, model_edge_pts: null, market_snapshot_at: null };
  }
  return {
    market_implied_prob_pick: market.devigged_pick,
    market_books: market.books,
    model_edge_pts: market.pbe_delta_pts,
    market_snapshot_at: market.observed_at,
  };
}
