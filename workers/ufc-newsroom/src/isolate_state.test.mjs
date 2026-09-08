/* State that must not survive an invocation. Run: node --test src/isolate_state.test.mjs
 *
 * A GitHub Action is a process: it imports, runs once, exits. A Worker is an
 * isolate: it imports once and then serves invocations for as long as
 * Cloudflare keeps it warm — hours, across midnights, across cron slots. Every
 * module-scope value computed from a clock, an argv or an env is therefore
 * computed once and then frozen for all of them.
 *
 * The writer had `const TODAY = new Date().toISOString().slice(0, 10)` at
 * module scope. In a process that is correct. In an isolate loaded at 23:58 it
 * means that from 00:00 the writer filters upcoming events against yesterday —
 * so a card that has already happened stays in the preview set, and the card
 * that just finished is not yet eligible for a results story. Nothing errors.
 * The archive simply drifts a day behind and stays there until the isolate is
 * recycled.
 *
 * These tests import each module ONCE and invoke it twice, on opposite sides
 * of a UTC midnight, in that one module instance. If a clock is ever hoisted
 * back to module scope, the second invocation reports the first day's date and
 * these fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveOptions as writerOptions, parseCliOptions as writerCli } from '../../../scripts/news/write_articles.mjs';
import { resolveOptions as ingestOptions, parseCliOptions as ingestCli } from '../../../scripts/news/ingest_news.mjs';
import { resolveOptions as deskOptions, parseCliOptions as deskCli } from '../../../scripts/news/polish_world_class.mjs';

/* 23:58:00Z and 00:02:00Z the next day: four minutes apart, two dates. */
const BEFORE = Date.parse('2026-09-08T23:58:00Z');
const AFTER = Date.parse('2026-09-09T00:02:00Z');

test('the writer computes its date per invocation, not per import', () => {
  const first = writerOptions({ now: BEFORE });
  const second = writerOptions({ now: AFTER });

  assert.equal(first.today, '2026-09-08');
  assert.equal(second.today, '2026-09-09', 'the second invocation must be the second day');
  assert.notEqual(first.today, second.today, 'a module-scope TODAY would make these equal');
});

test('a third invocation is not pinned to either of the first two', () => {
  /* Guards the subtler shape of the same bug: caching on first call instead of
   * at import. That would pass a two-invocation test and still be wrong. */
  const days = [BEFORE, AFTER, Date.parse('2026-09-10T12:00:00Z')].map((n) => writerOptions({ now: n }).today);
  assert.deepEqual(days, ['2026-09-08', '2026-09-09', '2026-09-10']);
});

test('ingest computes its freshness cutoff per invocation', () => {
  const first = ingestOptions({ now: BEFORE });
  const second = ingestOptions({ now: AFTER });
  assert.equal(second.now - first.now, AFTER - BEFORE, 'the cutoff moves with the invocation');

  const cutoffOf = (o) => new Date(o.now - o.maxAgeDays * 86400e3).toISOString().slice(0, 10);
  assert.equal(cutoffOf(first), '2026-08-25');
  assert.equal(cutoffOf(second), '2026-08-26', 'a stuck cutoff would re-admit a day of stale items forever');
});

test('the editorial desk computes its window per invocation', () => {
  const first = deskOptions({ now: BEFORE, recentHours: 24 });
  const second = deskOptions({ now: AFTER, recentHours: 24 });
  const sinceOf = (o) => new Date(o.now - o.recentHours * 3600e3).toISOString();
  assert.equal(sinceOf(first), '2026-09-07T23:58:00.000Z');
  assert.equal(sinceOf(second), '2026-09-08T00:02:00.000Z');
});

