/* Run: node workers/ufc-stats-ingest/src/normalizers.test.mjs (from repo root).
 * Same fixtures as shared/tests/test_normalizers.py. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from './normalizers.mjs';
import { SchemaAssertionError } from './ufcstats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'shared', 'tests', 'normalizer_fixtures.json'), 'utf8'));
let failures = 0;
const U = 'test://fixture';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function run(label, fn, cases) {
  for (const [raw, expected] of cases) {
    let got;
    try { got = fn(raw, U); } catch (e) { if (e instanceof SchemaAssertionError) got = 'raise'; else throw e; }
    if (!same(got, expected)) { failures += 1; console.log(`FAIL ${label}(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); }
  }
}

run('method', N.normMethod, FX.method);
run('weight_class', N.normWeightClass, FX.weight_class);
run('stance', N.normStance, FX.stance);
run('scheduled_rounds', N.scheduledRounds, FX.scheduled_rounds);
run('mmss', N.mmssToSec, FX.mmss);
run('x_of_y', N.xOfY, FX.x_of_y);
run('height', N.heightIn, FX.height);
run('reach', N.reachIn, FX.reach);
run('weight', N.weightLbs, FX.weight);
run('record', N.record, FX.record);
run('event_date', N.eventDate, FX.event_date);
for (const [raw, expected] of FX.scorecards) {
  const got = N.scorecards(raw);
  if (!same(got, expected)) { failures += 1; console.log(`FAIL scorecards(${JSON.stringify(raw)}) = ${JSON.stringify(got)}`); }
}
console.log('normalizers.mjs:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
