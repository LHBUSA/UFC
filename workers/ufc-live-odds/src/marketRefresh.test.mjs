// node src/marketRefresh.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notifyMarketRefresh } from './marketRefresh.mjs';

const calls = [];
const ok = { refresh: async (args) => { calls.push(args); return { refused: null, bouts: 12, predictions: 10, refreshed: 10, results: { refreshed: 10 }, errors: [], finished_at: 'x' }; } };

/* Sends identity only, reports the outcome. */
const r = await notifyMarketRefresh(ok, { runId: 10, observedAt: '2026-09-15T18:57:09.217Z', snapshotRows: 132 });
assert.deepEqual(calls, [{ runId: 10, observedAt: '2026-09-15T18:57:09.217Z' }], 'no price, probability or edge crosses the binding');
assert.equal(r.notified, true);
assert.equal(r.refreshed, 10);

/* Never throws: missing binding, nothing written, error, timeout. */
assert.equal((await notifyMarketRefresh(undefined, { runId: 10, snapshotRows: 132 })).reason, 'no_binding');
assert.equal((await notifyMarketRefresh(ok, { runId: 10, snapshotRows: 0 })).reason, 'nothing_written');
assert.equal((await notifyMarketRefresh({ refresh: async () => { throw new Error('algo down'); } }, { runId: 10, snapshotRows: 5 })).error, 'algo down');
const slow = await notifyMarketRefresh({ refresh: () => new Promise(() => {}) }, { runId: 10, snapshotRows: 5 }, { timeoutMs: 50 });
assert.equal(slow.notified, false);
assert.match(slow.error, /timed out/);

/* Wiring: the capture is finalized as success BEFORE the notification, only the prefight lane notifies, and the notification is caught. */
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const fin = src.indexOf('await finalize(summary);');
const note = src.indexOf('notifyMarketRefresh(env.ALGO_MARKET');
assert.ok(fin > 0 && note > fin, 'notify only after the successful run row is written');
assert.ok(src.slice(src.indexOf('async function prefightTick'), note).includes('prefightTick'), 'called from the prefight lane');
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(toml, /\[\[services\]\]\s*\nbinding = "ALGO_MARKET"\s*\nservice = "ufc-algo"\s*\nentrypoint = "MarketRefresh"/);
console.log('marketRefresh.mjs: OK');
