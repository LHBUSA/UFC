/* PBE Picks archive: full-history index, pagination, corrections, failures and
 * the public boundary. Run: npm run test:algo-archive
 *
 * Every row here is synthetic and lives in this process (algoArchive.fixture.mjs).
 * Nothing is read from or written to a database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildStore, reader, fetchStub, authoritative } from './algoArchive.fixture.mjs';

register('./algo.test-hooks.mjs', import.meta.url);
process.env.SUPABASE_URL = 'https://fixture.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture';
delete process.env.PBE_ALGO_FIXTURE_FILE;

const A = await import('./algoArchive.ts');
const algo = await import('./algo.ts');

const NOW = Date.now();
const TODAY = new Date(NOW - 5 * 3600e3).toISOString().slice(0, 10);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the fixture is bigger than any single read: more than 1,000 official picks across many events', () => {
  const s = buildStore(NOW);
  assert.ok(s.preds.length > 1000);
  assert.ok(s.events.length > 100);
});

test('full-history totals reconcile with the authoritative rows, past a 1,000-row server cap', async () => {
  const s = buildStore(NOW);
  const log = [];
  const index = await A.loadIndex(reader(s, { maxRows: 1000, log }), { today: TODAY });
  const truth = authoritative(s);
  assert.equal(index.lifetime.locked, s.preds.length);
  assert.equal(index.lifetime.locked, truth.locked);
  for (const k of ['wins', 'losses', 'no_decision', 'pending', 'priced_decided']) assert.equal(index.lifetime[k], truth[k], k);
  assert.ok(near(index.lifetime.net_units, truth.net_units));
  assert.ok(near(index.lifetime.roi, truth.net_units / truth.priced_decided));
  assert.equal(index.lifetime.decided, truth.wins + truth.losses);
  assert.ok(log.filter((p) => p.startsWith('ufc_model_predictions?')).length >= 3, 'the scan kept reading after the first full page');
});

test('a server cap lower than the requested limit cannot truncate history (short page is not the end)', async () => {
  const s = buildStore(NOW);
  const index = await A.loadIndex(reader(s, { maxRows: 137 }), { today: TODAY });
  assert.equal(index.lifetime.locked, s.preds.length);
  assert.equal(index.integrity.graded, authoritative(s).locked - authoritative(s).pending);
});

test('drafts, shadow calls and backtests are never in the population, and their tables are never read', async () => {
  const s = buildStore(NOW);
  const log = [];
  const index = await A.loadIndex(reader(s, { log }), { today: TODAY });
  const ids = new Set(index.preds.map((p) => p.id));
  for (const d of s.drafts) assert.ok(!ids.has(d.id), 'a draft entered the official population');
  for (const p of log) {
    assert.doesNotMatch(p, /shadow|backtest|card_current|bout_evaluations/);
    if (p.startsWith('ufc_model_predictions?')) assert.match(p, /locked_at=not\.is\.null/, 'every prediction read is restricted to locked rows');
  }
});

test('pagination: ten events a page, every event exactly once, older events reachable, no pick missing or repeated', async () => {
  const s = buildStore(NOW);
  const index = await A.loadIndex(reader(s), { today: TODAY });
  const first = A.paginate(index.events, 1);
  assert.equal(first.items.length, 10);
  assert.equal(first.pages, Math.ceil(index.events.length / 10));
  const seenEvents = [], seenPicks = [];
  let sums = { locked: 0, wins: 0, losses: 0, pending: 0, no_decision: 0 };
  for (let n = 1; n <= first.pages; n += 1) {
    const page = A.paginate(index.events, n);
    assert.ok(page.items.length > 0 && page.items.length <= 10);
    for (const e of page.items) {
      seenEvents.push(e.event_id);
      seenPicks.push(...e.graded_prediction_ids);
      for (const k of Object.keys(sums)) sums[k] += e[k];
    }
  }
  assert.equal(new Set(seenEvents).size, seenEvents.length, 'an event appeared on two pages');
  assert.equal(seenEvents.length, index.events.length);
  assert.equal(new Set(seenPicks).size, seenPicks.length, 'a pick appeared twice');
  assert.equal(seenPicks.length, index.integrity.graded);
  for (const k of Object.keys(sums)) assert.equal(sums[k], index.lifetime[k], `event ${k} sums to lifetime`);
  // newest first with a stable tie-breaker
  const dated = index.events.filter((e) => e.event_date);
  for (let i = 1; i < dated.length; i += 1) assert.ok(A.compareEvents(dated[i - 1], dated[i]) < 0);
  // the oldest card is on the last page and addressable by id
  const oldest = s.events[0].id;
  assert.equal(A.pageOfEvent(index.events, oldest), first.pages);
  assert.equal(A.paginate(index.events, 999).page, first.pages, 'an out-of-range page clamps instead of returning nothing');
  assert.equal(A.paginate(index.events, -3).page, 1);
});

test('event status: a card with picks awaiting a grade is never called graded', async () => {
  const s = buildStore(NOW);
  const index = await A.loadIndex(reader(s), { today: TODAY });
  const by = (i) => index.events.find((e) => e.event_id === s.events[i].id);
  assert.equal(by(122).status, 'AWAITING_RESULTS');
  assert.equal(by(122).graded_prediction_ids.length, 0, 'an upcoming card exposes no pick id');
  assert.equal(by(121).status, 'GRADING');
  assert.deepEqual([by(121).locked, by(121).pending, by(121).graded_prediction_ids.length], [10, 4, 6]);
  assert.equal(by(120).status, 'GRADING_OVERDUE');
  assert.equal(by(5).status, 'GRADED');
  for (const e of index.events) if (e.pending > 0) assert.notEqual(e.status, 'GRADED');
  assert.deepEqual(index.overdue.map((o) => [o.event_id, o.pending]), [[s.events[120].id, 2]]);
});

test('every result type and a missing lock price keep the existing ROI treatment', () => {
  assert.equal(A.oneUnitReturn('WIN', 150), 1.5);
  assert.ok(near(A.oneUnitReturn('WIN', -200), 0.5));
  assert.equal(A.oneUnitReturn('LOSS', -200), -1);
  for (const r of ['DRAW', 'NC', 'VOID']) assert.equal(A.oneUnitReturn(r, 150), null);
  assert.equal(A.oneUnitReturn('WIN', null), null);
  const preds = [
    { id: 'a', best_odds: '150' }, { id: 'b', best_odds: null }, { id: 'c', best_odds: '-110' },
    { id: 'd', best_odds: '120' }, { id: 'e', best_odds: '120' }, { id: 'f', best_odds: '120' }, { id: 'g', best_odds: '300' },
  ];
  const g = (result, at) => ({ result, graded_at: at });
  const slice = A.summarizePerformance(preds, new Map([['a', g('WIN', '1')], ['b', g('WIN', '2')], ['c', g('LOSS', '3')], ['d', g('DRAW', '4')], ['e', g('NC', '5')], ['f', g('VOID', '6')]]));
  assert.deepEqual([slice.locked, slice.wins, slice.losses, slice.no_decision, slice.pending], [7, 2, 1, 3, 1]);
  assert.equal(slice.priced_decided, 2, 'the unpriced win stays in W-L and leaves the ROI denominator');
  assert.ok(near(slice.net_units, 0.5));
  assert.ok(near(slice.roi, 0.25));
  assert.ok(near(slice.hit_rate, 2 / 3));
});

test('a correction is a visible revision: totals follow the grade in force, ordering does not move', async () => {
  const s = buildStore(NOW);
  const before = await A.loadIndex(reader(s), { today: TODAY });
  const target = s.preds[37];                                     // an old, already graded pick
  const was = before.gradeBy.get(target.id);
  assert.equal(was.revisions, 1);
  s.grades.push({ id: 'ffffffff-0000-4000-8000-999999999999', prediction_id: target.id, revision: 2, result: was.result === 'WIN' ? 'LOSS' : 'WIN', graded_at: new Date(NOW).toISOString(), revision_reason: 'result overturned', source: 'fixture', method: null, graded_by: 'fixture' });
  const after = await A.loadIndex(reader(s), { today: TODAY });
  assert.deepEqual(after.events.map((e) => e.event_id), before.events.map((e) => e.event_id), 'event order unchanged');
  assert.deepEqual(A.recentGradedIds(after, 5), A.recentGradedIds(before, 5), 'an old correction does not resurface as a recent result');
  const now = after.gradeBy.get(target.id);
  assert.deepEqual([now.revision, now.revisions, now.first_graded_at], [2, 2, was.first_graded_at]);
  assert.notEqual(after.lifetime.wins, before.lifetime.wins);
  assert.equal(after.lifetime.decided, before.lifetime.decided);
  assert.equal(after.events.find((e) => e.event_id === target.event_id).corrected, before.events.find((e) => e.event_id === target.event_id).corrected + 1);
  const truth = authoritative(s);
  assert.equal(after.lifetime.wins, truth.wins);
});

test('recent results are chronological, not wins-only', async () => {
  const s = buildStore(NOW);
  const index = await A.loadIndex(reader(s), { today: TODAY });
  const ids = A.recentGradedIds(index, 5);
  assert.equal(ids.length, 5);
  const results = ids.map((id) => index.gradeBy.get(id).result);
  assert.ok(results.some((r) => r !== 'WIN'), `recent five were ${results.join(',')}`);
  const times = ids.map((id) => index.gradeBy.get(id).first_graded_at);
  assert.deepEqual(times, times.slice().sort().reverse());
  assert.ok(ids.every((id) => s.preds.find((p) => p.id === id).event_id === s.events[121].id), 'they come from the latest graded card');
});

test('historical official model versions stay in the archive and can be isolated', async () => {
  const s = buildStore(NOW);
  const all = await A.loadIndex(reader(s), { today: TODAY });
  assert.deepEqual(all.model_versions, ['pbe-fight-model-v1', 'pbe-fight-model-v2']);
  const v1 = await A.loadIndex(reader(s), { today: TODAY, model: 'pbe-fight-model-v1' });
  const truth = authoritative(s, (p) => p.model_version === 'pbe-fight-model-v1');
  assert.deepEqual([v1.lifetime.locked, v1.lifetime.wins, v1.lifetime.losses], [truth.locked, truth.wins, truth.losses]);
  assert.equal(v1.integrity.orphan_grade_predictions, 0, 'grades of the other official version are not orphans under a filter');
});

test('nothing is dropped or merged quietly: unresolved events and orphan grades are counted and reported', async () => {
  const s = buildStore(NOW);
  const index = await A.loadIndex(reader(s), { today: TODAY });
  assert.equal(index.integrity.unresolved_event_picks, 1);
  assert.equal(index.integrity.orphan_grade_predictions, 1);
  const bucket = index.events.at(-1);
  assert.equal(bucket.event_id, A.UNRESOLVED_EVENT);
  assert.equal(bucket.locked, 1);
  // a primary key served twice is reported, not collapsed
  const twice = async (path) => { const rows = await reader(s)(path); return path.startsWith('ufc_model_prediction_grades?') && !path.includes('id=gt.') ? [rows[0], ...rows] : rows; };
  const dup = await A.loadIndex(twice, { today: TODAY });
  assert.equal(dup.integrity.duplicate_grade_ids.length, 1);
});

test('empty history is a real empty state', async () => {
  const empty = { events: [], fighters: [], bouts: [], preds: [], drafts: [], grades: [] };
  const index = await A.loadIndex(reader(empty), { today: TODAY });
  assert.deepEqual([index.lifetime.locked, index.events.length, index.lifetime.hit_rate, index.lifetime.roi], [0, 0, null, null]);
  assert.deepEqual(A.paginate(index.events, 1), { page: 1, pages: 1, total_events: 0, items: [] });
});

test('an upstream failure is an error, never an empty record', async () => {
  const s = buildStore(NOW);
  await assert.rejects(() => A.loadIndex(reader(s, { fail: (t) => t === 'ufc_model_prediction_grades' }), { today: TODAY }));
  await assert.rejects(() => A.loadIndex(reader(s, { fail: (t, p) => t === 'ufc_model_predictions' && p.includes('id=gt.') }), { today: TODAY }), 'a failure on the second page fails the whole read');
  const stuck = async (path) => (path.startsWith('ufc_model_predictions?') ? [{ id: 'same' }] : []);
  await assert.rejects(() => A.loadIndex(stuck, { today: TODAY }), A.ArchiveReadError);
});

/* ---- lib/algo.ts over the same store: what a logged-out request can receive ---- */

