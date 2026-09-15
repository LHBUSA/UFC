// Gate 3: first real UFC 331 lock pass. READ-ONLY.
//
//   node scripts/acceptance/gate3_lock.mjs [--since 2026-09-18T15:30:00Z]
//
// Official lock invariants and the owner-approved SHADOW ISOLATION INVARIANT
// (docs/acceptance/UFC331_PRODUCTION_ACCEPTANCE.md). A nonzero shadow-lock count
// is reported separately and is NOT a failure. If an OFFICIAL invariant fails the
// operator procedure is: ALGO_MODE="dry_run" in workers/ufc-algo/wrangler.toml,
// commit + push main, `npx wrangler deploy` (dry_run rollback version d3a0c899).

import { get, count, inChunks, sha256, print, V1, UFC331, PUBLIC_SITE } from './lib.mjs';
import { FEATURE_KEYS } from '../model/feature_spec.mjs';

const i = process.argv.indexOf('--since');
const since = i > 0 ? process.argv[i + 1] : '2026-09-18T15:30:00Z';
const official = [], shadow = [];
const need = (list, ok, msg) => { if (!ok) list.push(msg); };

/* Champion */
const versions = await get('ufc_model_versions?select=*');
const v = versions.find((x) => x.model_version === V1.model_version);
const spec = v && sha256(JSON.stringify({ model_version: v.model_version, feature_version: v.feature_version, features: FEATURE_KEYS, coefficients: FEATURE_KEYS.map((k) => v.coefficients[k]), scale: FEATURE_KEYS.map((k) => v.feature_scale[k]), lambda: v.hyperparameters.lambda }));
const champion = { versions: versions.map((x) => `${x.model_version}:${x.status}`), spec_recomputed: spec, spec_stored: v?.spec_sha256, full_row_sha256: v && sha256(JSON.stringify(v)), artifact_sha256: v?.hyperparameters?.provenance?.artifact_sha256, manifest_sha256: v?.hyperparameters?.provenance?.manifest_sha256 };
need(official, versions.length === 1 && v?.status === 'live', 'champion set changed');
need(official, spec === V1.spec_sha256 && v.spec_sha256 === V1.spec_sha256, 'V1 spec hash');
need(official, champion.full_row_sha256 === V1.full_row_sha256, 'V1 registry row changed');
need(official, champion.artifact_sha256 === V1.artifact_sha256 && champion.manifest_sha256 === V1.manifest_sha256, 'V1 provenance hashes');

/* Runs and official predictions */
const runs = await get(`ufc_model_runs?select=id,started_at,finished_at,status,mode,worker_version,counts,error&mode=eq.armed&started_at=gte.${since}&order=started_at.asc`);
for (const r of runs) need(official, r.status === 'ok', `armed run ${r.id} status ${r.status} ${r.error || ''}`);
const preds = await get(`ufc_model_predictions?select=*&event_id=eq.${UFC331.event_id}`);
const locked = preds.filter((p) => p.locked_at);
const bouts = await get(`ufc_bouts?select=id,status,model_scope&event_id=eq.${UFC331.event_id}`);
const evals = runs.length ? await inChunks('ufc_model_bout_evaluations', 'run_id', runs.map((r) => r.id), 'run_id,bout_id,decision,reasons,pick_fighter_id,pick_probability,elite_candidate,market,evaluated_at', `&event_id=eq.${UFC331.event_id}`) : [];

need(official, new Set(locked.map((p) => p.bout_id)).size === locked.length, 'more than one locked row for a bout');
for (const p of locked) {
  need(official, p.model_version === V1.model_version && p.feature_version === V1.feature_version, `locked ${p.id} version ${p.model_version}/${p.feature_version}`);
  need(official, p.locked_at >= UFC331.lock_window_opens && Date.parse(p.locked_at) < Date.parse(UFC331.lock_window_closes), `locked ${p.id} at ${p.locked_at} outside the lock window`);
  /* The locking run: the last armed run that started at or before locked_at. */
  const lockRun = runs.filter((r) => Date.parse(r.started_at) <= Date.parse(p.locked_at)).pop();
  const e = lockRun && evals.find((x) => x.run_id === lockRun.id && x.bout_id === p.bout_id);
  need(official, e?.decision === 'ELIGIBLE', `locked ${p.id} bout ${p.bout_id} not ELIGIBLE in its locking run (${e?.decision})`);
  if (e) {
    need(official, e.pick_fighter_id === p.pick_fighter_id && Math.abs(Number(e.pick_probability) - Number(p.pick_probability)) < 1e-6, `locked ${p.id} pick/probability differs from its locking evaluation`);
  }
  const m = p.sample_context?.market;
  const cols = [p.market_implied_prob_pick, p.market_books, p.model_edge_pts, p.market_snapshot_at].some((x) => x != null);
  if (m?.status === 'FRESH') need(official, cols && Date.parse(p.market_snapshot_at) <= Date.parse(p.locked_at), `locked ${p.id} FRESH market columns inconsistent`);
  else need(official, !cols && (m == null || m.pbe_delta_pts == null), `locked ${p.id} non-FRESH market carries official columns/delta`);
}
const lastEval = new Map();
for (const e of evals) lastEval.set(e.bout_id, e);
for (const [boutId, e] of lastEval) {
  if (e.decision === 'NO_MODEL_CALL') need(official, !locked.some((p) => p.bout_id === boutId), `NO_MODEL_CALL bout ${boutId} has a locked call`);
  if (e.elite_candidate) need(official, e.market?.status === 'FRESH', `elite without FRESH market on ${boutId}`);
}
const eligibleAtLock = [...lastEval.values()].filter((e) => e.decision === 'ELIGIBLE').length;
/* One lock per eligible bout: every bout ELIGIBLE in the last armed run inside the lock window is locked. */
const windowRuns = runs.filter((r) => r.started_at >= UFC331.lock_window_opens && Date.parse(r.started_at) < Date.parse(UFC331.lock_window_closes));
const lastWindowRun = windowRuns[windowRuns.length - 1];
need(official, Boolean(lastWindowRun), 'no armed run inside the lock window yet');
if (lastWindowRun) {
  const eligibleInWindow = evals.filter((e) => e.run_id === lastWindowRun.id && e.decision === 'ELIGIBLE').map((e) => e.bout_id).sort();
  const lockedBouts = locked.map((p) => p.bout_id).sort();
  need(official, JSON.stringify(eligibleInWindow) === JSON.stringify(lockedBouts), `eligible bouts in the last window run (${eligibleInWindow.length}) != locked bouts (${lockedBouts.length})`);
}

