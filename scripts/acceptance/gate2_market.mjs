// Gate 2: UFC 331 fight-week market capture and PBE Picks market truth. READ-ONLY.
//
//   node scripts/acceptance/gate2_market.mjs [--since 2026-09-17T12:00:00Z]
//
// REVISED 2026-09-15 by owner decision (docs/acceptance/UFC331_PRODUCTION_ACCEPTANCE.md,
// "Why Gate 2 changed"). The previous universal FRESH <= 60 min assertion
// contradicted the 12h / 6h / 1h capture cadence production deliberately runs.
// This gate now tests the corrected contract, imported from the one shared module
// both Workers use (scripts/odds/fight_week_cadence.mjs). It is not loosened and
// no earlier run is re-accepted under it.
//
// Every armed cycle's UFC 331 evaluations are checked against the contract and
// against the raw provider snapshot they claim to be built from:
//   T-7d current iff age <= 730 min; T-72h iff <= 370 min; T-24h iff <= 60 min
//   overdue snapshot -> STALE; stale -> no published PBE Edge
//   unavailable -> no odds, no edge
//   current -> consensus + best odds, de-vigged probability and PBE Edge, each
//             recomputed independently from ufc_market_run_quotes
//   age is measured from observed_at (the newest snapshot at or before the cycle
//   clock), never from a book's source_last_update, so a capture that finds an
//   unchanged price still refreshes the market
// Rows evaluated before the corrected contract shipped (no freshness_band field)
// are checked under the rule they were produced with and never counted as
// passing the new one.

import { get, inChunks, print, UFC331 } from './lib.mjs';
import { marketFreshness } from '../odds/fight_week_cadence.mjs';
import { impliedFromAmerican } from '../model/market_baseline.mjs';

const i = process.argv.indexOf('--since');
const since = i > 0 ? process.argv[i + 1] : '2026-09-17T12:00:00Z';
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };
const ms = (iso) => Date.parse(iso);

const captureRuns = (await get(`ufc_market_runs?select=id,started_at,status,capture_mode,last_cost,quota_remaining,notes&started_at=gte.${since}&order=started_at.asc&limit=500`))
  .filter((r) => r.notes?.lane === 'prefight')
  .map((r) => ({ id: r.id, started_at: r.started_at, status: r.status, band: r.notes?.band, lock_deadline: r.notes?.lock_deadline, cost: r.last_cost, quota_remaining: r.quota_remaining }));

const bouts = await get(`ufc_bouts?select=id,fighter_a_id,fighter_b_id,status&event_id=eq.${UFC331.event_id}&model_scope=eq.true`);
/* Quotes from a day before the window, so the snapshot a cycle at `since` read is present. */
const quoteFloor = new Date(ms(since) - 24 * 3_600_000).toISOString();
const quotes = await inChunks('ufc_market_run_quotes', 'bout_id', bouts.map((b) => b.id), 'bout_id,run_id,bookmaker_key,bookmaker_name,outcome_fighter_id,price,source_last_update,observed_at', `&market_key=eq.h2h&observed_at=gte.${quoteFloor}`);
const quotesByBout = new Map();
for (const q of quotes) { if (!quotesByBout.has(q.bout_id)) quotesByBout.set(q.bout_id, []); quotesByBout.get(q.bout_id).push(q); }

const snapshots = {};
for (const q of quotes.filter((x) => ms(x.observed_at) >= ms(since))) {
  const k = q.observed_at;
  snapshots[k] ||= { observed_at: k, bouts: new Set(), books: new Set() };
  snapshots[k].bouts.add(q.bout_id); snapshots[k].books.add(q.bookmaker_key);
}
const snapshotList = Object.values(snapshots).sort((a, b) => a.observed_at.localeCompare(b.observed_at)).map((s) => ({ observed_at: s.observed_at, bouts: s.bouts.size, books: s.books.size }));

