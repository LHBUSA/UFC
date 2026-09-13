import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = path.join(HERE, 'completeness_matrix.mjs');

test('completeness matrix exact-verification regressions', () => {
  const run = spawnSync(process.execPath, [MATRIX, '--self-test'], {
    cwd: path.resolve(HERE, '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', UFC_ENV_FILE: '__matrix_self_test_no_env__' },
  });
  assert.equal(run.status, 0, `self-test failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  assert.deepEqual(result, { ok: true, cases: 8 });
});
