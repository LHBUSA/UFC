/* Fighter career record refresh. Run: node --test src/fighterRecord.test.mjs
 *
 * Pins the 2026-09-14 defect: every Noche UFC (2026-09-12) fighter kept the
 * record stored on Sep 6-7 because ensureEspnFighter() returns a known ESPN
 * athlete before ever re-reading it. The record is now refreshed from ESPN,
 * separately from identity, when a result lands and by a bounded daily
 * reconcile — and written only when the source moved the way our results say
 * it should. Offline: in-memory PostgREST + R2, ESPN served from verified shapes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordSummary, parseEspnRecordItem, pickOverallRecord, decideRecordRefresh, planRecordRefresh, fighterOutcome } from './fighterRecord.mjs';
import { Espn } from './espn.mjs';
import { __test, recordRefresh } from './index.js';

/* ------------------------------------------------------------- parsing */
const espnItem = (w, l, d, nc, summary = `${w}-${l}-${d}`) => ({
  name: 'overall', type: 'total', summary, displayValue: summary,
  stats: [{ name: 'losses', value: l }, { name: 'wins', value: w }, { name: 'draws', value: d },
    ...(nc == null ? [] : [{ name: 'noContests', value: nc }]), { name: 'tkos', value: 3 }],
});

test('record summary formats: W-L-D, W-L-D (n NC), W-L-D, n NC; ambiguous formats rejected', () => {
  assert.deepEqual(parseRecordSummary('20-3-0'), { w: 20, l: 3, d: 0, nc: null }, 'W-L-D says nothing about NC');
  assert.deepEqual(parseRecordSummary('20-3-0 (1 NC)'), { w: 20, l: 3, d: 0, nc: 1 });
  assert.deepEqual(parseRecordSummary('Record: 32-18-2 (3 NC)'), { w: 32, l: 18, d: 2, nc: 3 });
  assert.deepEqual(parseRecordSummary('20-3-0, 2 NC'), { w: 20, l: 3, d: 0, nc: 2 });
  assert.deepEqual(parseRecordSummary(' 18 - 3 - 0 '), { w: 18, l: 3, d: 0, nc: null });
  for (const bad of ['20-3', '20-3-0-1', 'eighteen-3-0', '', null, '20-3-0 (NC)']) assert.equal(parseRecordSummary(bad), null, `rejects ${bad}`);
});

test('ESPN record item: NC comes from the noContests stat (the summary omits it), including an explicit 0', () => {
  /* Melvin Guillard, live 2026-09-14: summary "32-24-2", noContests 3. */
  assert.deepEqual(parseEspnRecordItem(espnItem(32, 24, 2, 3)), { w: 32, l: 24, d: 2, nc: 3, nc_source: 'stats', summary: '32-24-2' });
  /* Jean Silva, live 2026-09-14. */
  assert.deepEqual(parseEspnRecordItem(espnItem(18, 3, 0, 0)), { w: 18, l: 3, d: 0, nc: 0, nc_source: 'stats', summary: '18-3-0' });
  const summaryOnly = parseEspnRecordItem({ name: 'overall', summary: '12-3-0' });
  assert.deepEqual([summaryOnly.w, summaryOnly.l, summaryOnly.d, summaryOnly.nc, summaryOnly.nc_source], [12, 3, 0, null, 'absent'], 'no stat, no "(n NC)": NC unknown, never assumed 0');
  const ncInSummary = parseEspnRecordItem({ name: 'overall', summary: '20-3-0 (1 NC)' });
  assert.deepEqual([ncInSummary.nc, ncInSummary.nc_source], [1, 'summary']);
  assert.match(parseEspnRecordItem(espnItem(18, 3, 0, 0, '17-3-0')).error, /disagrees/, 'summary vs stats disagreement is not understood');
  assert.match(parseEspnRecordItem(null).error, /no overall/);
  assert.equal(pickOverallRecord({ items: [{ name: 'home' }, espnItem(1, 0, 0, 0)] }).name, 'overall');
});

