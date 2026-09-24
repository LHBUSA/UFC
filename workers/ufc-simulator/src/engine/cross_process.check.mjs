// Prints {fixture, simulation_id, artifact_sha256} for one fixture. Used by the
// determinism test (fresh processes) and by the workerd parity runner.
import { simulate } from './simulate.mjs';
import { loadFixture, requestFromFixture, PAIR_FIXTURES } from './fixtures.mjs';

const name = process.argv[2] || 'ufc331_pitbull_choi';
const nSims = Number(process.argv[3] || 10000);
if (name === 'all') {
  const out = {};
  for (const n of PAIR_FIXTURES) { const a = simulate(requestFromFixture(loadFixture(n), { n_sims: nSims })).artifact; out[n] = { simulation_id: a.simulation_id, artifact_sha256: a.artifact_sha256 }; }
  process.stdout.write(JSON.stringify(out) + '\n');
} else {
  const a = simulate(requestFromFixture(loadFixture(name), { n_sims: nSims })).artifact;
  process.stdout.write(JSON.stringify({ fixture: name, simulation_id: a.simulation_id, artifact_sha256: a.artifact_sha256 }) + '\n');
}
