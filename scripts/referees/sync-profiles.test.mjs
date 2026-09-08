/**
 * Proves --dry-run writes nothing, and that a misspelt flag cannot write either.
 *
 *   node --test scripts/referees/sync-profiles.test.mjs
 *
 * The script is run as a real subprocess against a stand-in PostgREST that
 * records every request it receives. Nothing is asserted about the script's
 * internals — the test watches the wire, because the wire is where a write
 * either happens or does not. A guard that is refactored away, or bypassed by
 * a new call site, fails this test; a guard that is merely renamed does not.
 *
 * This exists because the failure it checks for actually occurred. The script
 * takes --dry-run and was invoked with --dry; the parser ignored the unknown
 * flag, the dry gate stayed closed, and 185 referee profiles were inserted by
 * a command whose author was expecting to watch it do nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sync-profiles.mjs');

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** A PostgREST stand-in that answers reads with plausible data and logs everything. */
async function withFakeRest(run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      /* Enough shape for the script to get all the way to its writes: two
       * referees in the results, one profile already present, no aliases. So
       * it has real work to do and a dry run has something to suppress. */
      let payload = '[]';
      if (req.url.startsWith('/rest/v1/ufc_bout_results')) {
        payload = JSON.stringify([{ referee: 'Herb Dean' }, { referee: 'Marc Goddard' }, { referee: 'Big John McCarthy' }]);
      } else if (req.url.startsWith('/rest/v1/ufc_referee_profiles')) {
        payload = JSON.stringify([{ canonical_name: 'Herb Dean', slug: null, display_name: 'Herb Dean' }]);
      } else if (req.url.startsWith('/rest/v1/ufc_referee_aliases')) {
        payload = '[]';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(url, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function runScript(url, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'test-key' },
      cwd: path.resolve(HERE, '..', '..'),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('--dry-run issues no mutating request of any kind', async () => {
  await withFakeRest(async (url, seen) => {
    const { code, out, err } = await runScript(url, ['--dry-run']);
    assert.equal(code, 0, `script should succeed\n${err}`);

    const writes = seen.filter((r) => MUTATING.has(r.method));
    assert.deepEqual(
      writes.map((w) => `${w.method} ${w.url}`),
      [],
      'a dry run must not send a single POST, PATCH, PUT or DELETE',
    );

    /* And it must actually have reached the point where it would have written,
     * otherwise this passes for the wrong reason — a script that crashed early
     * also sends no writes. */
    assert.match(out, /would POST/, 'the dry run should report the writes it suppressed');
    assert.ok(seen.some((r) => r.method === 'GET'), 'it should still have read');
  });
});

test('a misspelt flag refuses to run rather than writing', async () => {
  await withFakeRest(async (url, seen) => {
    const { code, err } = await runScript(url, ['--dry']);
    assert.equal(code, 2, 'an unknown flag must be fatal');
    assert.match(err, /unknown option/i);
    assert.deepEqual(seen, [], 'it must refuse before contacting the database at all');
  });
});

test('the mutation check would catch a real write', async () => {
  /* Guards the test itself: with no flag the script writes, so if this run
   * produced no mutations the interception is broken and the first test would
   * be passing vacuously. */
  await withFakeRest(async (url, seen) => {
    const { code } = await runScript(url, []);
    assert.equal(code, 0);
    const writes = seen.filter((r) => MUTATING.has(r.method));
    assert.ok(writes.length > 0, 'a live run must produce writes, or this test cannot detect their absence');
  });
});