test('fighter outcome from a stored result, draw and NC included', () => {
  assert.equal(fighterOutcome({ winner_id: 'a', method: 'KO_TKO' }, 'a'), 'W');
  assert.equal(fighterOutcome({ winner_id: 'a', method: 'DEC_S' }, 'b'), 'L');
  assert.equal(fighterOutcome({ winner_id: null, method: 'DRAW' }, 'a'), 'D');
  assert.equal(fighterOutcome({ winner_id: null, method: 'NC' }, 'b'), 'NC');
  assert.equal(fighterOutcome({ winner_id: null, method: 'OTHER' }, 'b'), null);
});

/* ------------------------------------------------------------ decisions */
const row = (w, l, d, nc = 0) => ({ record_w: w, record_l: l, record_d: d, record_nc: nc });
const src = (w, l, d, nc = 0) => ({ w, l, d, nc, nc_source: nc == null ? 'absent' : 'stats' });

test('decide: source moved as our result says -> update only the changed fields', () => {
  const d = decideRecordRefresh({ stored: row(17, 3, 0, null), source: src(18, 3, 0, 0), expected: [{ outcome: 'W' }], staleProof: true });
  assert.equal(d.action, 'update');
  assert.deepEqual(d.changes, { record_w: 18, record_nc: 0 }, 'W moved, unknown NC filled from the stat');
  const loss = decideRecordRefresh({ stored: row(12, 2, 0), source: src(12, 3, 0), expected: [{ outcome: 'L' }], staleProof: true });
  assert.deepEqual([loss.action, loss.changes], ['update', { record_l: 3 }]);
});

test('decide: unchanged source after a known result -> pending_source, nothing written', () => {
  const d = decideRecordRefresh({ stored: row(17, 3, 0), source: src(17, 3, 0), expected: [{ outcome: 'W' }], staleProof: true });
  assert.deepEqual([d.action, d.changes], ['pending_source', {}]);
  const quiet = decideRecordRefresh({ stored: row(17, 3, 0), source: src(17, 3, 0), expected: [{ outcome: 'W' }], staleProof: false });
  assert.equal(quiet.action, 'unchanged', 'no proof the stored row predates the result');
});

test('decide: unexpected source changes -> mismatch, nothing written', () => {
  const dec = decideRecordRefresh({ stored: row(17, 3, 0), source: src(16, 3, 0), expected: [{ outcome: 'W' }], staleProof: true });
  assert.deepEqual([dec.action, dec.changes], ['mismatch', {}]);
  assert.match(dec.reason, /decreased/);
  const jump = decideRecordRefresh({ stored: row(32, 18, 2, 3), source: src(32, 24, 2, 3), expected: [], staleProof: false });
  assert.equal(jump.action, 'mismatch', 'Guillard-style +6 L with no known result');
  const tooMany = decideRecordRefresh({ stored: row(10, 1, 0), source: src(12, 1, 0), expected: [{ outcome: 'W' }], staleProof: true });
  assert.equal(tooMany.action, 'mismatch', 'two new fights, one known result');
  const wrongWay = decideRecordRefresh({ stored: row(10, 1, 0), source: src(10, 2, 0), expected: [{ outcome: 'W' }], staleProof: true });
  assert.equal(wrongWay.action, 'mismatch', 'we recorded a win, source added a loss');
  const ncDown = decideRecordRefresh({ stored: row(10, 1, 0, 2), source: src(10, 1, 0, 1), expected: [], staleProof: false });
  assert.equal(ncDown.action, 'mismatch', 'NC decrease is a decrease');
  const unreadable = decideRecordRefresh({ stored: row(10, 1, 0), source: { error: 'unparseable' }, expected: [{ outcome: 'W' }] });
  assert.equal(unreadable.action, 'source_unavailable');
});

test('decide: draw and no contest results explain D and NC moves; an unknown outcome is a wildcard', () => {
  assert.deepEqual(decideRecordRefresh({ stored: row(5, 1, 0), source: src(5, 1, 1), expected: [{ outcome: 'D' }], staleProof: true }).changes, { record_d: 1 });
  assert.deepEqual(decideRecordRefresh({ stored: row(5, 1, 0, 0), source: src(5, 1, 0, 1), expected: [{ outcome: 'NC' }], staleProof: true }).changes, { record_nc: 1 });
  assert.equal(decideRecordRefresh({ stored: row(5, 1, 0), source: src(5, 2, 0), expected: [{ outcome: null }], staleProof: true }).action, 'update');
  assert.equal(decideRecordRefresh({ stored: row(5, 1, 0), source: src(5, 1, 0, null), expected: [], staleProof: false }).action, 'unchanged', 'NC absent at source leaves stored NC alone');
});

