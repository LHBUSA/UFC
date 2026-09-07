#!/usr/bin/env node
// Live-card source canary.
//
// Answers one question with evidence instead of assumption: when does UFC
// Stats actually publish round data during a card? Everything the product is
// allowed to claim about freshness depends on the answer, so it is measured
// rather than guessed.
//
// It records, for every request it makes: the timestamp, the URL, the HTTP
// status, and what became newly visible. From that it derives when the event
// first appeared, when each bout appeared, when a result appeared, when each
// round's stats first appeared, and the latency from a round or fight ending
// to its data being published.
//
// It is deliberately gentle with the source. One request at a time, a minimum
// spacing between requests, exponential backoff on 429/403/5xx, and it stops
// entirely if it is served a challenge interstitial. Politeness here is not
// courtesy, it is the condition of being allowed to keep reading at all.
//
//   node scripts/backfill/live_canary.mjs --event <ufcstats_event_id> [options]
//   node scripts/backfill/live_canary.mjs --discover            # find today's card
//
// Options:
//   --interval 120     seconds between polling passes (default 120)
//   --spacing 1500     minimum ms between individual requests (default 1500)
//   --minutes 300      how long to run before stopping (default 300)
//   --out FILE         observation log (default logs/live_canary_<date>.jsonl)
//   --dry-run          resolve the event and exit without polling
//
// Writes one JSON object per line, so a run can be analysed while still in
// progress and nothing is lost if it is interrupted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from '../../workers/ufc-stats-ingest/node_modules/cheerio/dist/browser/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(HERE, 'logs');
const BASE = 'http://ufcstats.com';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const INTERVAL = Number(opt('--interval', 120)) * 1000;
const SPACING = Number(opt('--spacing', 1500));
const RUN_MS = Number(opt('--minutes', 300)) * 60000;
const OUT = opt('--out', path.join(LOGS, `live_canary_${new Date().toISOString().slice(0, 10)}.jsonl`));

