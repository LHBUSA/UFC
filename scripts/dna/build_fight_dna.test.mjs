// Regression tests for the Fight DNA builder's as-of cutoff.
//
//   node --test scripts/dna/build_fight_dna.test.mjs
//
// No network. globalThis.fetch is replaced by an in-memory PostgREST stub that
// honours the query params the builder sends (select, order, eq./lt. filters,
// Range paging) and THROWS on any inclusive (lte./gte.) cutoff, any row cap
// and any non-GET call, so a regression to `event_date=lte.` fails the build
// itself rather than a downstream assertion.
//
// Contract under test (docs/FIGHT_DNA_CONTRACT.md): as_of_date is EXCLUSIVE.
// The snapshot dated D contains bouts with event_date < D and never a bout
// fought on D. The PBE Algo consumer resolves as_of_date <= event_date and
// relies on that snapshot never containing the target bout.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildFightDna, boutContributes } from './build_fight_dna.mjs';
import { patchBuilderSource } from './repair_historical_snapshots.mjs';
import { latestAsOf } from '../model/features_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILDER_PATH = path.join(__dirname, 'build_fight_dna.mjs');

/* ------------------------------------------------------------- fixture --- */

const D = '2026-09-20';
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const D_MINUS_7 = addDays(D, -7);
const D_MINUS_6 = addDays(D, -6);
const D_PLUS_1 = addDays(D, 1);
const D_PLUS_7 = addDays(D, 7);
const D_PLUS_8 = addDays(D, 8);

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const EV = { before: 'event-d-minus-7', on: 'event-d', after: 'event-d-plus-7' };
const BOUT = { before: 'bout-d-minus-7', on: 'bout-d', after: 'bout-d-plus-7' };

/* F1's significant strikes landed PER ROUND in each bout. Distinct so a metric
 * numerator identifies exactly which bouts leaked into a snapshot:
 *   D-7 only            -> 30
 *   D-7 + D             -> 90
 *   D-7 + D + D+7       -> 210 */
const F1_SIG_PER_ROUND = { [BOUT.before]: 10, [BOUT.on]: 20, [BOUT.after]: 40 };
const F2_SIG_PER_ROUND = 5;
const CAPTURED = '2026-09-01T00:00:00Z';

function fixture() {
  const events = [
    { id: EV.before, name: 'UFC D-7', event_date: D_MINUS_7 },
    { id: EV.on, name: 'UFC D', event_date: D },
    { id: EV.after, name: 'UFC D+7', event_date: D_PLUS_7 },
  ];
  const boutIds = [BOUT.before, BOUT.on, BOUT.after];
  const bouts = events.map((e, i) => ({
    id: boutIds[i], ufcstats_id: null, espn_competition_id: null, event_id: e.id,
    fighter_a_id: F1, fighter_b_id: F2, scheduled_rounds: 3, is_title: false, card_position: 'main', bout_order: 1,
    status: 'complete', model_scope: true, short_notice_days: null, captured_at: CAPTURED, updated_at: CAPTURED,
  }));
  const results = bouts.map((b) => ({
    bout_id: b.id, winner_id: F1, method: 'DEC_UNANIMOUS', method_raw: 'Decision - Unanimous', round: 3, time_sec: 300,
    time_format: '3 Rnd (5-5-5)', result_source: 'espn', has_stats: true, source_url: null, captured_at: CAPTURED,
    stats_source_url: null, stats_captured_at: CAPTURED,
  }));
  const roundStats = [];
  for (const b of bouts) {
    for (const fid of [F1, F2]) {
      for (let round = 1; round <= 3; round++) {
        const landed = fid === F1 ? F1_SIG_PER_ROUND[b.id] : F2_SIG_PER_ROUND;
        roundStats.push({
          bout_id: b.id, fighter_id: fid, round,
          kd: 0, sig_str_landed: landed, sig_str_att: landed * 2, total_str_landed: landed, total_str_att: landed * 2,
          td_landed: 1, td_att: 2, sub_att: 0, rev: 0, ctrl_sec: 30,
          head_landed: landed, head_att: landed * 2, body_landed: 0, body_att: 0, leg_landed: 0, leg_att: 0,
          distance_landed: landed, distance_att: landed * 2, clinch_landed: 0, clinch_att: 0, ground_landed: 0, ground_att: 0,
          source_url: null, captured_at: CAPTURED,
        });
      }
    }
  }
  return {
    ufc_fighters: [
      { id: F1, name: 'Alpha Tester', stance: 'Orthodox' },
      { id: F2, name: 'Bravo Tester', stance: 'Southpaw' },
    ],
    ufc_events: events,
    ufc_bouts: bouts,
    ufc_bout_results: results,
    ufc_bout_round_stats: roundStats,
  };
}