test('options are read from the argument, never from a mutated process.argv', () => {
  /* The exact mechanism the Worker used to rely on. Setting argv after import
   * cannot change anything, which is why it must not be how options travel. */
  const saved = process.argv;
  try {
    process.argv = ['node', 'worker-phase', '--llm', '--dry-run', '--limit', '3'];
    const fromArgv = writerOptions({ now: BEFORE });
    assert.equal(fromArgv.llm, false, 'mutating process.argv must not reach into the writer');
    assert.equal(fromArgv.dry, false);
    assert.equal(fromArgv.limit, 0);

    const explicit = writerOptions({ now: BEFORE, llm: true, dry: true, limit: 3 });
    assert.equal(explicit.llm, true, 'the argument is the only channel that works');
    assert.equal(explicit.dry, true);
    assert.equal(explicit.limit, 3);
  } finally { process.argv = saved; }
});

/* ---- CLI parity: the flags must still mean exactly what they meant ------- */

test('the writer CLI parses every flag to the same value the old constants held', () => {
  const none = writerCli([]);
  assert.deepEqual(
    { dry: none.dry, llm: none.llm, force: none.force, print: none.print, limit: none.limit, event: none.event, types: none.types },
    { dry: false, llm: false, force: false, print: false, limit: 0, event: '', types: 'preview,results,external,card_change' },
    'no flags must reproduce the previous defaults exactly',
  );

  const all = writerCli(['--dry-run', '--llm', '--force', '--print', '--limit', '5', '--event', 'UFC 300', '--types', 'preview,results']);
  assert.equal(all.dry, true);
  assert.equal(all.llm, true);
  assert.equal(all.force, true);
  assert.equal(all.print, true);
  assert.equal(all.limit, 5);
  assert.equal(all.event, 'ufc 300', '--event was lowercased before comparison, and still is');
  assert.deepEqual([...writerOptions(all).types], ['fight_preview', 'results']);

  /* The alias table the old parser had, unchanged. */
  assert.deepEqual([...writerOptions({ types: 'previews,result,cardchange' }).types],
    ['fight_preview', 'results', 'card_change']);
  assert.deepEqual([...writerOptions({ types: 'nonsense' }).types], [], 'an unknown type is dropped, not defaulted');
});

test('the ingest and desk CLIs parse to their previous defaults', () => {
  assert.deepEqual(ingestCli([]), { dry: false, relink: false, maxAgeDays: 14 });
  assert.deepEqual(ingestCli(['--dry-run', '--relink', '--max-age-days', '3']), { dry: true, relink: true, maxAgeDays: 3 });

  assert.deepEqual(deskCli([]), { limit: 30, recentHours: 720, force: false, dry: false });
  const d = deskCli(['--limit', '10', '--recent-hours', '48', '--force', '--dry-run']);
  assert.deepEqual(d, { limit: 10, recentHours: 48, force: true, dry: true });
  assert.equal(deskOptions(d).allowCopilot, false, 'the Copilot fallback is opt-in, and only the CLI opts in');
});

/* ---- the property, checked against the source rather than one instance ---- */

/**
 * Walk the Worker's real import graph from its entry module.
 *
 * Computed rather than listed. A hardcoded set of files would go stale the
 * moment the Worker imported something new, and the gap would be invisible:
 * the test would keep passing while no longer covering the module that had
 * just been added.
 */
function workerImportGraph() {
  const entry = new URL('./index.js', import.meta.url);
  const seen = new Set();
  const stack = [entry.href];
  while (stack.length) {
    const href = stack.pop();
    if (seen.has(href)) continue;
    seen.add(href);
    let src;
    try { src = readFileSync(new URL(href), 'utf8'); } catch { continue; }
    const specs = [
      ...src.matchAll(/from\s+'([^']+)'/g),
      ...src.matchAll(/import\('([^']+)'\)/g),
    ].map((m) => m[1]).filter((m) => m.startsWith('.'));
    for (const spec of specs) stack.push(new URL(spec, href).href);
  }
  return seen;
}

