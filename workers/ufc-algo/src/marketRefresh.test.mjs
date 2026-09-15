// Market context refresh (A+). Run: node --test src/marketRefresh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshMarketContext } from './marketRefresh.js';
import { marketComparison } from './market.js';
import { marketFreshness } from '../../../scripts/odds/fight_week_cadence.mjs';

const EVENT = { id: 'ev331', event_date: '2026-09-19' };
const A = 'van', B = 'pantoja';
const OLD = '2026-09-15T13:06:08.935Z', NEW = '2026-09-15T18:57:09.217Z';
const quotes = (run, at, pa, pb, bout = 'bout-1') => [
  { bout_id: bout, run_id: run, bookmaker_key: 'dk', bookmaker_name: 'DraftKings', market_key: 'h2h', outcome_fighter_id: A, price: pa, source_last_update: at, observed_at: at },
  { bout_id: bout, run_id: run, bookmaker_key: 'dk', bookmaker_name: 'DraftKings', market_key: 'h2h', outcome_fighter_id: B, price: pb, source_last_update: at, observed_at: at },
  { bout_id: bout, run_id: run, bookmaker_key: 'fd', bookmaker_name: 'FanDuel', market_key: 'h2h', outcome_fighter_id: A, price: pa - 5, source_last_update: at, observed_at: at },
  { bout_id: bout, run_id: run, bookmaker_key: 'fd', bookmaker_name: 'FanDuel', market_key: 'h2h', outcome_fighter_id: B, price: pb + 5, source_last_update: at, observed_at: at },
];

/* A fake PostgREST: reads from fixtures, records every call. RPC applies migration 030's rules in memory. */
function fakeQ({ runs, allQuotes, predictions, versions = [{ model_version: 'pbe-fight-model-v1', status: 'live' }] }) {
  const calls = [];
  const q = {
    calls,
    async get(path) {
      calls.push({ m: 'GET', path });
      const [table, qs] = path.split('?');
      const p = new URLSearchParams(qs);
      if (table === 'ufc_market_runs') return runs.filter((r) => `eq.${r.id}` === p.get('id'));
      if (table === 'ufc_market_run_quotes') {
        let rows = allQuotes;
        if (p.get('run_id')) rows = rows.filter((r) => `eq.${r.run_id}` === p.get('run_id'));
        if (p.get('bout_id')) rows = rows.filter((r) => `eq.${r.bout_id}` === p.get('bout_id'));
        if (p.get('observed_at')) rows = rows.filter((r) => r.observed_at <= p.get('observed_at').slice(4));
        return rows;
      }
      if (table === 'ufc_model_versions') return versions.filter((v) => v.status === 'live');
      return [];
    },
    async inChunks(table, column, ids, select, extra) {
      calls.push({ m: 'GET', path: `${table}?${column}=in.(${ids})${extra || ''}` });
      if (table === 'ufc_model_predictions') return predictions.filter((r) => ids.includes(r.bout_id) && r.locked_at == null && extra.includes(`model_version=eq.${r.model_version}`));
      if (table === 'ufc_events') return [EVENT];
      return [];
    },
    async rpc(fn, args) {
      calls.push({ m: 'RPC', fn, args });
      assert.equal(fn, 'ufc_model_refresh_prediction_market');
      const row = predictions.find((r) => r.id === args.p_prediction_id);
      if (!row) return { refreshed: false, reason: 'not_found' };
      if (row.locked_at) return { refreshed: false, reason: 'locked' };
      if (row.generated_at !== args.p_expected_generated_at) return { refreshed: false, reason: 'regenerated' };
      const old = row.sample_context?.market?.observed_at;
      if (old && Date.parse(args.p_market.observed_at) <= Date.parse(old)) return { refreshed: false, reason: 'not_newer' };
      row.sample_context = { ...row.sample_context, market: args.p_market };
      return { refreshed: true };
    },
    async post() { throw new Error('refresh must never POST'); },
    async patch() { throw new Error('refresh must never PATCH'); },
    async del() { throw new Error('refresh must never DELETE'); },
  };
  return q;
}

const basePred = () => ({
  id: 'pred-1', bout_id: 'bout-1', event_id: EVENT.id, model_version: 'pbe-fight-model-v1', feature_version: 'pbe-fight-features-v1',
  pick_fighter_id: A, pick_probability: '0.64397765', prob_a: '0.64397765', prob_b: '0.35602235', generated_at: '2026-09-15T18:41:06.815+00:00', locked_at: null,
  feature_vector: { age_diff_years: 1.2 }, confidence_band: '60-65',
  market_implied_prob_pick: 0.5427, model_edge_pts: 10.12, market_snapshot_at: OLD, market_books: 6,
  sample_context: { confidence: 'MEDIUM', market: { status: 'FRESH', observed_at: OLD, current_until: '2026-09-15T19:16:08.935Z', pbe_delta_pts: 10.12 } },
});

