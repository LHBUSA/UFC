#!/usr/bin/env node
/* Release gate: the homepage hero never loses START TIMES & BROADCAST in fight week.
 *
 * Invariant (P0 2026-10-03, web/lib/broadcastHealth.ts): whenever the homepage
 * features a UFC card inside fight week (site-clock days out in [-1, 8]) and
 * the card's broadcast window has not closed, the hero contains EITHER the
 * WatchStrip (data-watch-state="strip", with a start time or a carrier) OR the
 * explicit notice (data-watch-state="unavailable" | "pending" with its honest
 * sentence). Never neither.
 *
 *   node scripts/accept-watch-surface.mjs                 live: https://ufc.propbetedge.ai
 *   node scripts/accept-watch-surface.mjs <base-url>      live: any deployment
 *   node scripts/accept-watch-surface.mjs --static        source wiring only (runs in prebuild)
 *
 * Exit 0 = pass, 1 = invariant violated, 2 = could not check (network/HTTP).
 * Run it after every production deploy; it is NOT a GitHub Action and never
 * will be (github-actions-shrink-policy). The pure checker is exported and
 * unit-tested offline in scripts/accept-watch-surface.test.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const FIGHT_WEEK_DAYS = 8;
const ROLLOVER_MS = 5 * 3600e3; // lib/siteClock.ts UFC_SITE_ROLLOVER_UTC_HOUR
const UNAVAILABLE_TEXT = 'Schedule verification temporarily unavailable';
const PENDING_TEXT = 'Start times to be announced';

export function siteDaysUntil(eventDate, now) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(eventDate || ''))) return null;
  const site = new Date(now - ROLLOVER_MS).toISOString().slice(0, 10);
  return Math.round((Date.parse(`${eventDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${site}T00:00:00Z`)) / 86400e3);
}

/** The opening tag of the hero feature block, and the HTML from it to the end of the hero section. */
function heroFeature(html) {
  const i = html.indexOf('class="hero-feature"');
  if (i < 0) return null;
  const tagStart = html.lastIndexOf('<', i);
  const tagEnd = html.indexOf('>', i);
  const end = html.indexOf('</section>', tagEnd);
  return { tag: html.slice(tagStart, tagEnd + 1), body: html.slice(tagEnd + 1, end < 0 ? undefined : end) };
}
const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

/**
 * Pure. Homepage HTML (+ optionally the /api/ufc/next-event payload) -> verdict.
 * @returns {{ ok: boolean, applies: boolean, reason: string, surface: string|null, event_date: string|null, days_out: number|null }}
 */
export function checkWatchSurface(html, { now = Date.now(), nextEvent = null } = {}) {
  const hero = heroFeature(String(html || ''));
  if (!hero) return { ok: false, applies: true, reason: 'homepage has no .hero-feature block', surface: null, event_date: null, days_out: null };
  const surface = attr(hero.tag, 'data-watch-surface');
  const eventDate = attr(hero.tag, 'data-event-date') || nextEvent?.event_date || null;
  const days = siteDaysUntil(eventDate, now);
  const inWeek = days != null && days >= -1 && days <= FIGHT_WEEK_DAYS;
  const base = { surface, event_date: eventDate, days_out: days };

  /* The API says this card's broadcast window has closed: the strip is
   * allowed to step aside (the next card takes over at rollover). */
  const mainMs = Date.parse(nextEvent?.main_card_start_utc || '');
  const apiFinished = Number.isFinite(mainMs) && now > mainMs + 5 * 3600e3;

  if (!inWeek) return { ok: true, applies: false, reason: eventDate ? `featured card is ${days} day(s) out, outside fight week` : 'no featured card date', ...base };
  if (surface === 'finished' || apiFinished) return { ok: true, applies: false, reason: 'broadcast window closed', ...base };

  const watch = /class="hero-watch"/.test(hero.body);
  const strip = /data-watch-state="strip"/.test(hero.body);
  const unavailable = /data-watch-state="unavailable"/.test(hero.body) && hero.body.includes(UNAVAILABLE_TEXT);
  const pending = /data-watch-state="pending"/.test(hero.body) && hero.body.includes(PENDING_TEXT);
  const stripHasContent = strip && (/<time [^>]*dateTime="|<time [^>]*datetime="/i.test(hero.body) || /Watch on|Broadcast on|Broadcaster not yet published/.test(hero.body));

  if (watch && stripHasContent) return { ok: true, applies: true, reason: 'WatchStrip present', ...base };
  if (watch && unavailable) return { ok: true, applies: true, reason: 'explicit broadcast-unavailable state present', ...base };
  if (watch && pending) return { ok: true, applies: true, reason: 'explicit times-to-be-announced state present', ...base };
  return { ok: false, applies: true, reason: `fight-week card (${days} day(s) out) has neither the WatchStrip nor the broadcast-unavailable state (surface=${surface ?? 'missing'})`, ...base };
}

