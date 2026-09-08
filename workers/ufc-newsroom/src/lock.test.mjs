/* What the concurrency guard actually guarantees. Run: node --test src/lock.test.mjs
 *
 * The claim being tested is deliberately narrower than the one this Worker
 * used to make in its comments. There are two mechanisms and they protect two
 * different things:
 *
 *   duplicate ROWS       impossible in every configuration, by unique index.
 *   duplicate EXECUTION  impossible with the Durable Object; merely unlikely
 *                        with the advisory ledger lock, which is a read
 *                        followed by an insert over two round trips.
 *
 * The second distinction is not pedantry. A constraint rejects the losing
 * INSERT after the losing writer has already built its drafts and paid
 * Anthropic for its rewrites. Only excluding the second run prevents the
 * second bill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NewsroomLock, acquire, release, DEFAULT_TTL_MS, MANUAL_DEADLINE_MS } from './lock.mjs';
import { CONFLICT_TARGETS } from './supabase.mjs';
import { findActiveRun, STALE_RUN_MINUTES } from './runlog.mjs';
import { run } from './index.js';

/** An in-process stand-in for the Durable Object namespace: one object, real
 *  class, storage in a Map. The runtime's serialisation is what makes the real
 *  thing atomic; the class logic is what these tests check. */
function fakeNamespace() {
  const store = new Map();
  const ctx = {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
  const instance = new NewsroomLock(ctx);
  return {
    idFromName: () => 'newsroom',
    get: () => ({ fetch: (url, init) => instance.fetch(new Request(url, init)) }),
  };
}

const envWithLock = () => ({ SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k', NEWSROOM_LOCK: fakeNamespace() });

/* ---- the durable guard -------------------------------------------------- */

test('a second run cannot start while the first holds the lock', async () => {
  const env = envWithLock();
  const now = Date.parse('2026-09-08T12:00:00Z');

  const first = await acquire(env, { now });
  assert.equal(first.acquired, true);
  assert.equal(first.kind, 'durable');

  const second = await acquire(env, { now: now + 1000 });
  assert.equal(second.acquired, false, 'the second run must stand down, not proceed');
  assert.equal(second.holder, first.token, 'and it can say who holds it');
});

test('the lock is released when the run finishes, so the next run proceeds', async () => {
  const env = envWithLock();
  const now = Date.parse('2026-09-08T12:00:00Z');

  const first = await acquire(env, { now });
  await release(env, first.token, { now: now + 60000 });

  const second = await acquire(env, { now: now + 61000 });
  assert.equal(second.acquired, true, 'a released lock does not block anyone');
  assert.equal(second.stole, false, 'and taking it is not a recovery');
});

test('a crashed run does not lock the newsroom forever', async () => {
  /* A Worker that is CPU-killed or times out never releases. Without a TTL one
   * crash would stop the newsroom permanently, which is a worse failure than
   * the one the lock exists to prevent. */
  const env = envWithLock();
  const crashed = Date.parse('2026-09-08T12:00:00Z');
  await acquire(env, { now: crashed });

  const tooSoon = await acquire(env, { now: crashed + DEFAULT_TTL_MS - 1000 });
  assert.equal(tooSoon.acquired, false, 'still inside the TTL, the holder is presumed alive');

  const later = await acquire(env, { now: crashed + DEFAULT_TTL_MS + 1000 });
  assert.equal(later.acquired, true, 'past the TTL the newsroom recovers on its own');
  assert.equal(later.stole, true, 'and records that it broke a dead lock');
});

test('a run that overran its TTL cannot release its successor’s lock', async () => {
  const env = envWithLock();
  const t0 = Date.parse('2026-09-08T12:00:00Z');
  const slow = await acquire(env, { now: t0 });
  const next = await acquire(env, { now: t0 + DEFAULT_TTL_MS + 1000 });
  assert.equal(next.acquired, true);

  const r = await release(env, slow.token, { now: t0 + DEFAULT_TTL_MS + 2000 });
  assert.equal(r.released, false, 'only the holder may release');

  const third = await acquire(env, { now: t0 + DEFAULT_TTL_MS + 3000 });
  assert.equal(third.acquired, false, 'the successor still holds it');
});

test('without the binding the guard reports itself absent rather than pretending', async () => {
  const r = await acquire({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' }, {});
  assert.equal(r.kind, 'none');
  assert.equal(r.acquired, false);
  assert.match(r.reason, /not configured/, 'the caller must be able to tell "no lock" from "lock held"');
});

/* ---- the fallback, and the honest limit of it --------------------------- */

test('the advisory ledger lock stops a sequential overlap and admits it is racy', async () => {
  const running = [{ id: 'run-1', started_at: new Date(Date.parse('2026-09-08T11:55:00Z')).toISOString(), status: 'running' }];
  const sb = { select: async () => running };
  const active = await findActiveRun(sb, Date.parse('2026-09-08T12:00:00Z'));
  assert.equal(active.id, 'run-1', 'a run already recorded as running is seen');
  assert.equal(active.age_minutes, 5);

  /* And the part that is NOT guaranteed: the check is a SELECT, so two runs
   * that both read before either inserts both see nothing. This asserts the
   * shape of the limitation so the comment above it cannot quietly become a
   * stronger claim than the code. */
  const empty = { select: async () => [] };
  const a = await findActiveRun(empty, Date.now());
  const b = await findActiveRun(empty, Date.now());
  assert.equal(a, null);
  assert.equal(b, null, 'two simultaneous readers both see an idle newsroom — this is why it is advisory');
});

test('a stale ledger row is ignored on the same terms as a stale lock', async () => {
  const old = [{ id: 'run-dead', started_at: new Date(Date.now() - (STALE_RUN_MINUTES + 5) * 60000).toISOString(), status: 'running' }];
  assert.equal(await findActiveRun({ select: async () => old }, Date.now()), null);
});

/* ---- what the database guarantees regardless -------------------------- */

test('the tables that must not accept a duplicate name their real unique index', () => {
  /* PostgREST infers ON CONFLICT from the primary key unless on_conflict says
   * otherwise, and both tables have a surrogate uuid pk that can never
   * collide. Naming the wrong target is indistinguishable from naming the
   * right one until the first duplicate arrives in production. */
  assert.equal(CONFLICT_TARGETS.ufc_news_items, 'fingerprint');
  assert.equal(CONFLICT_TARGETS.ufc_articles, 'slug');
});

test('concurrent ingests and concurrent writers cannot create duplicate rows', async () => {
  /* Two runs racing on the same content: each sends its upsert, both name the
   * unique index, so the database keeps one row and ignores the other. This
   * holds whether or not the lock was in force — which is exactly why the
   * constraints are not removed once the Durable Object exists. */
  const { Supabase } = await import('./supabase.mjs');
  const seen = [];
  const real = globalThis.fetch;
  const stored = new Map();

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const table = u.split('/rest/v1/')[1].split('?')[0];
    if ((init.method || 'GET') === 'GET') {
      return { ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `0-0/${stored.size}` : null) }, text: async () => '[]', json: async () => [] };
    }
    seen.push(u);
    for (const row of JSON.parse(init.body)) stored.set(row.fingerprint ?? row.slug, row);
    return { ok: true, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };

  try {
    const sb = new Supabase({ SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const item = [{ fingerprint: 'fp-1', url: 'https://example.invalid/a', title: 'One story' }];
    await Promise.all([
      sb.insertIgnoringDuplicates('ufc_news_items', item),
      sb.insertIgnoringDuplicates('ufc_news_items', item),
    ]);
    assert.equal(stored.size, 1, 'two concurrent ingests of one story leave one row');
    for (const u of seen) {
      assert.match(u, /on_conflict=fingerprint/, 'every upsert names the unique index, not the primary key');
      assert.ok(!/on_conflict=id/.test(u));
    }
  } finally { globalThis.fetch = real; }
});

/* ---- lease boundary, and release on the fail-closed path ----------------- */

test('the lease expires exactly at its TTL, and a dead holder is recoverable', async () => {
  /* The boundary matters in both directions. One second early and a crashed
     run keeps the newsroom locked for longer than the lease promises; one
     second late and a live run can be stolen from underneath itself. */
  const env = envWithLock();
  const t0 = Date.parse('2026-09-08T12:00:00Z');
  const first = await acquire(env, { now: t0 });
  assert.equal(first.acquired, true);

  const justInside = await acquire(env, { now: t0 + DEFAULT_TTL_MS - 1000 });
  assert.equal(justInside.acquired, false, 'a live holder is not stolen from');
  assert.equal(justInside.stole, undefined);

  const justOutside = await acquire(env, { now: t0 + DEFAULT_TTL_MS + 1000 });
  assert.equal(justOutside.acquired, true, 'a dead holder is recoverable');
  assert.equal(justOutside.stole, true, 'and the takeover is reported, not silent');
  assert.notEqual(justOutside.token, first.token, 'the new holder gets its own token');
});

test('the scheduled ceiling sits under the lease, and the manual deadline under that', async () => {
  /* The whole reason a manual deadline exists. Cloudflare caps a cron
     invocation at 15 minutes, which is already inside the 20-minute lease, so
     a scheduled run is protected by the platform for its entire possible life.
     An HTTP invocation has no such cap, so index.js bounds it instead. */
  const CLOUDFLARE_SCHEDULED_MAX_MS = 15 * 60 * 1000;
  assert.ok(CLOUDFLARE_SCHEDULED_MAX_MS < DEFAULT_TTL_MS,
    'a scheduled run can never outlive its own lease');
  assert.ok(MANUAL_DEADLINE_MS < CLOUDFLARE_SCHEDULED_MAX_MS,
    'and a manual run is bounded more tightly still');
  assert.ok(DEFAULT_TTL_MS - MANUAL_DEADLINE_MS >= 5 * 60 * 1000,
    'with real margin for a phase already in flight, since the deadline is only checked between phases');
});

test('a run that fails to open its ledger row still releases the lock', async () => {
  /* Otherwise the newsroom is locked for a full lease by a run that did
     nothing at all — the failure compounding itself. */
  const env = envWithLock();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
    if (method === 'POST' && table === 'ufc_ingest_runs') {
      return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'ledger down' };
    }
    return {
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === 'content-range' ? '*/0' : null) },
      text: async () => '[]', json: async () => [],
    };
  };
  const t0 = Date.parse('2026-09-08T12:00:00Z');
  const res = await run(env, { cron: null, invoked: 'manual', force: ['ingest'], exact: true, now: t0 });
  assert.equal(res.status, 'ledger_open_failed');
  assert.deepEqual(res.phases, []);

  /* The proof: the very next run acquires cleanly, with no takeover. */
  const next = await acquire(env, { now: t0 + 1000 });
  assert.equal(next.acquired, true, 'the lock was released');
  assert.notEqual(next.stole, true, 'and released properly rather than expiring');
});
