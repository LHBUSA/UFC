import test from 'node:test';
import assert from 'node:assert/strict';
import { fitGlm, nbDispersion } from './glm.mjs';
import { fightRng, masterSeed } from '../src/engine/rng.mjs';
import { poisson, binomial, gamma, negbin } from '../src/engine/dist.mjs';

const rng = fightRng(masterSeed('glm-test'), 1);
const N = 20000;
const X = [], off = [];
for (let i = 0; i < N; i++) { X.push([1, rng.nextFloat() * 2 - 1, rng.nextFloat() * 2 - 1]); off.push(Math.log(0.5 + rng.nextFloat())); }
const lin = (b, x) => b[0] * x[0] + b[1] * x[1] + b[2] * x[2];
const close = (a, b, tol) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('poisson recovers known coefficients with an offset', () => {
  const beta = [0.8, 0.6, -0.4];
  const y = X.map((x, i) => poisson(rng, Math.exp(lin(beta, x) + off[i])));
  const fit = fitGlm({ X, y, offset: off, family: 'poisson', ridge: 1e-3 });
  beta.forEach((b, j) => close(fit.beta[j], b, 0.05));
});

test('negative binomial dispersion is recovered by moments', () => {
  const beta = [2.5, 0.5, 0];
  const y = X.map((x) => negbin(rng, Math.exp(lin(beta, x)), 3));
  const fit = fitGlm({ X, y, family: 'poisson', ridge: 1e-3 });
  close(fit.beta[0], 2.5, 0.05); close(fit.beta[1], 0.5, 0.05);
  const k = nbDispersion(X, y, fit.beta);
  close(k, 3, 0.5);
});

test('binomial recovers known coefficients with varying trials', () => {
  const beta = [-0.3, 1.2, -0.7];
  const n = X.map(() => 5 + Math.floor(rng.nextFloat() * 60));
  const y = X.map((x, i) => binomial(rng, n[i], 1 / (1 + Math.exp(-lin(beta, x)))));
  const fit = fitGlm({ X, y, n, family: 'binomial', ridge: 1e-3 });
  beta.forEach((b, j) => close(fit.beta[j], b, 0.05));
});

test('cloglog recovers known coefficients for a rare event with an offset', () => {
  const beta = [-3.0, 0.8, 2.0];
  const y = X.map((x, i) => (rng.nextFloat() < 1 - Math.exp(-Math.exp(lin(beta, x) + off[i])) ? 1 : 0));
  const fit = fitGlm({ X, y, offset: off, family: 'cloglog', ridge: 1e-3 });
  beta.forEach((b, j) => close(fit.beta[j], b, 0.15));
  // Determinism: same rows -> same bytes.
  const fit2 = fitGlm({ X, y, offset: off, family: 'cloglog', ridge: 1e-3 });
  assert.deepEqual(fit.beta, fit2.beta);
});

test('gamma recovers known log-link coefficients and shape', () => {
  const beta = [3.0, 0.5, -0.5];
  const y = X.map((x) => gamma(rng, 2.5, Math.exp(lin(beta, x)) / 2.5));
  const fit = fitGlm({ X, y, family: 'gamma', ridge: 1e-3 });
  beta.forEach((b, j) => close(fit.beta[j], b, 0.05));
  close(fit.shape, 2.5, 0.4);
});