/* ------------------------------------------------------ PostgREST stub --- */

const INCLUSIVE_OPS = new Set(['lte', 'gte']);

/* widenEvents: ignore the lt. filter on ufc_events (simulating a widened
 * events query) so the builder's second gate can be proven on its own. */
function postgrestStub(tables, log, { widenEvents = false } = {}) {
  return async function stubbedFetch(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    log.push({ method, url: url.pathname + url.search });
    if (method !== 'GET') throw new Error(`stub: ${method} ${url.pathname} - a dry run must not write`);
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m || !(m[1] in tables)) throw new Error(`stub: unknown table path ${url.pathname}`);
    const table = m[1];

    let rows = tables[table].map((r) => ({ ...r }));
    let select = null;
    const orders = [];
    for (const [k, v] of url.searchParams) {
      if (k === 'select') { select = v.split(',').map((s) => s.trim()).filter(Boolean); continue; }
      if (k === 'order') {
        for (const part of v.split(',')) {
          const [col, dir = 'asc'] = part.trim().split('.');
          orders.push({ col, desc: dir === 'desc' });
        }
        continue;
      }
      if (k === 'limit' || k === 'offset') throw new Error(`stub: ${k}= in the query string caps Range paging`);
      const op = v.match(/^([a-z]+)\.(.*)$/s);
      if (!op) throw new Error(`stub: unsupported filter ${k}=${v}`);
      const [, name, val] = op;
      if (INCLUSIVE_OPS.has(name)) throw new Error(`stub: inclusive cutoff issued on ${table}: ${k}=${v}`);
      if (widenEvents && table === 'ufc_events' && k === 'event_date') continue;
      rows = rows.filter((r) => {
        if (!(k in r)) throw new Error(`stub: ${table} has no column ${k}`);
        const cell = String(r[k]);
        if (name === 'eq') return cell === val;
        if (name === 'neq') return cell !== val;
        if (name === 'lt') return cell < val;
        if (name === 'gt') return cell > val;
        throw new Error(`stub: unsupported operator ${name}`);
      });
    }
    if (!select) throw new Error(`stub: ${table} query has no select list`);
    if (!orders.length) throw new Error(`stub: ${table} query has no order clause; Range paging would be nondeterministic`);
    for (const { col } of orders) if (!rows.every((r) => col in r)) throw new Error(`stub: ${table} cannot order by ${col}`);
    for (const col of select) if (!rows.every((r) => col in r)) throw new Error(`stub: ${table} has no column ${col}`);

    rows.sort((a, b) => {
      for (const { col, desc } of orders) {
        const x = a[col], y = b[col];
        if (x === y) continue;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        if (c) return desc ? -c : c;
      }
      return 0;
    });
    rows = rows.map((r) => Object.fromEntries(select.map((c) => [c, r[c]])));

    const range = init.headers?.Range;
    const unit = init.headers?.['Range-Unit'];
    if (!range || unit !== 'items') throw new Error(`stub: ${table} request has no items Range header`);
    const [from, to] = range.split('-').map(Number);
    if (from > 0 && from >= rows.length) return new Response('', { status: 416 });
    const page = rows.slice(from, to + 1);
    return new Response(JSON.stringify(page), {
      status: page.length === rows.length ? 200 : 206,
      headers: { 'content-type': 'application/json', 'content-range': `${from}-${from + page.length - 1}/*` },
    });
  };
}

