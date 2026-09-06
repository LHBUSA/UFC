/* Live-wire acceptance checks over CDP (addendum §8): rail present, items are
 * real links, belt animates, pauses on hover and on keyboard focus, and goes
 * static (no animation, scrollable) under prefers-reduced-motion.
 *
 *   node scripts/qa/wire-check.mjs http://localhost:3311 [/path] */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [BASE = 'http://localhost:3311', PATH = '/'] = process.argv.slice(2);
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), 'pbe-wire-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 40; i += 1) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch (_) { /* wait */ }
    await sleep(250);
  }
  throw new Error('no page target');
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  return (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (j) => (j.error ? rej(new Error(`${method}: ${j.error.message}`)) : res(j.result))); ws.send(JSON.stringify({ id: n, method, params })); });
}
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r));
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const evalJson = async (expr) => JSON.parse((await send('Runtime.evaluate', { expression: `JSON.stringify((()=>{${expr}})())`, returnByValue: true })).result.value);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + PATH }); await sleep(2500);

  let s = await evalJson(`const r=document.querySelector('.wire-rail'); if(!r) return {present:false};
    const links=[...r.querySelectorAll('.wire-track:not([aria-hidden]) a')]; const t=r.querySelector('.wire-track');
    const cs=getComputedStyle(t); const badge=r.querySelector('.wire-badge span')?.textContent;
    return {present:true, items:links.length, hrefs:links.slice(0,3).map(a=>a.getAttribute('href')), external:links.filter(a=>a.target==='_blank').length, internal:links.filter(a=>a.getAttribute('href')?.startsWith('/')).length,
      anim:cs.animationName, state:cs.animationPlayState, badge, live:r.classList.contains('live'), height:r.getBoundingClientRect().height, docW:document.documentElement.scrollWidth}`);
  check('rail present beneath shell', s.present);
  if (s.present) {
    check('rail has real attributed items (>= 8)', s.items >= 8, `${s.items} items`);
    check('links resolve (internal or external)', s.internal + s.external === s.items, `${s.internal} internal, ${s.external} external`);
    check('belt animates via transform keyframes', s.anim === 'wire-scroll' && s.state === 'running', `${s.anim} ${s.state}`);
    check('badge is truthful', s.badge === 'UFC Live Wire' ? s.live : s.badge === 'Latest UFC', `badge="${s.badge}" live=${s.live}`);
    check('no horizontal overflow', s.docW <= 1440, `scrollWidth=${s.docW}`);
    const box = await evalJson(`const b=document.querySelector('.wire-view').getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }); await sleep(300);
    s = await evalJson(`return {state:getComputedStyle(document.querySelector('.wire-track')).animationPlayState, paused:document.querySelector('.wire-rail').classList.contains('paused')}`);
    check('pauses on hover', s.state === 'paused' && s.paused, s.state);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 600 }); await sleep(300);
    s = await evalJson(`return getComputedStyle(document.querySelector('.wire-track')).animationPlayState`);
    check('resumes after hover', s === 'running', s);
    await evalJson(`document.querySelector('.wire-track:not([aria-hidden]) a')?.focus(); return 1`); await sleep(300);
    s = await evalJson(`return {state:getComputedStyle(document.querySelector('.wire-track')).animationPlayState, focused:document.activeElement?.closest('.wire-rail')!=null}`);
    check('pauses on keyboard focus (link focusable)', s.state === 'paused' && s.focused, s.state);
    await evalJson(`document.activeElement.blur(); return 1`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(300);
    s = await evalJson(`const t=document.querySelector('.wire-track'); return {anim:getComputedStyle(t).animationName, ov:getComputedStyle(document.querySelector('.wire-view')).overflowX, dup:getComputedStyle(document.querySelector('.wire-track[aria-hidden]')).display}`);
    check('reduced-motion: static and scrollable', s.anim === 'none' && s.ov === 'auto' && s.dup === 'none', `${s.anim} overflow=${s.ov} dup=${s.dup}`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(500);
    s = await evalJson(`const r=document.querySelector('.wire-rail'); return {docW:document.documentElement.scrollWidth, h:r.getBoundingClientRect().height, badgeText:getComputedStyle(r.querySelector('.wire-badge span')).display}`);
    check('mobile: compact single-line rail, no overflow', s.docW <= 390 && s.h <= 40, `scrollWidth=${s.docW} h=${s.h}`);
  }
  ws.close();
} finally {
  chrome.kill(); await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* in use */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} wire checks passed`);
process.exit(failed ? 1 : 0);
