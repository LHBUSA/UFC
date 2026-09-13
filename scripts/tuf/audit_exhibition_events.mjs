#!/usr/bin/env node
/**
 * Prove that no TUF in-house event sits in our professional tables.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env node scripts/tuf/audit_exhibition_events.mjs
 *
 * READ-ONLY. Two independent checks, because a name rule alone would miss an
 * event stored under a different name:
 *
 *   1. every ufc_events row, by name, against shared/tuf_guard.mjs
 *   2. every bout in the season files classified exhibition or unverified,
 *      by the two canonical fighter ids, against ufc_bouts: a house bout that
 *      appears as a stored bout between the same two fighters within the
 *      season's year is reported for a human to look at (a rematch on a real
 *      card is legitimate, so this reports, it does not fail)
 *
 * Exits non-zero only on check 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tufInHouseEventReason } from '../../shared/tuf_guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');

function loadEnv() {
  const file = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  }
  return env;
}

async function selectAll(env, table, query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?${query}`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${table} ${res.status}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const env = loadEnv();
const events = await selectAll(env, 'ufc_events', 'select=id,name,event_date,espn_event_id,ufcstats_id&order=id');
const flagged = events.map((e) => ({ ...e, reason: tufInHouseEventReason(e.name) })).filter((e) => e.reason);
console.log(`ufc_events scanned ${events.length}; TUF in-house events stored: ${flagged.length}`);
for (const e of flagged) console.log(`  ! ${e.event_date} ${e.name} (${e.id})`);

const bouts = await selectAll(env, 'ufc_bouts', 'select=id,fighter_a_id,fighter_b_id,event_id&order=id');
const dateOf = new Map(events.map((e) => [e.id, e.event_date]));
const pairKey = (a, b) => [a, b].sort().join('|');
const stored = new Map();
for (const b of bouts) {
  const k = pairKey(b.fighter_a_id, b.fighter_b_id);
  if (!stored.has(k)) stored.set(k, []);
  stored.get(k).push({ id: b.id, date: dateOf.get(b.event_id) });
}
const inventory = JSON.parse(fs.readFileSync(path.join(DATA, 'seasons.json'), 'utf8'));
let checked = 0;
const sameYear = [];
for (const row of inventory.seasons) {
  const file = path.join(DATA, 'seasons', `${row.slug}.json`);
  if (!fs.existsSync(file)) continue;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const div of d.bracket || []) for (const st of div.stages) for (const b of st.bouts) {
    if (b.classification === 'professional' || !b.a_fighter_id || !b.b_fighter_id) continue;
    checked += 1;
    for (const s of stored.get(pairKey(b.a_fighter_id, b.b_fighter_id)) || []) {
      if (s.date && Math.abs(Number(s.date.slice(0, 4)) - row.year) <= 1) sameYear.push({ season: row.slug, bout: `${b.a} vs ${b.b}`, stage: st.stage, stored_bout: s.id, date: s.date });
    }
  }
}
console.log(`house bouts with both fighters resolved: ${checked}; same pair stored as a bout within a year of the season: ${sameYear.length}`);
for (const x of sameYear) console.log(`  ? ${x.season} ${x.stage} ${x.bout} — stored bout ${x.stored_bout} on ${x.date}`);
process.exitCode = flagged.length ? 1 : 0;
