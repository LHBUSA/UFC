// Determinism gates required by the Phase 2 brief:
//   100 same-process runs -> byte-identical artifact
//   fresh processes       -> byte-identical artifact (cross_process.check.mjs, run by the test below)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulate } from './simulate.mjs';
import { canonicalJson } from './canonical.mjs';
import { loadFixture, requestFromFixture, PAIR_FIXTURES } from './fixtures.mjs';

const RUNS = Number(process.env.SIM_DETERMINISM_RUNS || 100);

test(`100 same-process runs are byte-identical (n_sims 10,000, runs=${RUNS})`, () => {
  const fx = loadFixture('ufc333_volkanovski_evloev');
  const req = requestFromFixture(fx);
  const first = simulate(req, { now: () => 'fixed' });
  const bytes = canonicalJson(first.artifact);
  for (let i = 1; i < RUNS; i++) {
    const r = simulate(req, { now: () => 'fixed' });
    assert.equal(canonicalJson(r.artifact), bytes, `run ${i} differs`);
  }
  assert.ok(first.envelope.elapsed_ms > 0);
});

test('all fixtures: two runs each are byte-identical and the envelope clock is outside the hash', () => {
  for (const name of PAIR_FIXTURES) {
    const fx = loadFixture(name);
    const a = simulate(requestFromFixture(fx), { now: () => 'a' });
    const b = simulate(requestFromFixture(fx), { now: () => 'b' });
    assert.equal(a.artifact.artifact_sha256, b.artifact.artifact_sha256, name);
    assert.equal(canonicalJson(a.artifact), canonicalJson(b.artifact), name);
    assert.notEqual(a.envelope.generated_at, b.envelope.generated_at);
  }
});

test('fresh processes agree: three child processes produce the same artifact hash as this process', () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cross_process.check.mjs');
  const fx = loadFixture('ufc331_pitbull_choi');
  const here = simulate(requestFromFixture(fx)).artifact.artifact_sha256;
  for (let i = 0; i < 3; i++) {
    const out = spawnSync(process.execPath, [script, 'ufc331_pitbull_choi'], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout.trim());
    assert.equal(parsed.artifact_sha256, here, `child ${i}`);
  }
});
