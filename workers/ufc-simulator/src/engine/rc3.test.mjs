// pbe-fight-simulator-v1.0-rc3 candidate (Phase 3B draw calibration): frozen config, spec hash, determinism, corner swap, and the
// production default (v1.0-rc2: rc1 calibration + round-by-outcome table) untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, SIMULATOR_VERSION, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3, PERSISTENCE_RC3 } from './params.mjs';
import { engineSpecSha256, canonicalOrder } from './fingerprint.mjs';
import { simulate } from './simulate.mjs';
import { profileFromSnapshot } from './inputs.mjs';
import { prepareContext } from './fight.mjs';
import { runBatch } from './anchor.mjs';
import { masterSeed } from './rng.mjs';
import { loadFixture, requestFromFixture } from './fixtures.mjs';

const DEFAULT_SPEC = 'e0ae2a4aad1673433adb458552ff7d6553efbe49299b551cbaa2944b95a37716';
const RC3_SPEC = engineSpecSha256(PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3);
const run = (fx, params, version, extra = {}) => simulate({ ...requestFromFixture(fx, { n_sims: 4000 }), ...extra }, { params, simulator_version: version });

test('the production default is unchanged by the candidate: no persistence in DEFAULT_PARAMS, spec hash pinned', () => {
  assert.equal(SIMULATOR_VERSION, 'pbe-fight-simulator-v1.0-rc2');
  assert.equal(DEFAULT_PARAMS.persistence, undefined);
  assert.equal(engineSpecSha256(), DEFAULT_SPEC);
});

test('rc3 is the production default plus exactly one frozen persistence block', () => {
  assert.deepEqual({ ...PARAMS_V1_0_RC3, persistence: undefined }, { ...DEFAULT_PARAMS, persistence: undefined });
  assert.equal(PERSISTENCE_RC3.rho, 0.7);
  assert.ok(Object.isFrozen(PARAMS_V1_0_RC3) && Object.isFrozen(PERSISTENCE_RC3));
  assert.notEqual(RC3_SPEC, DEFAULT_SPEC);
  assert.match(RC3_SPEC, /^[0-9a-f]{64}$/);
});

test('rc3 determinism: two in-process runs and a fresh process give identical artifact bytes', () => {
  const fx = loadFixture('ufc333_volkanovski_evloev');
  const a = run(fx, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3).artifact, b = run(fx, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3).artifact;
  assert.equal(a.artifact_sha256, b.artifact_sha256);
  assert.equal(a.engine_spec_sha256, RC3_SPEC);
  assert.equal(a.simulator_version, SIMULATOR_VERSION_RC3);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3 } from './params.mjs'; import { simulate } from './simulate.mjs'; import { loadFixture, requestFromFixture } from './fixtures.mjs';
    const fx = loadFixture('ufc333_volkanovski_evloev'); process.stdout.write(simulate(requestFromFixture(fx, { n_sims: 4000 }), { params: PARAMS_V1_0_RC3, simulator_version: SIMULATOR_VERSION_RC3 }).artifact.artifact_sha256);`], { cwd: here, encoding: 'utf8' });
  assert.equal(child.trim(), a.artifact_sha256);
});

test('rc3 corner swap: simulate(A,B) and simulate(B,A) return the same artifact bytes and id', () => {
  for (const name of ['ufc331_aswell_yoo', 'ufc333_volkanovski_evloev']) {
    const fx = loadFixture(name);
    const r1 = run(fx, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3), r2 = run(fx, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3, { fighter_a: fx.fighter_b, fighter_b: fx.fighter_a });
    assert.equal(r1.artifact.simulation_id, r2.artifact.simulation_id, name);
    assert.equal(r1.artifact.artifact_sha256, r2.artifact.artifact_sha256, name);
  }
});

test('rc3 aggregate antisymmetry: swapping corners inside the engine mirrors the winner share (tilt negated)', () => {
  const fx = loadFixture('ufc333_volkanovski_evloev');
  const p1 = profileFromSnapshot(fx.fighter_a, PARAMS_V1_0_RC3), p2 = profileFromSnapshot(fx.fighter_b, PARAMS_V1_0_RC3);
  const a = runBatch(prepareContext(p1, p2, 3, PARAMS_V1_0_RC3), masterSeed('sym'), 10000, 0.2);
  const b = runBatch(prepareContext(p2, p1, 3, PARAMS_V1_0_RC3), masterSeed('sym'), 10000, -0.2);
  assert.ok(Math.abs(a.p1() - (1 - b.p1())) < 0.02, `aggregate mirror ${a.p1()} vs ${1 - b.p1()}`);
});

test('rc3 moves only what persistence should: the anchored winner still equals the champion; draws fall; distance share is stable', () => {
  const fx = loadFixture('ufc333_volkanovski_evloev');
  const r1 = run(fx, DEFAULT_PARAMS, SIMULATOR_VERSION).artifact, r2 = run(fx, PARAMS_V1_0_RC3, SIMULATOR_VERSION_RC3).artifact;
  assert.ok(Math.abs(r2.anchor.post_anchor_probability - r2.anchor.champion_probability) <= 0.015);
  assert.ok(r2.probabilities.draw < r1.probabilities.draw, `draw ${r2.probabilities.draw} < ${r1.probabilities.draw}`);
  assert.ok(Math.abs(r2.probabilities.goes_distance - r1.probabilities.goes_distance) < 0.05);
  assert.deepEqual(canonicalOrder(fx.fighter_a.fighter.id, fx.fighter_b.fighter.id), canonicalOrder(fx.fighter_b.fighter.id, fx.fighter_a.fighter.id));
});
