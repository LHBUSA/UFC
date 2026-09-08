#!/usr/bin/env node
/**
 * Odds API quota preflight. Costs nothing.
 *
 * /v4/sports is the provider's only unmetered endpoint: it returns the same
 * x-requests-* headers as a paid call but does not decrement the allowance.
 * So it answers the two questions that must be answered before any spend —
 * how much of the month is left, and is this sport actually in season — and
 * it answers them without becoming part of the problem it is measuring.
 *
 * Cost is never assumed here. The Odds API bills a bulk /odds call as
 * regions x markets, so a call is only one credit when both are singular, and
 * the real figure is read back from x-requests-last after the fact rather
 * than predicted. This prints the prediction and the ingest prints the
 * measurement; if they ever disagree, believe the measurement.
 *
 *   node scripts/odds/quota.mjs [--regions us] [--markets h2h]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = { ...process.env };
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, i).trim();
      if (!env[k]) env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
}

const KEY = env.ODDS_API_KEY || '';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const REGIONS = opt('--regions', 'us');
const MARKETS = opt('--markets', 'h2h');
const SPORT = 'mma_mixed_martial_arts';

if (!KEY) {
  console.log('MARKET_DATA_NOT_CONFIGURED: ODDS_API_KEY is not set.');
  console.log(`Set it in ${path.join(ROOT, '.env')} (gitignored, untracked). Nothing was fetched.`);
  process.exit(3);
}

const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(KEY)}`, {
  signal: AbortSignal.timeout(25000),
});
const used = r.headers.get('x-requests-used');
const remaining = r.headers.get('x-requests-remaining');
const last = r.headers.get('x-requests-last');

if (!r.ok) {
  /* The body can echo the key back in an error. Report the status only. */
  console.error(`provider rejected the preflight: HTTP ${r.status}`);
  process.exit(1);
}

const sports = await r.json();
const mma = sports.find((s) => s.key === SPORT) || null;
const predicted = REGIONS.split(',').filter(Boolean).length * MARKETS.split(',').filter(Boolean).length;

console.log(`quota      used ${used} · remaining ${remaining} · this preflight cost ${last} (unmetered)`);
console.log(`sport      ${SPORT}: ${mma ? (mma.active ? 'active' : 'listed but inactive') : 'NOT LISTED'}`);
console.log(`predicted  a bulk /odds call at regions=${REGIONS} markets=${MARKETS} bills ${predicted} credit(s)`);
console.log(`           (regions x markets; the ingest reports the measured cost from x-requests-last)`);
if (!mma?.active) console.log('\nno active MMA market: an ingest would return zero events and still be billed.');
