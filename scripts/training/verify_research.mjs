#!/usr/bin/env node
// Mechanically verify researched Training & Corner facts against the live source pages before any write.
//
//   node scripts/training/verify_research.mjs <research.json ...> --out verified.json --rejected rejected.json
//
// A fact passes only when, on OUR OWN fetch of source_url:
//   * the domain is allowed (no ufc.com, espn.com, tapology, sherdog, wikipedia, content farms),
//   * the page does not credit Sherdog as the origin,
//   * the quote appears on the page (normalized substring, else >= 85% of its 5-word shingles),
//   * the fighter's surname and the key entity (coach name / city / gym) appear on the page,
//   * coach facts are from a source published 2023-01-01 or later.
// Place parts (city/region/country) that do not appear on the page are dropped, never kept from inference.
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--rejected'].includes(args[i - 1]));
const OUT = opt('--out') || 'verified.json';
const REJ = opt('--rejected') || 'rejected.json';

const BANNED = /(^|\.)(ufc\.com|espn\.com|espn\.co\.uk|tapology\.com|sherdog\.com|wikipedia\.org|fandom\.com|reddit\.com|essentiallysports\.com|sportskeeda\.com|fightomic\.com)$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...' };
function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
}
export function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[^a-z0-9'"]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function shingleCoverage(quote, page) {
  const w = norm(quote).split(' ');
  if (w.length < 5) return page.includes(norm(quote)) ? 1 : 0;
  let hit = 0, total = 0;
  for (let i = 0; i + 5 <= w.length; i += 1) { total += 1; if (page.includes(w.slice(i, i + 5).join(' '))) hit += 1; }
  return hit / total;
}
const has = (page, s) => Boolean(s) && page.includes(norm(s));

const cache = new Map();
async function fetchPage(url) {
  if (cache.has(url)) return cache.get(url);
  let out;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    out = res.ok ? { ok: true, text: norm(pageText(await res.text())) } : { ok: false, why: `HTTP ${res.status}` };
  } catch (e) { out = { ok: false, why: String(e?.message || e).slice(0, 80) }; }
  cache.set(url, out);
  return out;
}

const facts = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).filter((x) => x && x.kind && x.kind !== 'none');
const verified = [], rejected = [];
for (const x of facts) {
  const why = [];
  let host = '';
  try { host = new URL(x.source_url).hostname; } catch { why.push('bad url'); }
  if (host && BANNED.test(host)) why.push(`banned domain ${host}`);
  if (x.kind === 'coach' && (!x.source_published || x.source_published < '2023-01-01')) why.push(`coach source date ${x.source_published || 'unknown'} < 2023`);
  if (!why.length) {
    const p = await fetchPage(x.source_url);
    if (!p.ok) why.push(`fetch failed: ${p.why}`);
    else {
      const page = p.text;
      if (/\b(told|via|to|per|according to) sherdog\b|sherdog\.com/.test(page)) why.push('page credits Sherdog');
      const cov = shingleCoverage(x.quote, page);
      if (!(page.includes(norm(x.quote)) || cov >= 0.85)) why.push(`quote not on page (coverage ${cov.toFixed(2)})`);
      const surname = String(x.fighter).trim().split(/\s+/).pop();
      if (!has(page, surname)) why.push(`fighter surname "${surname}" not on page`);
      const key = x.kind === 'coach' ? x.coach_name : ['switch', 'temporary_camp'].includes(x.kind) ? x.gym : x.city || x.gym;
      if (!key) why.push('no key entity');
      else if (!has(page, key)) why.push(`key "${key}" not on page`);
      if (x.kind === 'coach' && !has(norm(x.quote), x.coach_name)) why.push('quote does not name the coach');
      if (!why.length) {
        const y = { ...x };
        for (const k of ['city', 'region', 'country']) if (y[k] && !has(page, y[k])) y[k] = null; // never keep an inferred place part
        if (['training_location', 'fighting_out_of'].includes(y.kind) && !y.city && !y.region && !y.country) why.push('no place part on page');
        else verified.push({ ...y, verified_at: new Date().toISOString(), quote_coverage: Number(cov.toFixed(2)) });
      }
    }
  }
  if (why.length) rejected.push({ fighter: x.fighter, kind: x.kind, coach_name: x.coach_name, city: x.city, gym: x.gym, source_url: x.source_url, reasons: why });
}
fs.writeFileSync(OUT, JSON.stringify(verified, null, 1));
fs.writeFileSync(REJ, JSON.stringify(rejected, null, 1));
console.log(JSON.stringify({ facts: facts.length, verified: verified.length, rejected: rejected.length }));