/* Promotion / challenger side effects */
const reviews = await get('ufc_model_promotion_reviews?select=id,verdict,owner_decision,promoted_model_version');
need(official, reviews.every((r) => !r.owner_decision && !r.promoted_model_version), 'owner decision or promotion recorded');

/* Shadow isolation invariant */
const shadowRows = await get(`ufc_model_shadow_predictions?select=id,training_run_id,bout_id,decision,locked_at&event_id=eq.${UFC331.event_id}`);
const shadowLocked = shadowRows.filter((s) => s.locked_at);
for (const r of runs) need(shadow, !(r.counts?.shadow?.errors || []).length || r.status === 'ok', `run ${r.id} shadow errors failed official processing`);
const shadowErrors = runs.flatMap((r) => (r.counts?.shadow?.errors || []).map((x) => ({ run: r.id, error: x })));
need(shadow, locked.every((p) => p.model_version === V1.model_version), 'an official prediction carries a non-champion version');
const officialGrades = locked.length ? await inChunks('ufc_model_prediction_grades', 'prediction_id', locked.map((p) => p.id), 'prediction_id,result,revision,graded_by') : [];
need(shadow, officialGrades.every((g) => g.graded_by === 'ufc-algo'), 'an official grade was not written by the official grader');
const record = await get(`ufc_model_live_record?select=*&model_version=eq.${V1.model_version}`);
need(shadow, !record.length || Number(record[0].locked_predictions) === locked.length + (await count('ufc_model_predictions', `&locked_at=not.is.null&event_id=neq.${UFC331.event_id}`)), 'official record count differs from official locked predictions');
const challengerIds = [...new Set(shadowRows.map((s) => s.training_run_id))];
const pages = {};
for (const pth of ['/pro', '/algo', '/fights/arman-tsarukyan-vs-mauricio-ruffy-ufc-331-van-vs-pantoja-2-2026-09-19']) {
  const html = await (await fetch(`${PUBLIC_SITE}${pth}`)).text();
  const leaks = challengerIds.filter((id) => html.includes(id)).concat(/shadow|challenger/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')) ? ['shadow/challenger wording'] : []);
  pages[pth] = { bytes: html.length, pro_state: (html.match(/\d+ locked calls?|official calls active, first lock pending|pre-launch/) || [])[0] || null, leaks };
  need(shadow, !leaks.length, `public ${pth} shows shadow/challenger content: ${leaks.join(',')}`);
}

const pass = !official.length && !shadow.length;
print({
  VERDICT: pass ? 'PBE ALGO V1 — PRODUCTION LOCK LIFECYCLE ACCEPTED' : 'NOT ACCEPTED',
  OFFICIAL_LOCK_INVARIANTS: official.length ? 'FAIL' : 'PASS',
  SHADOW_ISOLATION_INVARIANT: shadow.length ? 'FAIL' : 'PASS',
  since, champion,
  armed_runs: runs.map((r) => ({ id: r.id, started_at: r.started_at, status: r.status, worker: r.worker_version, locked: r.counts?.locked, drafts_regenerated: r.counts?.drafts_regenerated, shadow: r.counts?.shadow })),
  official: { eligible_in_latest_evaluation: eligibleAtLock, locked: locked.length, locked_rows: locked.map((p) => ({ bout_id: p.bout_id, locked_at: p.locked_at, pick_probability: p.pick_probability, market_status: p.sample_context?.market?.status ?? null, market_snapshot_at: p.market_snapshot_at })), bouts: bouts.length },
  shadow: { shadow_rows: shadowRows.length, shadow_locks: shadowLocked.length, shadow_errors: shadowErrors, challenger_runs: challengerIds },
  public_pages: pages,
  official_failures: official, shadow_failures: shadow,
});