test('a successful prefight snapshot refreshes the unlocked prediction within the same call, from the stored pick', async () => {
  const pred = basePred();
  const frozen = JSON.parse(JSON.stringify(pred));
  const q = fakeQ({ runs: [{ id: 10, status: 'success', notes: { lane: 'prefight' } }], allQuotes: [...quotes(9, OLD, -130, 110), ...quotes(10, NEW, -132, 110)], predictions: [pred] });
  const now = Date.parse('2026-09-15T18:57:12Z');
  const out = await refreshMarketContext(q, { runId: 10, observedAt: NEW, now });
  assert.equal(out.refused, null);
  assert.equal(out.refreshed, 1);
  const m = pred.sample_context.market;
  assert.equal(m.observed_at, NEW, 'the new snapshot');
  assert.equal(m.status, 'FRESH');
  assert.equal(m.freshness_band, 'T-72h');
  assert.equal(m.current_until, marketFreshness(EVENT.event_date, NEW, now).current_until);
  /* Identical to the canonical comparison from the stored pick and probability. */
  const canonical = marketComparison({ snapshots: quotes(10, NEW, -132, 110), observations: [], pickFighterId: A, pickProbability: 0.64397765, nowIso: new Date(now).toISOString(), eventDate: EVENT.event_date });
  assert.deepEqual(m, canonical);
  /* Nothing but sample_context.market moved. */
  for (const k of ['pick_fighter_id', 'pick_probability', 'prob_a', 'prob_b', 'generated_at', 'locked_at', 'feature_vector', 'model_version', 'feature_version', 'confidence_band', 'market_implied_prob_pick', 'model_edge_pts', 'market_snapshot_at', 'market_books']) {
    assert.deepEqual(pred[k], frozen[k], `${k} unchanged`);
  }
  assert.equal(pred.sample_context.confidence, 'MEDIUM');
  /* Writes: only the refresh RPC, carrying the expected regeneration and no probability of its own. */
  const writes = q.calls.filter((c) => c.m !== 'GET');
  assert.deepEqual(writes.map((c) => c.fn), ['ufc_model_refresh_prediction_market']);
  assert.equal(writes[0].args.p_expected_generated_at, frozen.generated_at);
  assert.deepEqual(Object.keys(writes[0].args).sort(), ['p_expected_generated_at', 'p_market', 'p_prediction_id']);
  assert.ok(!q.calls.some((c) => /ufc_model_bout_evaluations|ufc_model_runs/.test(c.path || '')), 'no evaluation or model-run read/write');
});

test('only a successful PREFIGHT run with matching observed_at is accepted', async () => {
  const mk = (runs, observedAt = NEW) => refreshMarketContext(fakeQ({ runs, allQuotes: quotes(10, NEW, -132, 110), predictions: [basePred()] }), { runId: 10, observedAt, now: Date.parse('2026-09-15T18:58:00Z') });
  assert.equal((await mk([{ id: 10, status: 'failed', notes: { lane: 'prefight' } }])).refused, 'run_not_successful_prefight');
  assert.equal((await mk([{ id: 10, status: 'success', notes: { lane: 'live' } }])).refused, 'run_not_successful_prefight');
  assert.equal((await mk([])).refused, 'run_not_found');
  assert.equal((await mk([{ id: 10, status: 'success', notes: { lane: 'prefight' } }], '2026-09-15T18:00:00Z')).refused, 'observed_at_mismatch');
  assert.equal((await refreshMarketContext(fakeQ({ runs: [], allQuotes: [], predictions: [] }), { runId: 'x' })).refused, 'run_id_required');
});

