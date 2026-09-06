/* Full-page screenshots with real device emulation over the Chrome DevTools
 * Protocol (no npm dependencies; Node 22+ has WebSocket built in).
 *
 *   node scripts/qa/shot.mjs <outDir> <base> [widths] [paths]
 *   node scripts/qa/shot.mjs shots http://localhost:3311 390,1440 /,/events,/rankings
 *
 * Prints one line per capture with the document scrollWidth so horizontal
 * overflow is caught numerically, not by eye. Widths <= 500 are captured as
 * mobile (touch, DPR 2). */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [OUT = 'shots', BASE = 'http://localhost:3311', WIDTHS = '390,1440', PATHS = '/'] = process.argv.slice(2);
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9800 + Math.floor(Math.random() * 100);
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'pbe-qa-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome did not expose a page target');
}

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, (j) => (j.error ? reject(new Error(`${method}: ${j.error.message}`)) : resolve(j.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r));
  const send = cdp(ws);
  await send('Page.enable');
  for (const w of WIDTHS.split(',').map(Number)) {
    const mobile = w <= 500;
    for (const p of PATHS.split(',')) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
      if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await send('Page.navigate', { url: BASE + p });
      await sleep(2500);
      const { result } = await send('Runtime.evaluate', { expression: 'JSON.stringify({sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.documentElement.scrollHeight, title: document.title})', returnByValue: true });
      const m = JSON.parse(result.value);
      const h = Math.min(m.h, 6000);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await sleep(400);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      const name = `${p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-${w}.png`;
      writeFileSync(join(OUT, name), Buffer.from(shot.data, 'base64'));
      console.log(`${name.padEnd(70)} scrollWidth=${m.sw} innerWidth=${m.iw}${m.sw > m.iw ? '  <-- OVERFLOW' : ''}  h=${m.h}  ${m.title.slice(0, 50)}`);
    }
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* profile in use */ }
}