const realFetch = globalThis.fetch;
const withStore = async (store, opts, fn) => { globalThis.fetch = fetchStub(store, opts); try { return await fn(); } finally { globalThis.fetch = realFetch; } };

test('no public reader ever returns, or even requests, an ungraded selection', async () => {
  const s = buildStore(NOW);
  const truth = authoritative(s);
  const pending = s.preds.filter((p) => !truth.current.has(p.id));
  assert.ok(pending.length >= 16);
  const pendingIds = new Set(pending.map((p) => p.id));
  const gradedFighters = new Set(s.preds.filter((p) => truth.current.has(p.id)).flatMap((p) => [p.fighter_a_id, p.fighter_b_id]));
  const secretFighters = [...new Set(pending.flatMap((p) => [p.fighter_a_id, p.fighter_b_id]))].filter((id) => !gradedFighters.has(id));
  const secretNames = s.fighters.filter((f) => secretFighters.includes(f.id)).map((f) => f.name);
  const log = [];
  const payloads = await withStore(s, { log }, async () => {
    const out = [await algo.getAlgoPerformanceProof(), await algo.getAlgoRecentGradedPicks(5), await algo.getAlgoRecordHealth()];
    const first = await algo.getAlgoArchive({ page: 1 });
    assert.equal(first.ok, true);
    for (let n = 1; n <= first.pages; n += 1) out.push(await algo.getAlgoArchive({ page: n }));
    out.push(await algo.getAlgoArchive({ pick: pending[0].id }), await algo.getAlgoArchive({ event: s.events[122].id }), await algo.getAlgoArchive({ model: 'pbe-fight-model-v2' }));
    return out;
  });
  const text = JSON.stringify(payloads);
  for (const id of pendingIds) assert.ok(!text.includes(id), `pending prediction ${id} left the data layer`);
  for (const id of secretFighters) assert.ok(!text.includes(id), `a fighter from an ungraded pick left the data layer`);
  for (const name of secretNames) assert.ok(!text.includes(`"${name}"`), `${name} left the data layer`);
  for (const path of log) {
    if (/^ufc_(fighters|bouts)\?/.test(path) || (path.startsWith('ufc_model_predictions?') && path.includes('sample_context,') === false && path.includes('pick_fighter_id'))) {
      for (const id of [...secretFighters, ...pendingIds]) assert.ok(!decodeURIComponent(path).includes(id), 'identity was requested for an ungraded pick');
    }
    if (path.startsWith('ufc_model_predictions?') && path.includes('pick_fighter_id')) for (const id of pendingIds) assert.ok(!decodeURIComponent(path).includes(id));
  }
  const asked = payloads.at(-3);
  assert.deepEqual([asked.ok, asked.not_found, asked.focus_prediction_id], [true, 'pick', null], 'an ungraded pick has no public address');
});

