// Runtime parity gate: Node vs workerd (wrangler dev, local) on every pair
// fixture. Exit 0 only when every simulation_id AND artifact_sha256 match.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PARITY_PORT || 8799);
const N = Number(process.env.PARITY_N || 10000);

const nodeRun = spawnSync(process.execPath, [path.join(ROOT, 'src', 'engine', 'cross_process.check.mjs'), 'all', String(N)], { encoding: 'utf8' });
if (nodeRun.status !== 0) { console.error(nodeRun.stderr); process.exit(2); }
const nodeHashes = JSON.parse(nodeRun.stdout.trim());

const isWin = process.platform === 'win32';
const wr = spawn(isWin ? 'cmd.exe' : 'wrangler', isWin ? ['/c', 'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'] : ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
let log = '';
wr.stdout.on('data', (d) => { log += d; });
wr.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return await r.json(); } catch {}
    await sleep(500);
  }
  throw new Error('wrangler dev did not become ready\n' + log);
}
function stop() {
  try { if (isWin) spawnSync('taskkill', ['/PID', String(wr.pid), '/T', '/F'], { stdio: 'ignore' }); else wr.kill('SIGTERM'); } catch {}
}

try {
  const health = await waitReady();
  const res = await fetch(`http://127.0.0.1:${PORT}/parity?n=${N}`);
  const body = await res.json();
  let ok = true;
  const rows = [];
  for (const [name, n] of Object.entries(nodeHashes)) {
    const w = body.results[name];
    const same = w && w.simulation_id === n.simulation_id && w.artifact_sha256 === n.artifact_sha256;
    ok = ok && Boolean(same);
    rows.push({ fixture: name, node: n.artifact_sha256.slice(0, 16), workerd: w ? w.artifact_sha256.slice(0, 16) : null, same_id: w ? w.simulation_id === n.simulation_id : false, same_artifact: Boolean(same), workerd_ms: w?.ms ?? null, tilt: w?.tilt ?? null });
  }
  console.log(JSON.stringify({ node: process.version, workerd_health: health, n_sims: N, parity: ok ? 'PASS' : 'FAIL', rows }, null, 2));
  stop();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(String(e?.stack || e));
  stop();
  process.exit(2);
}
