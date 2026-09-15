// Gate 2: UFC 331 hourly market capture. READ-ONLY.
//
//   node scripts/acceptance/gate2_market.mjs [--since 2026-09-17T12:00:00Z]
//
// Receipts: pre-fight capture runs, UFC 331 snapshot times and book counts, the
// market status every armed cycle recorded for UFC 331 (stale -> fresh), the
// official market columns on predictions (FRESH only), locks vs later snapshots,
// and elite designations. Freshness rule (frozen): FRESH <= 60 minutes, only
// observations at or before the cycle clock count.

import { get, inChunks, print, UFC331 } from './lib.mjs';

const i = process.argv.indexOf('--since');
const since = i > 0 ? process.argv[i + 1] : '2026-09-17T12:00:00Z';
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const captureRuns = (await get(`ufc_market_runs?select=id,started_at,status,capture_mode,last_cost,quota_remaining,notes&started_at=gte.${since}&order=started_at.asc&limit=500`))
  .filter((r) => r.notes?.lane === 'prefight')
  .map((r) => ({ id: r.id, started_at: r.started_at, status: r.status, band: r.notes?.band, lock_deadline: r.notes?.lock_deadline, cost: r.last_cost, quota_remaining: r.quota_remaining }));

const bouts = await get(`ufc_bouts?select=id,fighter_a_id,fighter_b_id,status&event_id=eq.${UFC331.event_id}&model_scope=eq.true`);
const quotes = await inChunks('ufc_market_run_quotes', 'bout_id', bouts.map((b) => b.id), 'bout_id,run_id,bookmaker_key,observed_at', `&market_key=eq.h2h&observed_at=gte.${since}`);
const snapshots = {};
for (const q of quotes) {
  const k = q.observed_at;
  snapshots[k] ||= { observed_at: k, bouts: new Set(), books: new Set() };
  snapshots[k].bouts.add(q.bout_id); snapshots[k].books.add(q.bookmaker_key);
}
const snapshotList = Object.values(snapshots).sort((a, b) => a.observed_at.localeCompare(b.observed_at)).map((s) => ({ observed_at: s.observed_at, bouts: s.bouts.size, books: s.books.size }));

const runs = await get(`ufc_model_runs?select=id,started_at,finished_at,status,mode,worker_version&mode=eq.armed&started_at=gte.${since}&order=started_at.asc&limit=500`);
const perRun = [];
for (const run of runs) {
  const evals = await get(`ufc_model_bout_evaluations?select=bout_id,decision,elite_candidate,market&run_id=eq.${run.id}&event_id=eq.${UFC331.event_id}`);
  const statuses = {};
  for (const e of evals) {
    const st = e.market?.status || (e.decision === 'ELIGIBLE' ? 'UNAVAILABLE' : 'n/a (no call)');
    statuses[st] = (statuses[st] || 0) + 1;
    if (e.market?.status === 'FRESH') {
      check(e.market.age_minutes <= 60, `run ${run.id} bout ${e.bout_id}: FRESH with age ${e.market.age_minutes}`);
      check(Date.parse(e.market.observed_at) <= Date.parse(run.started_at), `run ${run.id} bout ${e.bout_id}: FRESH snapshot observed after the cycle clock`);
    } else if (e.market) {
      check(e.market.pbe_delta_pts == null, `run ${run.id} bout ${e.bout_id}: non-FRESH market carries pbe_delta_pts`);
    }
    if (e.elite_candidate) check(e.market?.status === 'FRESH' && Math.abs(e.market.pbe_delta_pts) <= 15, `run ${run.id} bout ${e.bout_id}: elite without FRESH market within 15 pts`);
  }
  const ages = evals.filter((e) => e.market?.age_minutes != null).map((e) => e.market.age_minutes);
  perRun.push({ run_id: run.id, started_at: run.started_at, status: run.status, market_status: statuses, min_age_minutes: ages.length ? Math.min(...ages) : null, elite: evals.filter((e) => e.elite_candidate).length });
}

const transitions = [];
for (let k = 1; k < perRun.length; k++) {
  const prevFresh = (perRun[k - 1].market_status.FRESH || 0) > 0, nowFresh = (perRun[k].market_status.FRESH || 0) > 0;
  if (prevFresh !== nowFresh) transitions.push({ at: perRun[k].started_at, from: prevFresh ? 'FRESH' : 'STALE/UNAVAILABLE', to: nowFresh ? 'FRESH' : 'STALE/UNAVAILABLE' });
}

const preds = await get(`ufc_model_predictions?select=id,bout_id,locked_at,generated_at,market_implied_prob_pick,market_books,model_edge_pts,market_snapshot_at,sample_context&event_id=eq.${UFC331.event_id}`);
for (const p of preds) {
  const m = p.sample_context?.market || null;
  const official = [p.market_implied_prob_pick, p.market_books, p.model_edge_pts, p.market_snapshot_at].some((v) => v != null);
  if (m?.status === 'FRESH') check(official && Date.parse(p.market_snapshot_at) <= Date.parse(p.generated_at) + 1000, `prediction ${p.id}: FRESH without consistent official columns`);
  else check(!official && (m == null || m.pbe_delta_pts == null), `prediction ${p.id}: official market columns or delta without FRESH`);
  if (p.locked_at && p.market_snapshot_at) check(Date.parse(p.market_snapshot_at) <= Date.parse(p.locked_at), `prediction ${p.id}: market snapshot after lock`);
}

print({
  GATE_2_MARKET: failures.length ? 'FAIL' : 'PASS',
  since,
  prefight_capture_runs: captureRuns,
  ufc331_snapshots: snapshotList,
  armed_runs: perRun,
  stale_fresh_transitions: transitions,
  predictions: { total: preds.length, locked: preds.filter((p) => p.locked_at).length, with_official_market: preds.filter((p) => p.market_snapshot_at).length },
  post_lock_guard: 'ufc_model_predictions_write_gate (migration 011) refuses any change to a locked row; the cycle reads quotes/observations with observed_at <= its own clock (workers/ufc-algo/src/cycle.js loadCard)',
  elite_total: perRun.reduce((a, r) => a + r.elite, 0),
  failures,
});