test('plan: bounded, deduplicated, triggered first, recently verified records skipped', () => {
  const fighters = new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, espn_athlete_id: `e${id}`, updated_at: '2026-09-07T00:00:00Z' }]));
  fighters.set('x', { id: 'x', espn_athlete_id: null, updated_at: '2026-09-07T00:00:00Z' });
  const window = [
    { fighter_id: 'a', bout_id: 'b1', event_date: '2026-09-12', outcome: 'W' }, { fighter_id: 'b', bout_id: 'b1', event_date: '2026-09-12', outcome: 'L' },
    { fighter_id: 'a', bout_id: 'b2', event_date: '2026-08-20', outcome: 'W' }, { fighter_id: 'c', bout_id: 'b2', event_date: '2026-08-20', outcome: 'L' },
    { fighter_id: 'd', bout_id: 'b3', event_date: '2026-09-01', outcome: 'W' }, { fighter_id: 'x', bout_id: 'b3', event_date: '2026-09-01', outcome: 'L' },
  ];
  const triggered = new Map([['c', { results: [{ bout_id: 'b9', event_date: '2026-09-13', outcome: 'W' }] }]]);
  const now = Date.parse('2026-09-14T06:00:00Z');
  const state = { d: { outcome: 'unchanged', last_checked: '2026-09-13T06:00:00Z' } };
  fighters.get('d').updated_at = '2026-09-02T00:00:00Z';
  const { plan, capped, skipped } = planRecordRefresh({ triggered, window, fighters, state, now, max: 2 });
  assert.deepEqual(plan.map((p) => p.fighter_id), ['c', 'a'], 'triggered first, then the most recent stale record');
  assert.equal(new Set(plan.map((p) => p.fighter_id)).size, plan.length, 'one entry per fighter');
  assert.equal(plan.find((p) => p.fighter_id === 'a').expected.length, 2, 'both known results are the allowance');
  assert.equal(capped, 1);
  assert.equal(skipped.no_espn_id, 1);
  assert.equal(skipped.recently_checked, 1, 'd verified yesterday with no newer result');
  const fn = planRecordRefresh({ triggered: new Map(), window, fighters, state: { b: { outcome: 'pending_source', last_checked: '2026-09-14T05:50:00Z' }, a: { outcome: 'pending_source', last_checked: '2026-09-14T04:00:00Z' } }, now, retryOnly: true, pendingRetryMinutes: 60 });
  assert.deepEqual(fn.plan.map((p) => p.fighter_id), ['a'], 'fight night: only pending retries older than the retry interval');
});

/* ------------------------------------------------ in-memory PostgREST + R2 */
function makeDb(seed) {
  const T = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const writes = [];
  let seq = 0;
  const matcher = (params) => {
    const f = [...params].filter(([k]) => !['select', 'order', 'limit', 'on_conflict', 'offset'].includes(k));
    return (r) => f.every(([k, v]) => {
      const val = r[k] == null ? null : String(r[k]);
      if (v.startsWith('eq.')) return val === decodeURIComponent(v.slice(3));
      if (v.startsWith('in.')) return v.slice(3).replace(/^\(|\)$/g, '').split(',').includes(val);
      if (v === 'is.null') return val === null;
      if (v.startsWith('gte.')) return val !== null && val >= v.slice(4);
      if (v.startsWith('lte.')) return val !== null && val <= v.slice(4);
      throw new Error(`mock: unsupported filter ${k}=${v}`);
    });
  };
  const handle = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = (T[table] ||= []);
    const method = init.method || 'GET';
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const match = matcher(u.searchParams);
    if (method === 'GET') {
      let out = rows.filter(match);
      if (h.range) { const [a, b] = h.range.split('-').map(Number); out = out.slice(a, b + 1); }
      return new Response(JSON.stringify(out), { status: 200 });
    }
    writes.push({ method, table, query: u.search, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'POST') {
      const conflict = (u.searchParams.get('on_conflict') || 'id').split(',');
      const out = [];
      for (const r of JSON.parse(init.body)) {
        const hit = rows.find((x) => conflict.every((c) => x[c] != null && String(x[c]) === String(r[c])));
        if (hit) { Object.assign(hit, r); out.push(hit); continue; }
        const created = { id: r.id || `row-${++seq}`, ...r };
        rows.push(created); out.push(created);
      }
      return new Response(JSON.stringify(out), { status: 201 });
    }
    if (method === 'PATCH') {
      const vals = JSON.parse(init.body);
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, vals);
      return new Response(String(h.prefer || '').includes('representation') ? JSON.stringify(hit) : '', { status: 200 });
    }
    throw new Error(`mock: ${method}`);
  };
  return { T, writes, handle };
}

const CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc';
/* An Espn adapter whose transport serves athlete + records documents in the
 * verified live shape, counting requests per athlete. */
function fakeEspn(records) {
  const espn = new Espn({ minIntervalMs: 0 });
  espn.athleteHits = new Map();
  espn.json = async (url) => {
    const m = /\/athletes\/(\d+)(\/records)?/.exec(url);
    if (!m) throw new Error(`unexpected ESPN url ${url}`);
    const id = m[1];
    if (!m[2]) {
      espn.athleteHits.set(id, (espn.athleteHits.get(id) || 0) + 1);
      return { id, fullName: `Athlete ${id}`, records: { $ref: `${CORE}/athletes/${id}/records?lang=en&region=us` } };
    }
    const r = records[id];
    return { items: r ? [espnItem(...r)] : [] };
  };
  return espn;
}

function harness(seed) {
  const db = makeDb(seed);
  const r2 = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('http://sb.test/rest/v1/')) return db.handle(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = {
    SUPABASE_URL: 'http://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    RAW: { get: async (k) => (r2.has(k) ? { json: async () => JSON.parse(r2.get(k)) } : null), put: async (k, v) => { r2.set(k, String(v)); } },
  };
  return { db, r2, env };
}
const newRun = () => ({ events_new: 0, bouts_new: 0, fighters_touched: 0, scorecards_reconciled: 0, scorecards_written: 0, scorecard_cards_written: 0,
  totals_reconciled: 0, totals_bouts_written: 0, totals_rows_written: 0, assertion_failures: [], notes: {} });

const NOW = Date.parse('2026-09-14T06:00:00Z');
function nocheSeed() {
  const fighter = (id, name, espn, w, l, d, nc, extra = {}) => ({ id, name, espn_athlete_id: espn, ufcstats_id: `us-${id}`, nickname: `nick-${id}`, dob: '1996-01-01',
    height_in: 70, reach_in: 72, weight_lbs: 145, stance: 'ORTHODOX', is_active: true, source_url: `https://src/${id}`, captured_at: '2026-09-06T00:00:00Z',
    record_w: w, record_l: l, record_d: d, record_nc: nc, updated_at: '2026-09-07T01:58:03Z', ...extra });
  return {
    ufc_fighters: [
      fighter('silva', 'Jean Silva', '5145766', 17, 3, 0, null),
      fighter('delgado', 'Jose Miguel Delgado', '5223435', 12, 2, 0, 0),
      fighter('p1', 'Pending One', '901', 9, 1, 0, 0),
      fighter('p2', 'Pending Two', '902', 7, 4, 0, 0),
      fighter('m1', 'Mismatch One', '903', 20, 5, 0, 0),
      fighter('m2', 'Mismatch Two', '904', 8, 8, 0, 0),
    ],
    ufc_fighter_aliases: [],
    ufc_events: [{ id: 'noche', name: 'Noche UFC: Silva vs. Delgado', event_date: '2026-09-12', espn_event_id: '600060772', card_status: 'complete' }],
    ufc_bouts: [
      { id: 'main', event_id: 'noche', fighter_a_id: 'silva', fighter_b_id: 'delgado', espn_competition_id: 'c-main', status: 'complete', weight_class: 'FEATHERWEIGHT' },
      { id: 'pend', event_id: 'noche', fighter_a_id: 'p1', fighter_b_id: 'p2', espn_competition_id: 'c-pend', status: 'complete', weight_class: 'LIGHTWEIGHT' },
      { id: 'mism', event_id: 'noche', fighter_a_id: 'm1', fighter_b_id: 'm2', espn_competition_id: 'c-mism', status: 'complete', weight_class: 'LIGHTWEIGHT' },
    ],
    ufc_bout_results: [
      { bout_id: 'main', winner_id: 'silva', method: 'KO_TKO', round: 2, has_stats: false },
      { bout_id: 'pend', winner_id: 'p1', method: 'SUB', round: 1, has_stats: false },
      { bout_id: 'mism', winner_id: 'm1', method: 'DEC_U', round: 3, has_stats: false },
    ],
  };
}
/* ESPN today: Silva and Delgado updated; the pending pair not yet; the mismatch
 * pair moved the wrong way (m1 lost a win, m2 gained two losses). */
