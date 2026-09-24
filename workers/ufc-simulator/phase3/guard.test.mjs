import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertWalkForwardParams } from './guard.mjs';

const CACHE = process.env.SIM_PHASE3_CACHE || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.cache', 'phase3');
const has = (f) => fs.existsSync(path.join(CACHE, f));
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));

test('guard refuses params_fold_all for any historical bout', { skip: !has('params_fold_all.json') }, () => {
  const all = load('params_fold_all.json');
  assert.throws(() => assertWalkForwardParams(all, 2020, '2020-06-01'), /LEAKAGE GUARD/);
  assert.throws(() => assertWalkForwardParams(all, 2026, '2026-09-01'), /LEAKAGE GUARD/);
});

test('guard accepts the matching fold and refuses a mismatched year or a bout inside the training window', { skip: !has('params_fold_2020.json') }, () => {
  const p = load('params_fold_2020.json');
  assert.equal(assertWalkForwardParams(p, 2020, '2020-06-01'), true);
  assert.throws(() => assertWalkForwardParams(p, 2021, '2021-06-01'), /LEAKAGE GUARD/);
  assert.throws(() => assertWalkForwardParams(p, 2020, '2019-06-01'), /LEAKAGE GUARD/);
  const tampered = JSON.parse(JSON.stringify(p)); tampered.models.att.provenance = 'all-2015-2026';
  assert.throws(() => assertWalkForwardParams(tampered, 2020, '2020-06-01'), /LEAKAGE GUARD/);
});
