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
//   FRESH           snapshot age <= 60 minutes at `nowIso`: the PBE delta is the
//                   official comparison.
//   STALE           older: the age is shown, the delta is NOT published as
//                   current, no market-edge language, no elite/market-aware tier.
//   UNAVAILABLE     no usable two-sided price.
//
// A stale market never blocks a model call; model eligibility does not read it.

import { consensusForBout } from '../../../scripts/model/market_baseline.mjs';

export const MARKET_FRESH_MINUTES = 60;

const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

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

export function marketComparison({ snapshots, observations, pickFighterId, pickProbability, nowIso, freshMinutes = MARKET_FRESH_MINUTES }) {
  if (!pickFighterId || pickProbability == null) return null;
  const { source, rows } = comparisonRows({ snapshots, observations, nowIso });
  const sides = rows.length ? consensusForBout(rows, nowIso) : null;
  const m = sides ? sides.find((s) => s.fighter_id === pickFighterId) : null;
  if (!m) return { status: 'UNAVAILABLE', source, fresh_limit_minutes: freshMinutes };

  /* Age of the comparison = age of its NEWEST contributing observation; the
   * oldest book update is kept so a book that has not repriced is visible. */
  const latestPerBook = new Map();
  for (const r of rows) {
    const k = `${r.bookmaker_key}|${r.outcome_fighter_id}`;
    const p = latestPerBook.get(k);
    if (!p || (p.source_last_update || p.observed_at) <= (r.source_last_update || r.observed_at)) latestPerBook.set(k, r);
  }
  const used = [...latestPerBook.values()];
  const observedAt = used.map((r) => r.observed_at).sort().pop();
  const updates = used.map((r) => r.source_last_update || r.observed_at).sort();
  const ageMinutes = Math.max(0, (Date.parse(nowIso) - Date.parse(observedAt)) / 60000);
  const fresh = ageMinutes <= freshMinutes;
  const delta = round((pickProbability - m.devigged) * 100, 2);

  return {
    status: fresh ? 'FRESH' : 'STALE',
    source,
    fresh_limit_minutes: freshMinutes,
    age_minutes: round(ageMinutes, 1),
    observed_at: observedAt,
    oldest_book_update: updates[0],
    newest_book_update: updates[updates.length - 1],
    books: m.books,
    raw_implied_pick: round(m.implied, 4),
    devigged_pick: round(m.devigged, 4),
    /* Published only when fresh. A stale delta is kept for audit under a name
     * no surface renders as a current edge. */
    pbe_delta_pts: fresh ? delta : null,
    stale_delta_pts: fresh ? null : delta,
  };
}

/** The official comparison columns a draft may carry: only a FRESH market. */
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