const NOCHE_ESPN = { 5145766: [18, 3, 0, 0], 5223435: [12, 3, 0, 0], 901: [9, 1, 0, 0], 902: [7, 4, 0, 0], 903: [19, 5, 0, 0], 904: [8, 10, 0, 0] };
const IDENTITY = ['id', 'name', 'espn_athlete_id', 'ufcstats_id', 'nickname', 'dob', 'height_in', 'reach_in', 'weight_lbs', 'stance', 'is_active', 'source_url', 'captured_at'];

test('daily reconcile: updates stale records, pending_source and mismatch write nothing, identity untouched, second run writes nothing', async () => {
  const { db, r2, env } = harness(nocheSeed());
  const before = new Map(db.T.ufc_fighters.map((f) => [f.id, { ...f }]));
  const ctx = await __test.loadContext(env);
  const espn = fakeEspn(NOCHE_ESPN);
  const run = newRun();
  const s = await recordRefresh.refreshFighterRecords(env, espn, ctx, run, { mode: 'daily', now: NOW });

  assert.equal(s.error, undefined, s.error);
  assert.deepEqual([s.planned, s.update, s.pending_source, s.mismatch], [6, 2, 2, 2], JSON.stringify(s));
  const by = (id) => db.T.ufc_fighters.find((f) => f.id === id);
  assert.deepEqual([by('silva').record_w, by('silva').record_l, by('silva').record_d, by('silva').record_nc], [18, 3, 0, 0], 'Jean Silva 17-3 -> 18-3, NC filled 0 from the stat');
  assert.deepEqual([by('delgado').record_w, by('delgado').record_l], [12, 3], 'Delgado 12-2 -> 12-3');
  for (const id of ['p1', 'p2', 'm1', 'm2']) assert.deepEqual(by(id), before.get(id), `${id}: no write`);
  for (const f of db.T.ufc_fighters) for (const k of IDENTITY) assert.equal(f[k], before.get(f.id)[k], `${f.id}.${k} untouched`);

  const patches = db.writes.filter((w) => w.table === 'ufc_fighters');
  assert.equal(patches.length, 2, 'exactly the two updates');
  for (const p of patches) {
    assert.equal(p.method, 'PATCH');
    assert.match(p.query, /id=eq\.[a-z]+&espn_athlete_id=eq\.\d+/, 'identity-guarded filter');
    assert.ok(Object.keys(p.body).every((k) => ['record_w', 'record_l', 'record_d', 'record_nc', 'updated_at'].includes(k)), `record fields only: ${Object.keys(p.body)}`);
  }
  assert.equal(run.fighters_touched, 2);
  assert.ok(s.mismatches.some((m) => /decreased/.test(m.reason)) && s.mismatches.some((m) => /added 2 fight/.test(m.reason)), JSON.stringify(s.mismatches));
  const state = JSON.parse(r2.get(recordRefresh.STATE_KEY));
  assert.equal(state.fighters.p1.outcome, 'pending_source', 'pending retry recorded');
  assert.equal(state.fighters.m2.outcome, 'mismatch');

  /* Second run, forced to re-read everything: the refreshed records are now
   * unchanged, the others still pending/mismatch, and nothing is written. */
  const writesBefore = db.writes.filter((w) => w.table === 'ufc_fighters').length;
  const ctx2 = await __test.loadContext(env);
  const s2 = await recordRefresh.refreshFighterRecords({ ...env, RECORD_RECHECK_DAYS: '0' }, fakeEspn(NOCHE_ESPN), ctx2, newRun(), { mode: 'daily', now: NOW });
  assert.deepEqual([s2.update, s2.pending_source, s2.mismatch], [0, 2, 2], JSON.stringify(s2));
  assert.equal(s2.unchanged, 2);
  assert.equal(db.writes.filter((w) => w.table === 'ufc_fighters').length, writesBefore, 'idempotent: no second write');
  assert.equal(JSON.parse(r2.get(recordRefresh.STATE_KEY)).fighters.p1.attempts, 2);

  /* Third run at default recheck: the verified records are not even fetched. */
  const espn3 = fakeEspn(NOCHE_ESPN);
  const s3 = await recordRefresh.refreshFighterRecords(env, espn3, await __test.loadContext(env), newRun(), { mode: 'daily', now: NOW });
  assert.equal(espn3.athleteHits.get('5145766'), undefined, 'verified yesterday, no newer result: not re-read');
  assert.equal(s3.skipped.recently_checked, 2);
});