test('getAlgoArchive: pages hold ten events with their graded picks, permanent links resolve, aggregates ignore the page', async () => {
  const s = buildStore(NOW);
  await withStore(s, {}, async () => {
    const p1 = await algo.getAlgoArchive({ page: 1 });
    const last = await algo.getAlgoArchive({ page: p1.pages });
    assert.equal(p1.events.length, 10);
    assert.deepEqual(last.lifetime, p1.lifetime, 'lifetime does not depend on the page');
    assert.deepEqual(last.slices, p1.slices);
    const truth = authoritative(s);
    assert.equal(p1.lifetime.wins, truth.wins);
    const newestGraded = p1.events.find((e) => e.event_id === s.events[121].id);
    assert.equal(newestGraded.picks.length, 6);
    assert.deepEqual(newestGraded.picks.map((p) => p.order), newestGraded.picks.map((p) => p.order).slice().sort((a, b) => b - a), 'card order');
    // permanent addresses
    const oldPick = s.preds[3];
    const byPick = await algo.getAlgoArchive({ pick: oldPick.id });
    assert.equal(byPick.focus_event_id, oldPick.event_id);
    assert.equal(byPick.page, p1.pages, 'the oldest card resolves to the last page');
    assert.ok(byPick.events.some((e) => e.picks.some((p) => p.prediction_id === oldPick.id)));
    const byEvent = await algo.getAlgoArchive({ event: s.events[0].id });
    assert.ok(byEvent.events.some((e) => e.event_id === s.events[0].id));
    assert.equal((await algo.getAlgoArchive({ event: 'nope' })).not_found, 'event');
    // frozen price and visible revisions
    const corrected = s.preds.find((_, n) => n % 97 === 5);
    const view = (await algo.getAlgoArchive({ pick: corrected.id })).events.flatMap((e) => e.picks).find((p) => p.prediction_id === corrected.id);
    assert.deepEqual(view.revisions.map((r) => [r.revision, r.result]), [[1, view.revisions[0].result], [2, 'NC']]);
    assert.equal(view.result, 'NC');
    assert.equal(view.net_units, null);
    assert.equal(view.lock_price, corrected.sample_context.market.pick_best_odds ?? null);
    assert.ok(!('feature_vector' in view));
  });
});

