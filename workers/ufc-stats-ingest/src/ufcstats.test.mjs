/* Run: node workers/ufc-stats-ingest/src/ufcstats.test.mjs
 * Tests the challenge parser + solver against the interstitial shape captured 2026-09-05. */
import { parseChallenge, solveChallenge, isInterstitial, AccessGateError } from './ufcstats.mjs';

let failures = 0;
const check = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } };

const interstitial = `<!doctype html><html><head><meta charset="utf-8">
<title>Loading…</title><meta name="robots" content="noindex"></head><body>
<p>Checking your browser…</p>
<noscript>This site requires JavaScript.</noscript>
<script>(function(){ function sha256(msg){ return ''; }
var nonce="452d808fee2977a6",
    target=new Array(2+1).join('0');
var n=0;
while(sha256(nonce+':'+n).slice(0,target.length)!==target){n++;}
var xhr=new XMLHttpRequest();
xhr.open('POST',"/__c",true);
xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)location.reload();};
xhr.send('nonce='+encodeURIComponent(nonce)+'&n='+n);
})();</script></body></html>`;

check(isInterstitial(interstitial), 'interstitial detected');
check(!isInterstitial('<html><body><table class="b-statistics__table-events">' + 'x'.repeat(10000) + '</table></body></html>'), 'real page not flagged');

const ch = parseChallenge(interstitial, 'http://t', 4);
check(ch.nonce === '452d808fee2977a6' && ch.difficulty === 2 && ch.path === '/__c', `parsed ${JSON.stringify(ch)}`);

const n = await solveChallenge(ch, 'http://t');
const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ch.nonce}:${n}`));
const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
check(hex.startsWith('00'), `solution n=${n} hash=${hex.slice(0, 8)}`);

const tryGate = (html, max = 4) => { try { parseChallenge(html, 'http://t', max); return null; } catch (e) { return e; } };
check(tryGate(interstitial.replace('/__c', '/__challenge')) instanceof AccessGateError, 'endpoint change aborts');
check(tryGate(interstitial.replace('new Array(2+1)', 'new Array(6+1)')) instanceof AccessGateError, 'difficulty 6 aborts at limit 4');
check(tryGate(interstitial.replace("xhr.send('nonce='+encodeURIComponent(nonce)+'&n='+n)", "xhr.send(JSON.stringify({nonce:nonce,n:n,ts:Date.now()}))")) instanceof AccessGateError, 'payload change aborts');
check(tryGate(interstitial.replace('var nonce="452d808fee2977a6"', 'var seed="452d808fee2977a6"')) instanceof AccessGateError, 'variable rename aborts');

console.log('ufcstats.mjs:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
