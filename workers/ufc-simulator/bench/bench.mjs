// Benchmark: raw engine throughput and the full anchored simulate() call.
import { performance } from 'node:perf_hooks';
import { simulate } from '../src/engine/simulate.mjs';
import { profileFromSnapshot } from '../src/engine/inputs.mjs';
import { prepareContext } from '../src/engine/fight.mjs';
import { runBatch } from '../src/engine/anchor.mjs';
import { masterSeed } from '../src/engine/rng.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';
import { loadFixture, requestFromFixture, PAIR_FIXTURES } from '../src/engine/fixtures.mjs';

const fx = loadFixture('ufc333_volkanovski_evloev');
const p1 = profileFromSnapshot(fx.fighter_a), p2 = profileFromSnapshot(fx.fighter_b);
const out = { node: process.version, platform: process.platform, arch: process.arch };

for (const R of [3, 5]) {
  const ctx = prepareContext(p1, p2, R, DEFAULT_PARAMS);
  runBatch(ctx, masterSeed('warm'), 3000, 0); // warm-up
  const times = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); runBatch(ctx, masterSeed('bench' + i), 10000, 0.2); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  out[`batch_10k_R${R}_ms_median`] = Math.round(times[2] * 10) / 10;
  out[`per_fight_us_R${R}`] = Math.round((times[2] * 1000) / 10000 * 100) / 100;
}

const full = [];
for (const name of PAIR_FIXTURES) {
  const f = loadFixture(name);
  const req = requestFromFixture(f);
  const t = performance.now();
  const r = simulate(req);
  full.push({ fixture: name, rounds: f.bout.scheduled_rounds, ms: Math.round(performance.now() - t), status: r.artifact.status, anchor_iterations: r.artifact.anchor?.iterations ?? null, tilt: r.artifact.anchor?.tilt_applied ?? null, artifact_bytes: JSON.stringify(r.artifact).length });
}
out.simulate_full = full;
out.simulate_full_ms_mean = Math.round(full.reduce((a, b) => a + b.ms, 0) / full.length);
out.note = 'simulate() = 10k pre-anchor run + bisection (2k fights per evaluation) + 10k final run + summary + medoid';
console.log(JSON.stringify(out, null, 2));