test('upstream failure reaches the caller as a failure, not as 0-0', async () => {
  const s = buildStore(NOW);
  await withStore(s, { fail: (t) => t === 'ufc_model_predictions' }, async () => {
    const archive = await algo.getAlgoArchive({ page: 1 });
    assert.deepEqual([archive.ok, typeof archive.error], [false, 'string']);
    const proof = await algo.getAlgoPerformanceProof();
    assert.equal(proof.unavailable, true);
    assert.equal(await algo.getAlgoRecentGradedPicks(5), null);
    const health = await algo.getAlgoRecordHealth();
    assert.deepEqual([health.ok, typeof health.read_error], [false, 'string']);
  });
  await withStore(s, {}, async () => {
    const health = await algo.getAlgoRecordHealth();
    assert.equal(health.ok, false, 'overdue grading and an orphan grade make the record unhealthy');
    assert.equal(health.overdue.length, 1);
    assert.equal(JSON.stringify(health).includes('Fighter'), false);
  });
});

test('the tracker still reports the fight-week card and the latest graded result', async () => {
  const s = buildStore(NOW);
  await withStore(s, {}, async () => {
    const proof = await algo.getAlgoPerformanceProof();
    assert.equal(proof.fight_week.event_id, s.events[122].id, 'the next locked card is the fight-week scope');
    assert.deepEqual([proof.fight_week.locked, proof.fight_week.pending], [10, 10]);
    assert.ok(['WIN', 'LOSS', 'DRAW', 'NC', 'VOID'].includes(proof.last_result.result));
    assert.equal(proof.lifetime.locked, s.preds.length);
  });
});

