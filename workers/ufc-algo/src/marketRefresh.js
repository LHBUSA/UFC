// PBE Picks market context refresh (owner decision 2026-09-15, "A+").
//
// Called by ufc-live-odds (service binding, RPC entrypoint MarketRefresh in
// index.js) right after a successful PRE-FIGHT snapshot, so the PBE Picks card
// reflects the new snapshot within seconds instead of at the next :41 cycle.
//
// Presentation only. For each UNLOCKED live-champion prediction on a bout the
// snapshot priced, it recomputes the market object with the canonical
// marketComparison() from the prediction's STORED pick_fighter_id and
// pick_probability, and writes it with ufc_model_refresh_prediction_market()
// (migration 030), which replaces only sample_context.market under the row
// lock, at the expected regeneration, forward in time only, never on a locked
// row. It never:
//   - scores the model or runs evaluateBout();
//   - inserts an evaluation row (regeneration-drift history is untouched);
//   - touches the official comparison columns, which stay owned by the hourly
//     cycle and the lock pass (the lock pass reads the newest snapshot itself);
//   - accepts a probability or edge from the caller: the caller sends only the
//     market run id and observed_at it wrote.

import { marketComparison } from './market.js';

const tally = (o, k) => { o[k] = (o[k] || 0) + 1; };

export async function refreshMarketContext(q, { runId, observedAt, now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const report = { run_id: runId ?? null, observed_at: observedAt ?? null, started_at: nowIso, bouts: 0, predictions: 0, refreshed: 0, results: {}, refused: null, errors: [] };
  const refuse = (reason) => ({ ...report, refused: reason, finished_at: new Date().toISOString() });

  if (!Number.isFinite(Number(runId))) return refuse('run_id_required');
  const [run] = await q.get(`ufc_market_runs?select=id,status,notes&id=eq.${Number(runId)}`);
  if (!run) return refuse('run_not_found');
  if (run.status !== 'success' || run.notes?.lane !== 'prefight') return refuse('run_not_successful_prefight');

  const quotes = await q.get(`ufc_market_run_quotes?select=bout_id,observed_at&run_id=eq.${Number(runId)}&market_key=eq.h2h&limit=5000`);
  if (!quotes.length) return refuse('run_has_no_quotes');
  const snapObservedAt = quotes.map((r) => r.observed_at).sort().pop();
  if (observedAt && Date.parse(observedAt) !== Date.parse(snapObservedAt)) return refuse('observed_at_mismatch');
  if (Date.parse(snapObservedAt) > now + 5_000) return refuse('snapshot_in_future');
  report.observed_at = snapObservedAt;

  const live = await q.get('ufc_model_versions?select=model_version&status=eq.live');
  if (live.length !== 1) return refuse('no_single_live_champion');
  const champion = live[0].model_version;

  const boutIds = [...new Set(quotes.map((r) => r.bout_id))];
  report.bouts = boutIds.length;
  const preds = await q.inChunks('ufc_model_predictions', 'bout_id', boutIds,
    'id,bout_id,event_id,pick_fighter_id,pick_probability,generated_at,model_version,locked_at',
    `&locked_at=is.null&model_version=eq.${encodeURIComponent(champion)}`);
  report.predictions = preds.length;
  if (!preds.length) return { ...report, finished_at: new Date().toISOString() };

  const events = new Map((await q.inChunks('ufc_events', 'id', preds.map((p) => p.event_id), 'id,event_date')).map((e) => [e.id, e.event_date]));

  for (const p of preds) {
    try {
      /* The same read the cycle makes: this bout's quotes up to now; the comparison takes the newest complete snapshot. */
      const snapshots = await q.get(`ufc_market_run_quotes?select=bout_id,run_id,bookmaker_key,bookmaker_name,market_key,outcome_fighter_id,price,source_last_update,observed_at&bout_id=eq.${p.bout_id}&market_key=eq.h2h&observed_at=lte.${encodeURIComponent(nowIso)}&order=observed_at.desc&limit=60`);
      const market = marketComparison({
        snapshots, observations: [], pickFighterId: p.pick_fighter_id, pickProbability: Number(p.pick_probability), nowIso, eventDate: events.get(p.event_id) ?? null,
      });
      if (!market || market.status === 'UNAVAILABLE') { tally(report.results, 'unavailable'); continue; }
      if (Date.parse(market.observed_at) < Date.parse(snapObservedAt)) { tally(report.results, 'older_than_notified_snapshot'); continue; }
      const res = await q.rpc('ufc_model_refresh_prediction_market', { p_prediction_id: p.id, p_expected_generated_at: p.generated_at, p_market: market });
      const out = Array.isArray(res) ? res[0] : res;
      if (out?.refreshed) { report.refreshed += 1; tally(report.results, 'refreshed'); } else tally(report.results, out?.reason || 'refused');
    } catch (e) {
      report.errors.push(`${p.id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return { ...report, finished_at: new Date().toISOString() };
}