/* Runs a dry build against the stub, capturing every batch handed to writeBatch. */
async function buildAt(asOf, { tables = fixture(), widenEvents = false } = {}) {
  const log = [];
  const captured = {};
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = postgrestStub(tables, log, { widenEvents });
  console.log = () => {};
  try {
    const summary = await buildFightDna({
      supabaseUrl: 'http://stub', serviceKey: 'x', asOf, dry: true,
      onRows: (table, rows) => { captured[table] = rows; },
    });
    return {
      summary, log,
      snapshots: captured.ufc_fighter_dna_snapshots || [],
      features: captured.ufc_fighter_bout_features || [],
      stanceRows: captured.ufc_fighter_stance_splits || [],
    };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

const snapshotOf = (build, fighterId) => build.snapshots.find((s) => s.fighter_id === fighterId);

/* Every metric that carries a numerator/denominator, flattened, so leakage of
 * a later bout into any aggregate shows up, not only the headline ones. */
function allMetrics(snapshot) {
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if ('metric_key' in v && 'sample_bouts' in v) { out.push(v); return; }
    Object.values(v).forEach(walk);
  };
  walk(snapshot);
  return out;
}

/* ---------------------------------------------------------------- tests --- */

test('(d) boutContributes is exclusive on the boundary', () => {
  assert.equal(boutContributes(D_MINUS_7, D), true);
  assert.equal(boutContributes(addDays(D, -1), D), true);
  assert.equal(boutContributes(D, D), false, 'a bout fought ON the as-of date must not contribute');
  assert.equal(boutContributes(D_PLUS_1, D), false);
  assert.equal(boutContributes(D, D_PLUS_1), true, 'the day after, the bout contributes');
  assert.equal(boutContributes(null, D), false);
  assert.equal(boutContributes(undefined, D), false);
  assert.equal(boutContributes('', D), false);
});

test('(a) snapshot dated D contains only the D-7 bout and none of D\'s stats', async () => {
  const build = await buildAt(D);
  assert.equal(build.summary.ok, true);
  assert.equal(build.summary.as_of, D);
  assert.match(String(build.summary.build_run_id), /^dry-/);
  assert.equal(build.summary.feature_rows, 2, 'one feature row per side of the single eligible bout');
  assert.equal(build.summary.snapshots, 2);

  assert.deepEqual(build.features.map((f) => f.bout_id).sort(), [BOUT.before, BOUT.before]);
  assert.ok(build.features.every((f) => f.event_date === D_MINUS_7));

  for (const fid of [F1, F2]) {
    const snap = snapshotOf(build, fid);
    assert.ok(snap, `snapshot for ${fid}`);
    assert.equal(snap.as_of_date, D);
    assert.equal(snap.definition_version, 1, 'bug fix, not a metric change: definition_version stays 1');
    assert.equal(snap.provenance.builder, 'ufc-intelligence/build_fight_dna@v1.3');
    assert.deepEqual(snap.provenance.bouts, [BOUT.before]);
    assert.equal(snap.sample_bouts, 1);
    assert.equal(snap.sample_completed_bouts, 1);
    assert.equal(snap.sample_stat_bouts, 1);
    assert.equal(snap.sample_rounds, 3);
    assert.equal(snap.sample_seconds, 900);
    for (const m of allMetrics(snap)) {
      assert.ok(m.sample_bouts <= 1, `${m.metric_key} sample_bouts ${m.sample_bouts} > 1`);
      assert.ok(m.sample_seconds <= 900, `${m.metric_key} sample_seconds ${m.sample_seconds} > 900`);
      assert.equal(m.as_of_date, D, `${m.metric_key} as_of_date`);
    }
  }

  const f1 = snapshotOf(build, F1);
  assert.equal(f1.metrics.sig_landed_per_min.numerator, 30, 'F1 sig landed = 3 rounds x 10 from the D-7 bout only');
  assert.equal(f1.metrics.sig_landed_per_min.denominator, 900);
  assert.equal(f1.metrics.sig_absorbed_per_min.numerator, 15, 'F2 landed 5 per round in the D-7 bout only');
  assert.equal(f1.metrics.td_landed_per_15.numerator, 3);
  for (const r of ['1', '2', '3']) {
    assert.equal(f1.round_profile.rounds[r].sig_att_per_min.numerator, 20, `round ${r} attempts from the D-7 bout only`);
    assert.equal(f1.round_profile.rounds[r].seconds, 300);
  }
  assert.deepEqual(f1.provenance.record, { w: 1, l: 0, d: 0, nc: 0, appearances: 1 });
  const f2 = snapshotOf(build, F2);
  assert.deepEqual(f2.provenance.record, { w: 0, l: 1, d: 0, nc: 0, appearances: 1 });

  assert.ok(build.stanceRows.length >= 2);
  assert.ok(build.stanceRows.every((r) => r.as_of_date === D && r.appearances === 1));
});

test('(b) snapshot dated D+1 contains D-7 and D, not D+7', async () => {
  const build = await buildAt(D_PLUS_1);
  assert.equal(build.summary.feature_rows, 4);
  const f1 = snapshotOf(build, F1);
  assert.deepEqual(f1.provenance.bouts, [BOUT.before, BOUT.on]);
  assert.equal(f1.sample_bouts, 2);
  assert.equal(f1.sample_seconds, 1800);
  assert.equal(f1.metrics.sig_landed_per_min.numerator, 90, '30 (D-7) + 60 (D)');
  assert.ok(!f1.provenance.bouts.includes(BOUT.after));
  assert.ok(build.features.every((f) => f.bout_id !== BOUT.after));
  assert.deepEqual(f1.provenance.record, { w: 2, l: 0, d: 0, nc: 0, appearances: 2 });
});

test('(c) snapshot dated D+7 excludes the D+7 bout; dated D+8 includes it', async () => {
  const at7 = await buildAt(D_PLUS_7);
  const f1at7 = snapshotOf(at7, F1);
  assert.deepEqual(f1at7.provenance.bouts, [BOUT.before, BOUT.on]);
  assert.equal(f1at7.sample_bouts, 2);
  assert.equal(f1at7.metrics.sig_landed_per_min.numerator, 90);

  const at8 = await buildAt(D_PLUS_8);
  const f1at8 = snapshotOf(at8, F1);
  assert.deepEqual(f1at8.provenance.bouts, [BOUT.before, BOUT.on, BOUT.after]);
  assert.equal(f1at8.sample_bouts, 3);
  assert.equal(f1at8.sample_seconds, 2700);
  assert.equal(f1at8.metrics.sig_landed_per_min.numerator, 210, '30 + 60 + 120');
});

test('(e) the builder never issues an inclusive event_date=lte. query', async () => {
  /* The stub itself rejects lte. - prove that first so a passing build means
   * the guard was live, not absent. */
  const stub = postgrestStub(fixture(), []);
  await assert.rejects(
    stub(`http://stub/rest/v1/ufc_events?select=id&event_date=lte.${D}&order=event_date.asc`, { headers: { Range: '0-999', 'Range-Unit': 'items' } }),
    /inclusive cutoff/,
  );

  const build = await buildAt(D);
  const eventQueries = build.log.filter((e) => e.url.startsWith('/rest/v1/ufc_events?'));
  assert.ok(eventQueries.length >= 1);
  for (const q of eventQueries) {
    assert.ok(q.url.includes(`event_date=lt.${D}`), q.url);
    assert.ok(q.url.includes('order=event_date.asc,id.asc'), `deterministic order for Range paging: ${q.url}`);
  }
  assert.ok(build.log.every((e) => !e.url.includes('lte.')), 'no lte. anywhere');
  assert.ok(build.log.every((e) => e.method === 'GET'), 'dry run issued only reads');
});

test('(e2) boutContributes gates relevantBouts even when the events query is widened', async () => {
  /* The stub returns ALL events regardless of the lt. filter. The only thing
   * standing between the D and D+7 bouts and the snapshot dated D is the
   * boutContributes() filter, so this proves the rule has a second, independent
   * definition point and that it is exclusive. */
  const build = await buildAt(D, { widenEvents: true });
  assert.equal(build.features.length, 2);
  assert.ok(build.features.every((f) => f.bout_id === BOUT.before && f.event_date === D_MINUS_7));
  const f1 = snapshotOf(build, F1);
  assert.deepEqual(f1.provenance.bouts, [BOUT.before]);
  assert.equal(f1.metrics.sig_landed_per_min.numerator, 30);

  const plus1 = snapshotOf(await buildAt(D_PLUS_1, { widenEvents: true }), F1);
  assert.deepEqual(plus1.provenance.bouts, [BOUT.before, BOUT.on]);
});

test('(f) repair script anchors resolve against the current builder and keep exclusive semantics', () => {
  const source = fs.readFileSync(BUILDER_PATH, 'utf8');
  let patched;
  assert.doesNotThrow(() => { patched = patchBuilderSource(source); });
  assert.ok(patched.includes('event_date=lt.${AS_OF}'));
  assert.ok(patched.includes('order=event_date.asc,id.asc'));
  assert.ok(patched.includes('boutContributes(e?.event_date, AS_OF)'));
  assert.ok(patched.includes('f.event_date < snapshotDate'), 'historical loop is exclusive too');
  assert.doesNotMatch(patched, /event_date=lte\./);
  assert.doesNotMatch(patched, /e\.event_date <= AS_OF/);
  assert.doesNotMatch(patched, /event_date <= /, 'no inclusive bout cutoff anywhere in the patched builder');
  assert.ok(patched.includes("build_fight_dna@v1.3-history-repair'"));
  assert.ok(patched.includes(".endsWith('scripts/dna/.history-repair-builder.tmp.mjs')"), 'temp builder CLI guard retargeted');

  /* CRLF checkouts must patch identically. */
  const patchedCrlf = patchBuilderSource(source.replace(/\r?\n/g, '\r\n'));
  assert.equal(patchedCrlf, patched);

  /* A builder that regressed to the inclusive cutoff must be refused. */
  assert.throws(
    () => patchBuilderSource(source.replace('event_date=lt.${AS_OF}&order=event_date.asc,id.asc', 'event_date=lte.${AS_OF}&order=event_date.asc')),
    /exclusive event cutoff/,
  );

  /* The patched builder must still parse. */
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dna-repair-')), 'patched.mjs');
  fs.writeFileSync(tmp, patched, 'utf8');
  try {
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});

test('PBE Algo consumer: latestAsOf(as_of_date <= event_date) never resolves to a snapshot containing the target bout', async () => {
  /* Snapshots dated D-6 (built from the D-7 bout) and D+1 (built from D-7 and
   * D). For a target bout on D the consumer must pick D-6 - a snapshot that
   * cannot contain the D bout - and that snapshot's provenance proves it. */
  const atMinus6 = snapshotOf(await buildAt(D_MINUS_6), F1);
  const atPlus1 = snapshotOf(await buildAt(D_PLUS_1), F1);
  assert.equal(atMinus6.as_of_date, D_MINUS_6);
  assert.deepEqual(atMinus6.provenance.bouts, [BOUT.before]);
  assert.deepEqual(atPlus1.provenance.bouts, [BOUT.before, BOUT.on]);

  const sorted = [atMinus6, atPlus1].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const picked = latestAsOf(sorted, D);
  assert.equal(picked.as_of_date, D_MINUS_6);
  assert.ok(!picked.provenance.bouts.includes(BOUT.on), 'target bout must not be inside its own feature snapshot');

  /* Boundary: a snapshot dated exactly D is eligible (<=) and, being exclusive,
   * still cannot contain the D bout. */
  const atD = snapshotOf(await buildAt(D), F1);
  const withD = [atMinus6, atD, atPlus1].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const pickedD = latestAsOf(withD, D);
  assert.equal(pickedD.as_of_date, D);
  assert.deepEqual(pickedD.provenance.bouts, [BOUT.before]);

  /* Pure form of the same rule. */
  const plain = [{ as_of_date: D_MINUS_6 }, { as_of_date: D_PLUS_1 }];
  assert.equal(latestAsOf(plain, D).as_of_date, D_MINUS_6);
  assert.equal(latestAsOf(plain, addDays(D_MINUS_6, -1)), null);
});

/* ------------------------------------------- v1.3 write hardening (2026-09-24 incident) --- */
// Writable stub: reads of source tables go through the strict read stub; the snapshot / stance tables and the build-run
// table are held in memory so retry, split, resume and reconciliation can be proven without a network.
import { isRetryableWrite } from './build_fight_dna.mjs';

function writableStub(tables, store, { failSnapshotChunksAbove = Infinity, failTimes = Infinity, permanentFailFighter = null, dropSnapshots = false } = {}) {
  const readStub = postgrestStub(tables, []);
  let failures = 0;
  const keyOf = (t, r) => (t === 'ufc_fighter_stance_splits' ? `${r.fighter_id}|${r.as_of_date}|${r.opponent_stance}` : t === 'ufc_fighter_bout_features' ? `${r.fighter_id}|${r.bout_id}` : `${r.fighter_id}|${r.as_of_date}`);
  const timeout = () => new Response('{"code":"57014","message":"canceling statement due to statement timeout"}', { status: 500 });
  return async function (input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    const table = url.pathname.replace('/rest/v1/', '');
    if (table === 'ufc_dna_build_runs') {
      if (method === 'POST') { store.runs.push({ id: `run-${store.runs.length + 1}`, status: 'running' }); return new Response(JSON.stringify([store.runs.at(-1)]), { status: 201 }); }
      if (method === 'PATCH') { Object.assign(store.runs.at(-1), JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    }
    if (method === 'POST') {
      const rows = JSON.parse(init.body);
      if (table === 'ufc_fighter_dna_snapshots') {
        if (permanentFailFighter && rows.some((r) => r.fighter_id === permanentFailFighter)) return timeout();
        if (rows.length > failSnapshotChunksAbove && failures < failTimes) { failures += 1; return timeout(); }
        if (dropSnapshots) return new Response('', { status: 201 });
      }
      store.writes[table] = (store.writes[table] || 0) + rows.length;
      const m = (store.rows[table] = store.rows[table] || new Map());
      for (const r of rows) m.set(keyOf(table, r), r);
      return new Response('', { status: 201 });
    }
    if (table === 'ufc_fighter_dna_snapshots' || table === 'ufc_fighter_stance_splits') {
      const asOf = (url.searchParams.get('as_of_date') || '').replace('eq.', '');
      const [from, to] = String(init.headers?.Range || '0-999').split('-').map(Number);
      const ids = [...new Set([...(store.rows[table] || new Map()).values()].filter((r) => r.as_of_date === asOf).map((r) => r.fighter_id))].sort();
      if (from > 0 && from >= ids.length) return new Response(null, { status: 416 });
      return new Response(JSON.stringify(ids.slice(from, to + 1).map((fighter_id) => ({ fighter_id }))), { status: 200 });
    }
    return readStub(input, init);
  };
}

async function writeBuild(asOf, store, opts = {}, cfg = {}) {
  const realFetch = globalThis.fetch, realLog = console.log, realErr = console.error;
  globalThis.fetch = writableStub(fixture(), store, opts);
  console.log = () => {}; console.error = () => {};
  try { return await buildFightDna({ supabaseUrl: 'http://stub', serviceKey: 'x', asOf, sleep: async () => {}, ...cfg }); }
  finally { globalThis.fetch = realFetch; console.log = realLog; console.error = realErr; }
}
const newStore = () => ({ runs: [], rows: {}, writes: {} });
const AS_OF_W = addDays(D, 8);

test('write hardening: transient 57014 statement timeouts are retried and oversized chunks split; the run still succeeds and reconciles', async () => {
  const store = newStore();
  const summary = await writeBuild(AS_OF_W, store, { failSnapshotChunksAbove: 0, failTimes: 4 });
  assert.equal(summary.ok, true);
  const run = store.runs.at(-1);
  assert.equal(run.status, 'success');
  const w = run.output_counts.writes.ufc_fighter_dna_snapshots;
  assert.ok(w.retries >= 3, `retried (${w.retries})`);
  assert.equal(w.written, w.attempted);
  assert.equal(run.output_counts.reconciliation.complete, true);
  assert.equal(run.output_counts.reconciliation.missing_snapshots, 0);
});

test('write hardening: a row that can never be written fails the run (not success) with counts, and other dates are untouched', async () => {
  const store = newStore();
  store.rows.ufc_fighter_dna_snapshots = new Map([['F1|2026-09-01', { fighter_id: 'F1', as_of_date: '2026-09-01', marker: 'last-known-good' }]]);
  const firstFighter = fixture().ufc_fighters.map((f) => f.id).sort()[0];
  await assert.rejects(() => writeBuild(AS_OF_W, store, { permanentFailFighter: firstFighter }));
  const run = store.runs.at(-1);
  assert.equal(run.status, 'failed');
  assert.ok(run.output_counts.writes.ufc_fighter_dna_snapshots.failed >= 1);
  assert.equal(store.rows.ufc_fighter_dna_snapshots.get('F1|2026-09-01').marker, 'last-known-good', 'a failed run never overwrites another date');
});

test('resume: rows already written for the same as-of date are preserved (not rewritten); the remainder is written and the run reconciles', async () => {
  const store = newStore();
  await writeBuild(AS_OF_W, store);
  const all = [...store.rows.ufc_fighter_dna_snapshots.values()].filter((r) => r.as_of_date === AS_OF_W);
  assert.ok(all.length >= 2);
  const keep = all[0];
  store.rows.ufc_fighter_dna_snapshots = new Map([[`${keep.fighter_id}|${AS_OF_W}`, { ...keep, marker: 'from-interrupted-run' }]]);
  store.rows.ufc_fighter_stance_splits = new Map();
  store.writes = {};
  const summary = await writeBuild(AS_OF_W, store, {}, { resume: true });
  assert.equal(summary.ok, true);
  const run = store.runs.at(-1);
  assert.equal(run.output_counts.preserved.snapshots, 1);
  assert.equal(store.rows.ufc_fighter_dna_snapshots.get(`${keep.fighter_id}|${AS_OF_W}`).marker, 'from-interrupted-run', 'preserved row not rewritten');
  assert.equal(store.writes.ufc_fighter_dna_snapshots, all.length - 1);
  assert.equal(run.output_counts.reconciliation.complete, true);
});

test('reconciliation: a run whose rows do not all land is recorded partial, never success', async () => {
  const store = newStore();
  await assert.rejects(() => writeBuild(AS_OF_W, store, { dropSnapshots: true }), /incomplete/);
  assert.equal(store.runs.at(-1).status, 'partial');
  assert.ok(store.runs.at(-1).output_counts.reconciliation.missing_snapshots > 0);
});

test('retry classification: 57014 / 5xx / 429 / network retry; 4xx client errors do not', () => {
  assert.equal(isRetryableWrite(500, '{"code":"57014"}'), true);
  assert.equal(isRetryableWrite(503, ''), true);
  assert.equal(isRetryableWrite(429, ''), true);
  assert.equal(isRetryableWrite(0, 'fetch failed'), true);
  assert.equal(isRetryableWrite(400, '{"code":"23502"}'), false);
  assert.equal(isRetryableWrite(409, 'conflict'), false);
});