test('the public archive surfaces never import a Pro reader, a draft source or a capped read', () => {
  const web = new URL('../', import.meta.url);
  for (const f of ['app/algo/record/page.tsx', 'components/PbePastPicks.tsx', 'app/api/ufc/record-health/route.ts']) {
    const src = readFileSync(new URL(f, web), 'utf8');
    assert.doesNotMatch(src, /getAlgoCards|getAlgoBout|getAlgoRecord|getAlgoNextCardSummary|AlgoPick|feature_vector|ufc_model_card_current/, f);
  }
  const archive = readFileSync(new URL('lib/algoArchive.ts', web), 'utf8');
  assert.doesNotMatch(archive.replace(/\/\*[\s\S]*?\*\//g, ''), /shadow|backtest|card_current|bout_evaluations/, 'the archive core names no non-official table');
  const algoSrc = readFileSync(new URL('lib/algo.ts', web), 'utf8');
  const perf = algoSrc.slice(algoSrc.indexOf('export async function getAlgoPerformanceProof'), algoSrc.indexOf('/* ---- UFC Pro'));
  assert.doesNotMatch(perf, /limit=1000/, 'the tracker is no longer computed from a capped read');
  assert.doesNotMatch(algoSrc, /getAlgoPublicGradedRecord/, 'the capped public ledger reader is gone');
});
