/* The ten-minute pass. Run: node --test scripts/status/lib/status_pass.test.mjs
 *
 * The load-bearing test here is the import-graph one. "This does not call a
 * model" is the kind of promise that is true when written and false two
 * refactors later, and the failure is expensive in a way nobody notices: a
 * status check running six times an hour that quietly starts paying for
 * article rewrites costs money continuously and looks like it is working.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { runStatusPass, resolveOptions, parseCliOptions } from '../status_pass.mjs';

/* ================= the boundary ================= */

/** Walk static imports from an entry file and return every module reached. */
function importGraph(entryUrl) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/^\s*import\s[\s\S]*?from\s+['"](\.[^'"]+)['"]/gm)) {
      walk(resolvePath(dirname(file), m[1]));
    }
  };
  walk(fileURLToPath(entryUrl));
  return [...seen];
}

test('the status pass can never reach the article writer or a model', () => {
  const graph = importGraph(new URL('../status_pass.mjs', import.meta.url));
  const banned = ['write_articles.mjs', 'polish_world_class.mjs', 'anthropic.mjs'];
  for (const file of graph) {
    for (const b of banned) {
      assert.ok(!file.endsWith(b), `status_pass reaches ${b} — a ten-minute job must not touch publication`);
    }
  }
  /* And no module in the graph opens its own connection to a model. */
  for (const file of graph) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('api.anthropic.com'), `${file} contains a model endpoint`);
  }
  /* Sanity: the walk actually found the modules it should have, so a broken
   * walker cannot pass this test by finding nothing. */
  assert.ok(graph.some((f) => f.endsWith('collect_status_events.mjs')), 'the graph must include the collector');
  assert.ok(graph.some((f) => f.endsWith('lifecycle_pass.mjs')), 'and the lifecycle');
  assert.ok(graph.some((f) => f.endsWith('extract.mjs')), 'and the extractor');
  /* Ingest is injected, not imported — see status_pass.mjs. That is also why
   * importing this module cannot start a live ingest. */
  assert.ok(!graph.some((f) => f.endsWith('ingest_news.mjs')),
    'ingest_news self-executes on import on this branch; reaching it would ingest on load');
});

/* ================= independent fail-safety ================= */

/** Stub the three steps so the pass's own containment is what is under test. */
function harness({ ingestThrows = false, collectThrows = false, lifecycleThrows = false } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.anthropic.com')) throw new Error('a status pass must never call a model');
    /* ingest reads sources first; an empty list makes it return early. */
    if (u.includes('ufc_news_sources') && ingestThrows) throw new Error('feed host unreachable');
    if (u.includes('ufc_news_items') && collectThrows) throw new Error('news read failed');
    if (u.includes('ufc_fighter_status_events') && lifecycleThrows) throw new Error('status read failed');
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => '[]',
      json: async () => [],
    };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const OPTS = { write: false, now: Date.parse('2026-09-08T12:00:00Z') };

test('a clean pass runs all three steps and reports success', async () => {
  const h = harness();
  try {
    const r = await runStatusPass(ENV, { ...OPTS, ingestFn: async () => {} });
    assert.equal(r.status, 'success');
    assert.equal(r.steps.ingest.ok, true);
    assert.equal(r.steps.collect.ok, true);
    assert.equal(r.steps.lifecycle.ok, true);
    assert.equal(h.calls.some((c) => c.includes('anthropic')), false, 'no model was contacted');
  } finally { h.restore(); }
});

test('a failed ingest does not stop extraction or the lifecycle', async () => {
  /* The point of separate containment: a dead feed host must not mean the
   * table stops ageing and stale withdrawals stay current. */
  const h = harness();
  try {
    const r = await runStatusPass(ENV, { ...OPTS, ingestFn: async () => { throw new Error('feed host unreachable'); } });
    assert.equal(r.status, 'partial');
    assert.equal(r.steps.ingest.ok, false);
    assert.equal(r.steps.collect.ok, true, 'extraction still runs over what is already stored');
    assert.equal(r.steps.lifecycle.ok, true);
    assert.equal(r.failures[0].step, 'ingest');
  } finally { h.restore(); }
});

test('a failed extraction does not stop the lifecycle', async () => {
  const h = harness({ collectThrows: true });
  try {
    const r = await runStatusPass(ENV, { ...OPTS, ingestFn: async () => {} });
    assert.equal(r.steps.collect.ok, false);
    assert.equal(r.steps.lifecycle.ok, true, 'a bad regex must not let a stale claim survive');
  } finally { h.restore(); }
});

test('every step failing is reported as failed, not as a quiet success', async () => {
  const h = harness({ collectThrows: true, lifecycleThrows: true });
  try {
    const r = await runStatusPass(ENV, { ...OPTS, ingestFn: async () => { throw new Error('down'); } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failures.length, 3);
  } finally { h.restore(); }
});

/* ================= options ================= */

test('an absent ingest capability is reported, never silently skipped', async () => {
  /* The difference between a ten-minute SLA and a ten-minute job reading a
   * thirty-minute table has to be visible in the run record. */
  const h = harness();
  try {
    const r = await runStatusPass(ENV, OPTS);
    assert.equal(r.steps.ingest.available, false);
    assert.match(r.steps.ingest.note, /freshness is bounded/);
    assert.equal(r.status, 'degraded',
      'a pass that cannot meet its freshness guarantee must not report success');
    assert.equal(r.failures.length, 0, 'but it is not a failure either — the other two steps worked');
  } finally { h.restore(); }
});

test('the pass is a dry run unless writing is asked for', async () => {
  const h = harness();
  try {
    const r = await runStatusPass(ENV, OPTS);
    assert.equal(r.wrote, false);
  } finally { h.restore(); }
  assert.equal(resolveOptions({}).write, false);
  assert.equal(parseCliOptions([]).write, false);
  assert.equal(parseCliOptions(['--write']).write, true);
});

test('ingest and lifecycle can each be turned off for a caller that owns them', async () => {
  /* The newsroom may prefer to keep ingest on its own phase; the pass must
   * then still extract and age without duplicating a fetch. */
  const h = harness();
  try {
    const r = await runStatusPass(ENV, { ...OPTS, ingest: false, lifecycle: false });
    assert.equal(r.steps.ingest, undefined);
    assert.equal(r.steps.lifecycle, undefined);
    assert.equal(r.steps.collect.ok, true);
  } finally { h.restore(); }
  assert.equal(parseCliOptions(['--no-ingest']).ingest, false);
  assert.equal(parseCliOptions([]).ingest, true);
});

test('the window is bounded so a misconfigured caller cannot scan the archive', () => {
  assert.equal(resolveOptions({ sinceHours: 100000 }).sinceHours, 24 * 7);
  assert.equal(resolveOptions({ sinceHours: 0 }).sinceHours, 6);
  assert.equal(resolveOptions({ sinceHours: -5 }).sinceHours, 6);
});
