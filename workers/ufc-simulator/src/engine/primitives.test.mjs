import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from './sha256.mjs';
import { canonicalJson, sortDeep } from './canonical.mjs';
import { Xoshiro128ss, stateFromHex, masterSeed, fightRng, splitmix32 } from './rng.mjs';
import { poisson, binomial, negbin, gamma, multinomial, categorical } from './dist.mjs';
import { buildIdentity, simulationId, canonicalOrder, engineSpecSha256 } from './fingerprint.mjs';
import { DEFAULT_PARAMS } from './params.mjs';

const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256: pure implementation matches node:crypto on fixed and random inputs', () => {
  for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'ü€𝄞 unicode', 'a'.repeat(1000), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(119)]) {
    assert.equal(sha256Hex(s), nodeSha(s));
  }
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const rng = new Xoshiro128ss(stateFromHex('0123456789abcdef0123456789abcdef'));
  for (let i = 0; i < 200; i++) {
    const len = rng.nextU32() % 300;
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(32 + (rng.nextU32() % 90));
    assert.equal(sha256Hex(s), nodeSha(s));
  }
});

test('canonical JSON: key order and undefined do not change bytes; non-finite numbers are refused', () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined });
  const b = canonicalJson({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => sortDeep({ x: NaN }));
});

test('rng: deterministic streams, per-fight sub-streams independent of batch size, known-answer vector', () => {
  const s1 = new Xoshiro128ss(stateFromHex('00000000000000000000000000000001'));
  const s2 = new Xoshiro128ss(stateFromHex('00000000000000000000000000000001'));
  const seq1 = Array.from({ length: 8 }, () => s1.nextU32());
  const seq2 = Array.from({ length: 8 }, () => s2.nextU32());
  assert.deepEqual(seq1, seq2);
  // Known-answer: xoshiro128** with state [1,2,3,4] outputs rotl(s1*5, 7)*9 = rotl(10,7)*9 = 1280*9 = 11520 first.
  const ref = new Xoshiro128ss([1, 2, 3, 4]);
  assert.equal(ref.nextU32(), 11520);
  // splitmix32 known value for seed 0: first output is deterministic and non-zero.
  assert.notEqual(splitmix32(0)(), 0);
  const seed = masterSeed('abc');
  assert.equal(seed, sha256Hex('pbe-sim-seed|abc'));
  const a = fightRng(seed, 7), b = fightRng(seed, 7), c = fightRng(seed, 8);
  assert.equal(a.nextFloat(), b.nextFloat());
  assert.notEqual(a.nextFloat(), c.nextFloat());
  // floats in [0,1)
  const r = fightRng(seed, 0);
  for (let i = 0; i < 10000; i++) { const u = r.nextFloat(); assert.ok(u >= 0 && u < 1); }
});

test('dist: means and bounds are sane; inversion samplers are monotone in the uniform', () => {
  const rng = fightRng(masterSeed('dist'), 1);
  const N = 20000;
  let sp = 0, sb = 0, snb = 0, snb2 = 0, sg = 0;
  for (let i = 0; i < N; i++) {
    sp += poisson(rng, 3.5);
    sb += binomial(rng, 40, 0.45);
    const x = negbin(rng, 35, 2.1); snb += x; snb2 += x * x;
    sg += gamma(rng, 1.2, 50);
  }
  assert.ok(Math.abs(sp / N - 3.5) < 0.08, `poisson mean ${sp / N}`);
  assert.ok(Math.abs(sb / N - 18) < 0.2, `binomial mean ${sb / N}`);
  const nbMean = snb / N, nbVar = snb2 / N - nbMean * nbMean;
  assert.ok(Math.abs(nbMean - 35) < 1.2, `negbin mean ${nbMean}`);
  assert.ok(nbVar > 35 + (35 * 35) / 2.1 * 0.8 && nbVar < 35 + (35 * 35) / 2.1 * 1.2, `negbin var ${nbVar}`);
  assert.ok(Math.abs(sg / N - 60) < 2, `gamma mean ${sg / N}`);
  assert.equal(poisson(rng, 0), 0); assert.equal(binomial(rng, 0, 0.5), 0); assert.equal(binomial(rng, 5, 1), 5); assert.equal(binomial(rng, 5, 0), 0);
  // monotone: a fake rng returning increasing uniforms yields non-decreasing counts
  const fake = (u) => ({ nextFloat: () => u });
  let last = -1;
  for (let u = 0; u < 1; u += 0.01) { const k = poisson(fake(u), 6); assert.ok(k >= last); last = k; }
  last = -1;
  for (let u = 0; u < 1; u += 0.01) { const k = binomial(fake(u), 30, 0.4); assert.ok(k >= last); last = k; }
  const m = multinomial(rng, 50, [0.6, 0.2, 0.2]);
  assert.equal(m.reduce((a, b) => a + b, 0), 50);
  assert.equal(categorical(rng, [0, 0]), -1);
});

test('fingerprint: identity is canonical, order-insensitive by construction, and the spec hash covers params', () => {
  const base = { engine_spec_sha256: engineSpecSha256(), model_version: 'pbe-fight-model-v1', model_spec_sha256: 'x', fighter_1_id: '1111', fighter_1_as_of: '2026-09-01', fighter_2_id: '2222', fighter_2_as_of: '2026-09-02', scheduled_rounds: 3, scenario: { weight_class: 'LIGHTWEIGHT', is_title: false, is_womens: false }, n_sims: 10000 };
  const id1 = simulationId(buildIdentity(base));
  const id2 = simulationId(buildIdentity({ ...base, scenario: { is_womens: false, is_title: false, weight_class: 'LIGHTWEIGHT' } }));
  assert.equal(id1, id2);
  assert.notEqual(id1, simulationId(buildIdentity({ ...base, n_sims: 20000 })));
  assert.notEqual(id1, simulationId(buildIdentity({ ...base, fighter_1_as_of: '2026-09-03' })));
  assert.throws(() => buildIdentity({ ...base, fighter_1_id: '2222', fighter_2_id: '1111' }));
  assert.deepEqual(canonicalOrder('b', 'a'), ['a', 'b']);
  const tweaked = JSON.parse(JSON.stringify(DEFAULT_PARAMS)); tweaked.models.att.k += 0.001;
  assert.notEqual(engineSpecSha256(tweaked), engineSpecSha256());
});