/* Re-checks that found an unchanged sportsbook price: same book and price in consecutive snapshots. */
let unchangedRechecks = 0;
for (const rows of quotesByBout.values()) {
  const times = [...new Set(rows.map((r) => r.observed_at))].sort();
  for (let k = 1; k < times.length; k++) {
    const prev = new Map(rows.filter((r) => r.observed_at === times[k - 1]).map((r) => [`${r.bookmaker_key}|${r.outcome_fighter_id}`, r]));
    for (const r of rows.filter((x) => x.observed_at === times[k])) {
      const p = prev.get(`${r.bookmaker_key}|${r.outcome_fighter_id}`);
      if (p && p.price === r.price) unchangedRechecks++;
    }
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const toAmerican = (p) => (p > 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100));
/** Independent recomputation from the raw snapshot rows (not the Worker's module). */
function recompute(boutId, observedAt, pickId, oppId) {
  const rows = (quotesByBout.get(boutId) || []).filter((r) => ms(r.observed_at) === ms(observedAt));
  const side = (id) => rows.filter((r) => r.outcome_fighter_id === id);
  const P = side(pickId), O = side(oppId);
  if (!P.length || !O.length) return null;
  const ip = median(P.map((r) => impliedFromAmerican(r.price))), io = median(O.map((r) => impliedFromAmerican(r.price)));
  const best = (xs) => [...xs].sort((a, b) => impliedFromAmerican(a.price) - impliedFromAmerican(b.price) || a.bookmaker_key.localeCompare(b.bookmaker_key))[0];
  return { books: P.length, raw: ip, devig: ip / (ip + io), pickCons: toAmerican(ip), oppCons: toAmerican(io), pickBest: best(P), oppBest: best(O) };
}

const runs = await get(`ufc_model_runs?select=id,started_at,finished_at,status,mode,worker_version&mode=eq.armed&started_at=gte.${since}&order=started_at.asc&limit=500`);
const perRun = [];
const receipts = {};
for (const run of runs) {
  const evals = await get(`ufc_model_bout_evaluations?select=bout_id,decision,elite_candidate,pick_fighter_id,pick_probability,evaluated_at,market&run_id=eq.${run.id}&event_id=eq.${UFC331.event_id}`);
  const statuses = {};
  const contracts = new Set();
  for (const e of evals) {
    const m = e.market;
    const st = m?.status || (e.decision === 'ELIGIBLE' ? 'UNAVAILABLE' : 'n/a (no call)');
    statuses[st] = (statuses[st] || 0) + 1;
    if (!m) continue;
    const tag = `run ${run.id} bout ${e.bout_id}`;
    const fightWeek = Object.prototype.hasOwnProperty.call(m, 'freshness_band');
    contracts.add(fightWeek ? 'fight-week' : 'legacy-60');

    if (m.status === 'UNAVAILABLE') {
      check(m.pbe_delta_pts == null && m.pick_consensus_odds == null && m.pick_best_odds == null, `${tag}: UNAVAILABLE carries odds or an edge`);
      continue;
    }
    /* The cycle clock this comparison was made at. */
    const clock = ms(m.observed_at) + Number(m.age_minutes) * 60_000;
    check(ms(m.observed_at) <= ms(run.started_at) + 60_000, `${tag}: snapshot observed after the cycle clock`);
    if (m.source === 'snapshot') {
      const newest = (quotesByBout.get(e.bout_id) || []).map((r) => r.observed_at).filter((t) => ms(t) <= clock + 3_000).sort((a, b) => ms(a) - ms(b)).pop();
      check(newest && ms(newest) === ms(m.observed_at), `${tag}: age not measured from the newest snapshot observed_at (${m.observed_at} vs ${newest})`);
    }

    if (!fightWeek) {
      /* Produced under the old rule: checked under it, never accepted under the new one. */
      check(m.status !== 'FRESH' || m.age_minutes <= 60, `${tag}: legacy FRESH with age ${m.age_minutes}`);
      check(m.status === 'FRESH' || m.pbe_delta_pts == null, `${tag}: legacy stale row carries pbe_delta_pts`);
      continue;
    }

    /* age_minutes is stored to 0.1 min, so the clock is known to +-3 s: a verdict
     * that flips inside that interval (band boundary or exact limit) is not judged. */
    const f = marketFreshness(UFC331.event_date, m.observed_at, clock);
    const [lo, hi] = [marketFreshness(UFC331.event_date, m.observed_at, clock - 6_000), marketFreshness(UFC331.event_date, m.observed_at, clock + 6_000)];
    const ambiguous = lo.band !== hi.band || lo.current !== hi.current;
    check(ambiguous || (m.freshness_band === f.band && m.fresh_limit_minutes === f.limit_minutes), `${tag}: band/limit ${m.freshness_band}/${m.fresh_limit_minutes} != contract ${f.band}/${f.limit_minutes}`);
    check(ambiguous || (m.status === 'FRESH') === f.current, `${tag}: status ${m.status} at age ${m.age_minutes} in ${f.band} (limit ${f.limit_minutes})`);

    const r = recompute(e.bout_id, m.observed_at, e.pick_fighter_id, m.opponent_fighter_id);
    if (!check(r, `${tag}: no raw snapshot rows for the stated observed_at`)) continue;
    check(r.books === m.books, `${tag}: books ${m.books} != snapshot ${r.books}`);
    check(Math.abs(r.raw - m.raw_implied_pick) < 6e-5 && Math.abs(r.devig - m.devigged_pick) < 6e-5, `${tag}: implied/de-vig mismatch`);
    check(Math.abs(m.devigged_pick + m.devigged_opponent - 1) < 2e-4, `${tag}: de-vigged sides do not sum to 1`);
    check(r.pickCons === m.pick_consensus_odds && r.oppCons === m.opponent_consensus_odds, `${tag}: consensus odds ${m.pick_consensus_odds}/${m.opponent_consensus_odds} != ${r.pickCons}/${r.oppCons}`);
    check(r.pickBest.price === m.pick_best_odds && r.oppBest.price === m.opponent_best_odds, `${tag}: best odds mismatch`);
    check([r.pickBest.bookmaker_name, r.pickBest.bookmaker_key].includes(m.pick_best_book), `${tag}: best book mismatch`);
    const edge = Math.round((Number(e.pick_probability) - r.devig) * 10000) / 100;
    const rawEdge = Math.round((Number(e.pick_probability) - r.raw) * 10000) / 100;
    if (m.status === 'FRESH') {
      check(m.pbe_delta_pts != null && Math.abs(m.pbe_delta_pts - edge) < 0.011, `${tag}: PBE Edge ${m.pbe_delta_pts} != recomputed ${edge}`);
      check(Math.abs(edge - rawEdge) < 0.011 || Math.abs(m.pbe_delta_pts - rawEdge) >= 0.011, `${tag}: edge matches raw implied, not de-vigged`);
      check(m.pick_consensus_odds != null && m.pick_best_odds != null && m.devigged_pick != null && m.current_until != null, `${tag}: current market missing odds/probability/current_until`);
      if (!receipts[e.bout_id] || receipts[e.bout_id].run_started < run.started_at) {
        receipts[e.bout_id] = { run_started: run.started_at, band: m.freshness_band, age_minutes: m.age_minutes, books: m.books, pick_probability: Number(e.pick_probability), raw_implied: m.raw_implied_pick, devigged: m.devigged_pick, consensus: [m.pick_consensus_odds, m.opponent_consensus_odds], best: [`${m.pick_best_odds} ${m.pick_best_book}`, `${m.opponent_best_odds} ${m.opponent_best_book}`], pbe_edge: m.pbe_delta_pts, recomputed_edge: edge };
      }
    } else {
      check(m.pbe_delta_pts == null, `${tag}: STALE market publishes pbe_delta_pts`);
      check(m.current_until == null, `${tag}: STALE market carries current_until`);
    }
    if (e.elite_candidate) check(m.status === 'FRESH' && Math.abs(m.pbe_delta_pts) <= 15, `${tag}: elite without a current market within 15 pts`);
  }
  const ages = evals.filter((e) => e.market?.age_minutes != null).map((e) => e.market.age_minutes);
  perRun.push({ run_id: run.id, started_at: run.started_at, status: run.status, worker: run.worker_version, contract: [...contracts].join('+') || 'none', market_status: statuses, min_age_minutes: ages.length ? Math.min(...ages) : null, elite: evals.filter((e) => e.elite_candidate).length });
}

const transitions = [];
for (let k = 1; k < perRun.length; k++) {
  const prev = (perRun[k - 1].market_status.FRESH || 0) > 0, now = (perRun[k].market_status.FRESH || 0) > 0;
  if (prev !== now) transitions.push({ at: perRun[k].started_at, from: prev ? 'CURRENT' : 'STALE/UNAVAILABLE', to: now ? 'CURRENT' : 'STALE/UNAVAILABLE' });
}

const preds = await get(`ufc_model_predictions?select=id,bout_id,locked_at,generated_at,market_implied_prob_pick,market_books,model_edge_pts,market_snapshot_at,sample_context&event_id=eq.${UFC331.event_id}`);
for (const p of preds) {
  const m = p.sample_context?.market || null;
  const official = [p.market_implied_prob_pick, p.market_books, p.model_edge_pts, p.market_snapshot_at].some((v) => v != null);
  if (m?.status === 'FRESH') check(official && ms(p.market_snapshot_at) <= ms(p.generated_at) + 1000 && Number(p.model_edge_pts) === m.pbe_delta_pts, `prediction ${p.id}: current market without consistent official columns`);
  else check(!official && (m == null || m.pbe_delta_pts == null), `prediction ${p.id}: official market columns or edge without a current market`);
  if (p.locked_at && p.market_snapshot_at) check(ms(p.market_snapshot_at) <= ms(p.locked_at), `prediction ${p.id}: market snapshot after lock`);
}

print({
  GATE_2_MARKET: failures.length ? 'FAIL' : 'PASS',
  contract: 'fight-week v1 (owner decision 2026-09-15): T-7d <= 730m, T-72h <= 370m, T-24h <= 60m (scripts/odds/fight_week_cadence.mjs)',
  since,
  prefight_capture_runs: captureRuns,
  ufc331_snapshots: snapshotList,
  unchanged_price_rechecks: unchangedRechecks,
  armed_runs: perRun,
  stale_current_transitions: transitions,
  current_market_receipts: receipts,
  predictions: { total: preds.length, locked: preds.filter((p) => p.locked_at).length, with_official_market: preds.filter((p) => p.market_snapshot_at).length },
  post_lock_guard: 'ufc_model_predictions_write_gate (migration 011) refuses any change to a locked row; the cycle reads quotes/observations with observed_at <= its own clock (workers/ufc-algo/src/cycle.js loadCard)',
  elite_total: perRun.reduce((a, r) => a + r.elite, 0),
  failures,
});