test('refreshEspnFighterProfile: requires an ESPN id, refuses an identity that does not round-trip', async () => {
  const { db, env } = harness(nocheSeed());
  const ctx = await __test.loadContext(env);
  const none = await recordRefresh.refreshEspnFighterProfile(env, fakeEspn(NOCHE_ESPN), ctx, { id: 'z', name: 'No Link', espn_athlete_id: null });
  assert.equal(none.action, 'skipped');
  const espn = fakeEspn(NOCHE_ESPN);
  espn.athlete = async () => ({ espn_athlete_id: '999', record_detail: { w: 99, l: 0, d: 0, nc: 0 } });
  const wrong = await recordRefresh.refreshEspnFighterProfile(env, espn, ctx, ctx.fightersById.get('silva'), { expected: [{ outcome: 'W' }], staleProof: true });
  assert.equal(wrong.action, 'mismatch');
  assert.equal(db.writes.length, 0);
});

/* ------------------------------------- trigger: from results in the ESPN pass */
function passEspn({ records, bouts }) {
  const espn = fakeEspn(records);
  espn.eventRefs = async () => bouts.map((_, i) => `ref-${i}`);
  espn.event = async (ref) => {
    const i = Number(ref.split('-')[1]);
    const card = bouts[i];
    return { url: `https://espn/${ref}`, venue: null, raw: { id: card.espn_event_id, date: `${card.event_date}T22:00Z`, name: card.name, status: { type: { completed: true, state: 'post' } }, competitions: [] }, card };
  };
  espn.bouts = async (ev) => ev.card.bouts.map((b, n) => ({
    espn_competition_id: b.comp, espn_match_number: n + 1, bout_order: n + 1, weight_class_raw: 'Lightweight', time_format: '3 Rnd (5-5-5)', scheduled_rounds: 3,
    card_position: null, status_name: b.final ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', completed: b.final,
    fighters: b.corners.map((id) => ({ espn_athlete_id: id, athlete_ref: `${CORE}/athletes/${id}`, winner: b.winner === id })),
    result: b.final ? { method_raw: b.method, finish_detail: null, round: 3, time: '5:00', winner_espn_athlete_id: b.winner || null } : null,
    officials_ref: null, source_url: `${CORE}/events/${ev.raw.id}/competitions/${b.comp}`,
  }));
  espn.officiating = async () => ({ referee: null, judges: [] });
  espn.scorecards = async () => ({ cards: [], rejected: [], scoredJudges: 0 });
  espn.fightTotals = async () => null;
  return espn;
}