test('locked, regenerated and non-newer rows are refused; one failure never stops the rest', async () => {
  const p1 = { ...basePred(), id: 'p1', bout_id: 'b1' };
  const p2 = { ...basePred(), id: 'p2', bout_id: 'b2', generated_at: 'moved' };
  const p3 = { ...basePred(), id: 'p3', bout_id: 'b3' };
  const p4 = { ...basePred(), id: 'p4', bout_id: 'b4', sample_context: { market: { observed_at: '2026-09-15T19:30:00Z' } } };
  const q = fakeQ({ runs: [{ id: 10, status: 'success', notes: { lane: 'prefight' } }], allQuotes: ['b1', 'b2', 'b3', 'b4'].flatMap((b) => quotes(10, NEW, -132, 110, b)), predictions: [p1, p2, p3, p4] });
  const realRpc = q.rpc;
  q.rpc = async (fn, args) => {
    if (args.p_prediction_id === 'p2') { args.p_expected_generated_at = 'stale-read'; }
    if (args.p_prediction_id === 'p3') throw new Error('network');
    return realRpc(fn, args);
  };
  const out = await refreshMarketContext(q, { runId: 10, observedAt: NEW, now: Date.parse('2026-09-15T18:58:00Z') });
  assert.equal(out.refreshed, 1);
  assert.deepEqual(out.results, { refreshed: 1, regenerated: 1, not_newer: 1 });
  assert.equal(out.errors.length, 1);
  /* A locked prediction is not even read for refresh, and the RPC refuses it if it locks in between. */
  const locked = { ...basePred(), locked_at: '2026-09-18T16:41:30Z' };
  const q2 = fakeQ({ runs: [{ id: 10, status: 'success', notes: { lane: 'prefight' } }], allQuotes: quotes(10, NEW, -132, 110), predictions: [locked] });
  assert.equal((await refreshMarketContext(q2, { runId: 10, observedAt: NEW, now: Date.parse('2026-09-18T16:30:00Z') })).predictions, 0);
  assert.deepEqual(await q2.rpc('ufc_model_refresh_prediction_market', { p_prediction_id: locked.id, p_expected_generated_at: locked.generated_at, p_market: { observed_at: NEW } }), { refreshed: false, reason: 'locked' });
});

test('final 24h: a :25 capture refreshed at once removes the recurring :25-to-:41 stale gap (seconds remain, not minutes)', async () => {
  /* Captures at :25 each hour through the final day (a few seconds of cron/fetch jitter), refresh 5 s later; model cycle at :41. */
  const start = Date.parse('2026-09-18T00:00:00Z');
  const REFRESH_MS = 5e3;
  const captures = [], cycles = [];
  for (let h = 0; h < 16; h++) { captures.push(start + h * 3600e3 + 25 * 60e3 + ((h * 7) % 4) * 1e3); cycles.push(start + h * 3600e3 + 41 * 60e3); }
  const untilOf = (observedMs, atMs) => Date.parse(marketFreshness('2026-09-19', new Date(observedMs).toISOString(), atMs).current_until);
  const heldWithRefresh = (t) => { const c = captures.filter((x) => x + REFRESH_MS <= t).pop(); return c ? untilOf(c, c + REFRESH_MS) : null; };
  const heldCycleOnly = (t) => { const cy = cycles.filter((x) => x <= t).pop(); if (!cy) return null; const c = captures.filter((x) => x <= cy).pop(); return c ? untilOf(c, cy) : null; };
  const longestStale = (held) => {
    let longest = 0, run = 0;
    for (let t = captures[1]; t < cycles.at(-1); t += 1e3) { const u = held(t); if (u && t < u) { run = 0; } else { run += 1e3; longest = Math.max(longest, run); } }
    return longest;
  };
  const withRefresh = longestStale(heldWithRefresh), cycleOnly = longestStale(heldCycleOnly);
  /* The final-day window equals the capture interval (60 min, no tolerance), so the old snapshot expires as the next one lands:
   * what is left is the write + refresh latency plus capture jitter, never the wait for the :41 cycle. */
  assert.ok(withRefresh <= REFRESH_MS + 4e3, `longest stale stretch with the refresh: ${withRefresh / 1e3}s`);
  assert.ok(cycleOnly >= 15 * 60e3, `longest stale stretch with the hourly read only: ${cycleOnly / 60e3} min`);
  /* And the refresh itself produces that market: a :25 snapshot in the final band is current for 60 minutes. */
  const pred = basePred();
  const at = '2026-09-18T10:25:03.000Z';
  const q = fakeQ({ runs: [{ id: 50, status: 'success', notes: { lane: 'prefight' } }], allQuotes: quotes(50, at, -132, 110), predictions: [pred] });
  await refreshMarketContext(q, { runId: 50, observedAt: at, now: Date.parse('2026-09-18T10:25:06Z') });
  assert.equal(pred.sample_context.market.freshness_band, 'T-24h');
  assert.equal(pred.sample_context.market.current_until, '2026-09-18T11:25:03.000Z');
});