fs.mkdirSync(LOGS, { recursive: true });
const write = (obj) => fs.appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`);
const say = (...a) => { console.log(new Date().toISOString(), ...a); };

let lastRequestAt = 0;
let consecutiveErrors = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Interstitial detection mirrors the production worker: if the source starts
 * challenging us, the correct response is to stop, not to adapt. */
const isInterstitial = (html) => /Just a moment|Checking your browser|__cf_chl|challenge-platform/i.test(html || '');

async function fetchPage(url) {
  const wait = Math.max(0, lastRequestAt + SPACING - Date.now());
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();

  let res, body = '', status = 0, error = null;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'PropBetEdge-source-canary/1.0 (measuring publication latency; contact sales@localhomebuyersusa.com)', accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    });
    status = res.status;
    body = await res.text();
  } catch (e) {
    error = String(e?.message || e).slice(0, 160);
  }

  write({ kind: 'request', url, status, bytes: body.length, error });

  if (error || status === 429 || status === 403 || status >= 500) {
    consecutiveErrors += 1;
    const backoff = Math.min(600000, 30000 * 2 ** (consecutiveErrors - 1));
    say(`backoff ${Math.round(backoff / 1000)}s after status=${status}${error ? ` error=${error}` : ''}`);
    write({ kind: 'backoff', url, status, seconds: Math.round(backoff / 1000) });
    await sleep(backoff);
    return null;
  }
  if (isInterstitial(body)) {
    write({ kind: 'interstitial', url, note: 'source served a challenge; stopping so we do not push further' });
    say('CHALLENGE INTERSTITIAL — stopping.');
    process.exit(3);
  }
  consecutiveErrors = 0;
  return body;
}

const txt = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();

/* Minimal, tolerant readers. The canary must keep observing even if the page
 * shape shifts mid-card, so it reports what it could not read instead of
 * throwing. */
function readEventPage(html) {
  const $ = cheerio.load(html);
  const bouts = [];
  $('tr').each((_, tr) => {
    const link = $(tr).attr('data-link') || $(tr).find('a[href*="fight-details"]').attr('href') || '';
    const m = /fight-details\/([0-9a-f]{16})/.exec(link);
    if (!m) return;
    const names = $(tr).find('a[href*="fighter-details"]').toArray().map((a) => txt($, a));
    const cells = $(tr).find('td').toArray().map((td) => txt($, td));
    bouts.push({ id: m[1], names, flag: cells[0] || null, method: cells[7] || null, round: cells[8] || null, time: cells[9] || null });
  });
  return { name: txt($, $('h2').first()) || null, bouts };
}

function readFightPage(html) {
  const $ = cheerio.load(html);
  const statuses = $('.b-fight-details__person-status').toArray().map((e) => txt($, e));
  const items = {};
  $('.b-fight-details__text-item, .b-fight-details__text-item_first').each((_, it) => {
    const s = txt($, it);
    if (s.includes(':')) { const [k, ...rest] = s.split(':'); items[k.trim()] = rest.join(':').trim(); }
  });
  /* Which rounds have a stats block at all. This is the measurement that
   * matters: whether a round appears while the fight is still going. */
  const roundsSeen = new Set();
  $('table').each((_, table) => {
    $(table).find('thead').each((__, th) => {
      const m = /^Round (\d+)$/.exec(txt($, th));
      if (m) roundsSeen.add(Number(m[1]));
    });
  });
  return {
    decided: statuses.some((s) => ['W', 'L', 'D', 'NC'].includes(s)),
    method: items.Method || null,
    round: items.Round || null,
    time: items.Time || null,
    referee: items.Referee || null,
    rounds: [...roundsSeen].sort((a, b) => a - b),
  };
}

async function discover() {
  const html = await fetchPage(`${BASE}/statistics/events/completed?page=all`);
  if (!html) return null;
  const $ = cheerio.load(html);
  const first = $('a[href*="event-details"]').first();
  const m = /event-details\/([0-9a-f]{16})/.exec(first.attr('href') || '');
  say(`most recent completed event: ${txt($, first)} -> ${m ? m[1] : 'unresolved'}`);
  return m ? m[1] : null;
}

const main = async () => {
  let eventId = opt('--event');
  if (!eventId || flag('--discover')) eventId = await discover();
  if (!eventId) { console.error('No event id. Pass --event <16-hex id>.'); process.exit(2); }

  say(`canary on event ${eventId}`);
  say(`interval ${INTERVAL / 1000}s · spacing ${SPACING}ms · running ${RUN_MS / 60000}min · log ${OUT}`);
  write({ kind: 'start', event: eventId, interval_s: INTERVAL / 1000, spacing_ms: SPACING, run_minutes: RUN_MS / 60000 });
  if (flag('--dry-run')) { say('dry run; not polling'); return; }

  const firstSeen = { event: null, bouts: {}, results: {}, rounds: {} };
  const deadline = Date.now() + RUN_MS;
  let pass = 0;

  while (Date.now() < deadline) {
    pass += 1;
    const evHtml = await fetchPage(`${BASE}/event-details/${eventId}`);
    if (evHtml) {
      if (!firstSeen.event) { firstSeen.event = new Date().toISOString(); write({ kind: 'event_first_seen', event: eventId }); }
      const ev = readEventPage(evHtml);
      write({ kind: 'event_pass', pass, name: ev.name, bouts: ev.bouts.length });

      for (const b of ev.bouts) {
        if (!firstSeen.bouts[b.id]) {
          firstSeen.bouts[b.id] = new Date().toISOString();
          write({ kind: 'bout_first_seen', bout: b.id, names: b.names });
        }
        /* Only look at a fight page once the event row shows a method: that is
         * the source's own signal that something happened, and polling every
         * fight page every pass would be exactly the hammering to avoid. */
        const looksDecided = Boolean(b.method && b.method !== '--');
        if (!looksDecided && firstSeen.results[b.id]) continue;
        if (!looksDecided) continue;

        const fHtml = await fetchPage(`${BASE}/fight-details/${b.id}`);
        if (!fHtml) continue;
        const f = readFightPage(fHtml);

        if (f.decided && !firstSeen.results[b.id]) {
          firstSeen.results[b.id] = new Date().toISOString();
          write({ kind: 'result_first_seen', bout: b.id, names: b.names, method: f.method, round: f.round, time: f.time, referee: f.referee });
          say(`result visible: ${b.names.join(' vs ')} — ${f.method} R${f.round} ${f.time}`);
        }
        firstSeen.rounds[b.id] = firstSeen.rounds[b.id] || {};
        for (const rn of f.rounds) {
          if (!firstSeen.rounds[b.id][rn]) {
            firstSeen.rounds[b.id][rn] = new Date().toISOString();
            write({ kind: 'round_first_seen', bout: b.id, round: rn, result_seen_at: firstSeen.results[b.id] || null });
            say(`round data visible: ${b.names.join(' vs ')} R${rn}`);
          }
        }
        write({ kind: 'fight_pass', bout: b.id, decided: f.decided, rounds: f.rounds });
      }
    }
    await sleep(INTERVAL);
  }

  write({ kind: 'end', first_seen: firstSeen });
  say(`done. observations in ${OUT}`);
};
main().catch((e) => { write({ kind: 'fatal', error: String(e?.message || e) }); console.error('FATAL', e); process.exit(1); });