test('trigger: new final results (win, draw, NC) put both corners in one deduplicated refresh set; unfinished and already-known results do not', async () => {
  const f = (id, espn, w, l, d, nc = 0) => ({ id, name: `F ${id}`, espn_athlete_id: espn, ufcstats_id: null, nickname: null, dob: null, record_w: w, record_l: l, record_d: d, record_nc: nc, updated_at: '2026-09-01T00:00:00Z' });
  const seed = {
    ufc_fighters: [f('a', '1', 5, 0, 0), f('b', '2', 4, 1, 0), f('c', '3', 3, 3, 0), f('d', '4', 6, 2, 0), f('e', '5', 2, 2, 0), f('g', '6', 1, 1, 0), f('h', '7', 9, 9, 0), f('i', '8', 8, 8, 0)],
    ufc_fighter_aliases: [],
    ufc_events: [
      { id: 'ev1', name: 'Card One', event_date: '2026-09-12', espn_event_id: 'e1', card_status: 'announced' },
      { id: 'ev2', name: 'Card Two', event_date: '2026-09-13', espn_event_id: 'e2', card_status: 'announced' },
    ],
    ufc_bouts: [{ id: 'known', event_id: 'ev1', fighter_a_id: 'h', fighter_b_id: 'i', espn_competition_id: 'k1', status: 'complete', weight_class: 'LIGHTWEIGHT' }],
    ufc_bout_results: [{ bout_id: 'known', winner_id: 'h', method: 'SUB', round: 1, has_stats: false }],
    ufc_bout_fight_stats: [],
  };
  const { db, env } = harness(seed);
  const cards = [
    { espn_event_id: 'e1', name: 'Card One', event_date: '2026-09-12', bouts: [
      { comp: 'c1', corners: ['1', '2'], final: true, method: 'KO/TKO', winner: '1' },
      { comp: 'c2', corners: ['3', '4'], final: true, method: 'Draw' },
      { comp: 'k1', corners: ['7', '8'], final: true, method: 'Submission', winner: '7' },
      { comp: 'c4', corners: ['6', '5'], final: false },
    ] },
    /* Fighter a again (a second refreshed bout, e.g. a tournament night), and an NC. */
    { espn_event_id: 'e2', name: 'Card Two', event_date: '2026-09-13', bouts: [
      { comp: 'c3', corners: ['1', '5'], final: true, method: 'No Contest' },
    ] },
  ];
  const records = { 1: [6, 0, 0, 1], 2: [4, 2, 0, 0], 3: [3, 3, 1, 0], 4: [6, 2, 1, 0], 5: [2, 2, 0, 1], 6: [1, 1, 0, 0], 7: [9, 9, 0, 0], 8: [8, 8, 0, 0] };
  const espn = passEspn({ records, bouts: cards });
  const ctx = await __test.loadContext(env);
  const run = newRun();
  await __test.espnPass(env, espn, ctx, run, { dates: ['20260912'], scope: 'fight-night' });

  assert.deepEqual([...ctx.recordRefresh.keys()].sort(), ['a', 'b', 'c', 'd', 'e'], 'finals only; the unchanged known result and the unfinished bout do not trigger');
  assert.deepEqual(ctx.recordRefresh.get('a').results.map((r) => r.outcome).sort(), ['NC', 'W'], 'one entry, both results');
  assert.deepEqual(ctx.recordRefresh.get('c').results.map((r) => r.outcome), ['D'], 'a draw triggers');
  assert.deepEqual(ctx.recordRefresh.get('e').results.map((r) => r.outcome), ['NC'], 'a no contest triggers');

  const s = await recordRefresh.refreshFighterRecords(env, espn, ctx, run, { mode: 'fightnight', now: Date.parse('2026-09-14T03:00:00Z') });
  assert.equal(s.error, undefined, s.error);
  for (const id of ['1', '2', '3', '4', '5']) assert.equal(espn.athleteHits.get(id), 1, `athlete ${id} fetched exactly once`);
  assert.equal(espn.athleteHits.get('6'), undefined, 'fight night does not reconcile the rest of the window');
  assert.equal(espn.athleteHits.get('7'), undefined);
  const by = (id) => db.T.ufc_fighters.find((x) => x.id === id);
  assert.deepEqual([by('a').record_w, by('a').record_nc], [6, 1], 'W + NC from the source, explained by our W and NC');
  assert.deepEqual([by('c').record_d, by('d').record_d, by('e').record_nc], [1, 1, 1]);
  assert.equal(s.update, 5, JSON.stringify(s));
  assert.equal(run.notes.record_refresh, undefined, 'the pass itself only builds the set');
});