test('no module the Worker imports computes a clock, an argv or an env at module scope', () => {
  /* An assertion about the shape of the code, because the failure it guards is
   * invisible at runtime until an isolate has been warm long enough.
   *
   * Scoped to what the WORKER actually imports, not to every file in
   * scripts/news/. Those are two different properties and only one of them is
   * about this Worker: a CLI-only tool may read process.argv at module scope
   * because it runs once per process and exits, while a module inside a
   * long-lived isolate may not, because the value it captured on first import
   * is then served to every later invocation. Asserting the CLI property over
   * the whole directory would fail on tools that are behaving correctly, and
   * the pressure would be to weaken the assertion rather than aim it. */
  const graph = workerImportGraph();
  const offenders = [];

  for (const href of graph) {
    if (href.endsWith('.test.mjs')) continue;
    const file = href.split('/').pop();
    let src;
    try { src = readFileSync(new URL(href), 'utf8'); } catch { continue; }
    let depth = 0;
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      if (depth === 0 && /^(export\s+)?(const|let|var)\s/.test(line)) {
        /* isCli reads process.argv[1], the entry-point path. That genuinely
         * does not change for the life of a process or an isolate, and it is
         * the CLI self-execution guard every one of these files needs. */
        const isCliGuard = /^(export\s+)?const isCli\s*=/.test(line);
        /* A declaration that assigns a FUNCTION defers its body to call time:
         * `const nowIso = () => new Date().toISOString()` evaluates nothing at
         * import, so only what precedes the arrow or the `function` keyword is
         * module scope. Without this the scanner cannot tell a captured value
         * from a deferred one, and the pressure would be to delete the check.
         */
        const fnAt = line.search(/=>|\bfunction\b/);
        const evaluatedNow = fnAt >= 0 ? line.slice(0, fnAt) : line;
        if (!isCliGuard && /(new Date\(\)|Date\.now\(\)|process\.argv|process\.env)/.test(evaluatedNow)) {
          offenders.push(`${file}: ${line.slice(0, 90)}`);
        }
      }
      depth += (raw.match(/[{(]/g) || []).length - (raw.match(/[})]/g) || []).length;
      if (depth < 0) depth = 0;
    }
  }

  assert.deepEqual(offenders, [], `module-scope runtime state reachable from the Worker:
${offenders.join('\n')}`);
});

test('the graph actually covers the newsroom, and excludes CLI-only tools', () => {
  /* Two failures this catches. If the walker silently resolved nothing the
   * test above would pass vacuously, so the modules that carry the editorial
   * product must be present by name. And the CLI-only tools must be absent:
   * copilot_compat.mjs and release_safe_reviews.mjs legitimately read
   * process.argv at module scope, so if one of them ever enters the Worker's
   * graph the assertion above starts covering it and fails - which is the
   * correct outcome, not a gap. */
  const names = [...workerImportGraph()].map((h) => h.split('/').pop());
  for (const required of ['write_articles.mjs', 'ingest_news.mjs', 'polish_world_class.mjs', 'seed_sources.mjs', 'lib.mjs', 'anthropic.mjs']) {
    assert.ok(names.includes(required), `${required} must be in the Worker's import graph`);
  }
  for (const cliOnly of ['copilot_compat.mjs', 'copilot_provider_canary.mjs', 'release_safe_reviews.mjs']) {
    assert.ok(!names.includes(cliOnly), `${cliOnly} is a CLI tool and must not be imported by the Worker`);
  }
});

test('importing a news module writes nothing and calls nothing', async () => {
  /* seed_sources.mjs and polish_world_class.mjs both used to call main() at
   * module scope with no CLI guard. Importing either — which is exactly what
   * the Worker does — would have verified feeds, disabled sources and patched
   * published articles as a side effect of loading the file. */
  const real = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = async (u) => { touched += 1; throw new Error(`import reached the network: ${u}`); };
  try {
    await import('../../../scripts/news/seed_sources.mjs');
    await import('../../../scripts/news/polish_world_class.mjs');
    await import('../../../scripts/news/ingest_news.mjs');
    await import('../../../scripts/news/write_articles.mjs');
    assert.equal(touched, 0, 'importing the newsroom must reach neither the database nor a model');
  } finally { globalThis.fetch = real; }
});