/** Source wiring: the homepage must route every fight-week state to a visible surface. */
export function checkStaticWiring(root) {
  const page = readFileSync(join(root, 'app/page.tsx'), 'utf8');
  const comp = readFileSync(join(root, 'components/HowToWatch.tsx'), 'utf8');
  const problems = [];
  if (!/selectWatchSurface\(/.test(page)) problems.push('app/page.tsx does not call selectWatchSurface()');
  if (!/watchSurface === "unavailable"[\s\S]{0,200}<WatchNotice kind="unavailable"/.test(page)) problems.push('app/page.tsx does not render <WatchNotice kind="unavailable"> for the unavailable surface');
  if (!/data-watch-surface=/.test(page)) problems.push('app/page.tsx lost the data-watch-surface marker this gate reads');
  if (!comp.includes(UNAVAILABLE_TEXT)) problems.push(`components/HowToWatch.tsx lost "${UNAVAILABLE_TEXT}"`);
  if (!/kind="pending"/.test(comp)) problems.push('WatchStrip no longer renders the pending notice for a row with no time and no carrier');
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--static')) {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
    const problems = checkStaticWiring(root);
    console.log(`accept-watch-surface --static: ${problems.length ? 'FAIL' : 'ok'}`);
    for (const p of problems) console.log(`  ${p}`);
    process.exit(problems.length ? 1 : 0);
  }
  const base = (args.find((a) => /^https?:\/\//.test(a)) || process.env.ACCEPT_BASE_URL || 'https://ufc.propbetedge.ai').replace(/\/$/, '');
  const bust = `_accept=${Date.now()}`;
  let html; let nextEvent = null;
  try {
    const r = await fetch(`${base}/?${bust}`, { headers: { 'cache-control': 'no-cache', 'user-agent': 'ufc-accept-watch-surface' } });
    if (!r.ok) { console.error(`homepage HTTP ${r.status}`); process.exit(2); }
    html = await r.text();
  } catch (e) { console.error(`homepage fetch failed: ${e?.message || e}`); process.exit(2); }
  try {
    const r = await fetch(`${base}/api/ufc/next-event?${bust}`, { headers: { accept: 'application/json' } });
    if (r.ok) nextEvent = (await r.json())?.data ?? null;
  } catch { /* the homepage verdict stands on its own */ }

  const v = checkWatchSurface(html, { nextEvent });
  /* Cross-check: the API knows an in-week card the homepage does not feature. */
  if (v.ok && nextEvent?.event_date && v.event_date && nextEvent.event_date !== v.event_date) {
    console.log(`note: /api/ufc/next-event is ${nextEvent.event_date}, homepage features ${v.event_date}`);
  }
  console.log(`accept-watch-surface ${base}: ${v.ok ? 'PASS' : 'FAIL'} — ${v.reason} (surface=${v.surface ?? 'none'}, event_date=${v.event_date ?? 'none'}, days_out=${v.days_out ?? 'n/a'})`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main();
