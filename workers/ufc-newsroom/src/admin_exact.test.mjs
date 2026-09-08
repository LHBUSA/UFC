/* Manual /admin/run semantics, driven through the real HTTP handler.
 *
 * Run: node --test src/admin_exact.test.mjs
 *
 * These go through worker.fetch() rather than planRun() on purpose. The defect
 * they pin was not in the planner — planRun was doing exactly what it was
 * asked. It was in what the route asked for: `?phases=sources` was parsed into
 * `force`, and force was an ADDITION to a normal plan rather than a
 * replacement for one. Production's ledger holds zero ufc-newsroom rows, so
 * every phase read as never having succeeded, so the first careful step of a
 * canary would have planned sources, ingest, write, refresh and sweep and run
 * the entire newsroom against production on its first ever invocation.
 *
 * Testing the planner alone would have missed that, because the planner was
 * not wrong. So every case here is an HTTP request, with an EMPTY ledger,
 * which is the condition that made the bug dangerous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASES } from './coordinator.mjs';

const TOKEN = 'admin-token-for-tests';
const ENV = {
  SUPABASE_URL: 'https://db.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  ADMIN_TRIGGER_TOKEN: TOKEN,
};

/**
 * A world with an EMPTY run ledger, which is production's actual state.
 *
 * Records every phase that executed by watching which tables get counted, and
 * refuses any Anthropic call outright so an accidental model call is a failure
 * rather than a silent cost.
 */
function emptyLedgerWorld({ openRunFails = false } = {}) {
  const seen = { posts: [], gets: [], anthropic: 0, runRowsOpened: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';

    if (u.includes('api.anthropic.com')) {
      seen.anthropic += 1;
      throw new Error('a test must never reach a model');
    }

    const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
    if (method === 'GET') {
      seen.gets.push(table);
      /* Empty ledger: no ufc-newsroom row has ever been written. */
      return {
        ok: true,
        headers: { get: (h) => (h.toLowerCase() === 'content-range' ? '*/0' : null) },
        text: async () => '[]',
        json: async () => [],
      };
    }
    seen.posts.push({ table, method });
    if (table === 'ufc_ingest_runs' && method === 'POST') {
      seen.runRowsOpened += 1;
      if (openRunFails) {
        return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'ledger unavailable' };
      }
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 'run-test-1' }]), json: async () => [{ id: 'run-test-1' }] };
    }
    return { ok: true, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };
  return seen;
}

const post = async (query, env = ENV) => {
  const worker = (await import('./index.js')).default;
  return worker.fetch(
    new Request(`https://w.dev/admin/run${query}`, { method: 'POST', headers: { 'x-pbe-admin-token': TOKEN } }),
    env,
  );
};

/* ---- exact phases, one case per requested combination ------------------- */

for (const phase of PHASES) {
  test(`phases=${phase} runs ${phase} ONLY, on an empty ledger`, async () => {
    emptyLedgerWorld();
    const res = await post(`?phases=${phase}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.planned, [phase],
      `an empty ledger must not drag in every other phase; planned=${JSON.stringify(body.planned)}`);
    assert.deepEqual(body.requested, [phase]);
  });
}

test('phases=sources,sweep runs both, in canonical order, and nothing else', async () => {
  emptyLedgerWorld();
  const body = await (await post('?phases=sweep,sources')).json();
  assert.deepEqual(body.planned, ['sources', 'sweep'],
    'requested order does not override the dependency order phases must run in');
});

test('phases=write,write is one write', async () => {
  emptyLedgerWorld();
  const body = await (await post('?phases=write,write')).json();
  assert.deepEqual(body.planned, ['write']);
});

test('phases=garbage is a client error that runs nothing at all', async () => {
  const seen = emptyLedgerWorld();
  const res = await post('?phases=garbage');
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, 'no_valid_phase');
  assert.deepEqual(body.requested, ['garbage']);
  /* The whole point: a typo costs nothing. Rejected before the lock, before
     the ledger, before a single database read. */
  assert.equal(seen.gets.length, 0, 'no database read');
  assert.equal(seen.posts.length, 0, 'no database write');
  assert.equal(seen.runRowsOpened, 0, 'no run row opened');
  assert.equal(seen.anthropic, 0, 'no model call');
});

test('phases= (present but empty) is also an error, not "run everything"', async () => {
  const seen = emptyLedgerWorld();
  const res = await post('?phases=');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'no_valid_phase');
  assert.equal(seen.gets.length + seen.posts.length, 0, 'zero work');
});

test('a valid phase alongside an unknown one runs the valid one and names the other', async () => {
  emptyLedgerWorld();
  const body = await (await post('?phases=sweep,nonsense')).json();
  assert.deepEqual(body.planned, ['sweep']);
  assert.deepEqual(body.unknown_ignored, ['nonsense']);
});

test('no phases parameter keeps the ordinary catch-up planner', async () => {
  /* Deliberately different, and the difference is the presence of the
     parameter rather than its contents. On an empty ledger every phase is
     overdue, which is correct for an unattended run and exactly wrong for a
     canary — which is why the canary must pass ?phases=. */
  emptyLedgerWorld();
  const body = await (await post('')).json();
  assert.deepEqual(body.planned, PHASES, 'catch-up still plans everything overdue');
  assert.equal(body.requested, null, 'and reports that nothing was explicitly requested');
});

/* ---- the ledger must fail closed ---------------------------------------- */

test('a run whose ledger row cannot be opened does no work whatsoever', async () => {
  /* The ledger is an input, not a log: catch-up reads it to decide what is
     overdue and the fallback guard reads it to decide whether a run is in
     flight. Work with no row is invisible to both, so it must not happen. */
  const seen = emptyLedgerWorld({ openRunFails: true });
  const res = await post('?phases=ingest,write');
  const body = await res.json();

  assert.equal(body.status, 'ledger_open_failed');
  assert.deepEqual(body.phases, [], 'no phase ran');
  assert.deepEqual(body.planned, ['ingest', 'write'], 'and it still reports what it would have run');
  assert.equal(seen.runRowsOpened, 1, 'it tried exactly once');
  assert.equal(seen.anthropic, 0, 'no model was called');

  /* Nothing may have been written anywhere except the failed attempt itself. */
  const otherWrites = seen.posts.filter((p) => p.table !== 'ufc_ingest_runs');
  assert.deepEqual(otherWrites, [], `phases wrote to ${otherWrites.map((w) => w.table).join(',')}`);
});

test('a failure to CLOSE the row keeps the result but is not silent', async () => {
  /* The asymmetry with opening is deliberate. Work that already happened
     cannot be un-happened, so losing the result would be a second failure on
     top of the first. */
  const warnings = [];
  const realError = console.error;
  console.error = (...a) => warnings.push(a.join(' '));
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method || 'GET';
      const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
      if (method === 'PATCH') throw new Error('close failed');
      if (method === 'POST' && table === 'ufc_ingest_runs') {
        return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 'run-1' }]) };
      }
      return {
        ok: true,
        headers: { get: (h) => (h.toLowerCase() === 'content-range' ? '*/0' : null) },
        text: async () => '[]', json: async () => [],
      };
    };
    const body = await (await post('?phases=sweep')).json();
    assert.equal(body.run_id, 'run-1');
    assert.ok(['success', 'partial'].includes(body.status), 'the completed phase is still reported');
    assert.ok(body.phases.includes('sweep'), 'and the phase that ran is still named');
    assert.ok(warnings.some((w) => /could not close run/i.test(w)), 'and the failure was logged loudly');
  } finally { console.error = realError; }
});
