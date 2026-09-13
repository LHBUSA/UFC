#!/usr/bin/env node
/**
 * Verify TUF tournament finals against our own results, by canonical fighter id.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env node scripts/tuf/verify_finals_by_id.mjs [--write]
 *
 * READ-ONLY against the database. scripts/tuf/verify_classifications.mjs does
 * this by name, and an accent defeated it: TUF 8's lightweight final, TUF 14's
 * featherweight final and TUF 18's women's final were all fought on the finale
 * card and are all in ufc_bouts, but "Efraín", "Brandão" and "Peña" did not
 * match, so the three bouts stayed 'unverified'.
 *
 * A final is promoted to 'professional' only when ALL of these hold:
 *   - the bout is in a `final` stage and marked on_finale_card
 *   - both corners carry canonical fighter ids
 *   - ufc_bouts holds a bout between exactly those two ids, on an event dated
 *     within a day of the season's finale date or its verified final date
 *   - that bout has a stored result, and its winner is the archive's winner
 * Anything else is reported and left as it is. Nothing is demoted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');

function loadEnv() {
  const file = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv();
async function q(pathq) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${pathq}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!res.ok) throw new Error(`${pathq.split('?')[0]} ${res.status}`);
  return res.json();
}
const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400e3);

const inventory = JSON.parse(fs.readFileSync(path.join(DATA, 'seasons.json'), 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(DATA, 'identity.index.json'), 'utf8'));
const report = { promoted: [], already: 0, skipped: [] };

for (const row of inventory.seasons) {
  const file = path.join(DATA, 'seasons', `${row.slug}.json`);
  if (!fs.existsSync(file)) continue;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  const dates = [row.finale_date, ...(row.final_bouts || []).map((f) => f.date)].filter(Boolean);
  for (const div of d.bracket || []) for (const st of div.stages) {
    if (st.stage !== 'final') continue;
    for (const b of st.bouts) {
      if (b.classification === 'professional') { report.already += 1; continue; }
      const label = `${row.slug} ${div.weight_class}: ${b.a} vs ${b.b}`;
      if (!b.on_finale_card) { report.skipped.push(`${label} — not marked on the finale card`); continue; }
      if (!b.a_fighter_id || !b.b_fighter_id) { report.skipped.push(`${label} — a corner has no canonical id`); continue; }
      if (!b.winner) { report.skipped.push(`${label} — no winner recorded (season not decided)`); continue; }
      const winnerId = identity[row.slug]?.[b.winner] || (b.winner === b.a ? b.a_fighter_id : b.winner === b.b ? b.b_fighter_id : null);
      if (!winnerId) { report.skipped.push(`${label} — winner ${b.winner} has no canonical id`); continue; }
      const ids = `${b.a_fighter_id},${b.b_fighter_id}`;
      const stored = await q(`ufc_bouts?select=id,status,ufc_events(name,event_date),ufc_bout_results(winner_id,method,round)&fighter_a_id=in.(${ids})&fighter_b_id=in.(${ids})`);
      const onFinale = stored.filter((s) => s.ufc_events?.event_date && (dates.length ? dates.some((dt) => dayDiff(dt, s.ufc_events.event_date) <= 1) : false));
      if (onFinale.length !== 1) { report.skipped.push(`${label} — ${onFinale.length} stored bouts between these ids on the finale date (${dates.join('/') || 'no finale date'})`); continue; }
      const s = onFinale[0];
      const result = Array.isArray(s.ufc_bout_results) ? s.ufc_bout_results[0] : s.ufc_bout_results;
      if (!result?.winner_id) { report.skipped.push(`${label} — stored bout ${s.id} has no result yet`); continue; }
      if (result.winner_id !== winnerId) { report.skipped.push(`${label} — stored winner differs from the archive's (${s.id}); not promoted`); continue; }
      b.classification = 'professional';
      b.classification_source = `contested on a sanctioned UFC card; verified by canonical fighter id against ufc_bouts ${s.id} (${s.ufc_events.name}, ${s.ufc_events.event_date}) + ufc_bout_results — the recorded winner is the archive's winner`;
      b.fight_date = b.fight_date || s.ufc_events.event_date;
      b.verified_against = `ufc_bouts:${s.id}`;
      report.promoted.push(`${label} — ${s.ufc_events.name} ${s.ufc_events.event_date}`);
      changed = true;
    }
  }
  if (changed && WRITE) fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
}
console.log(`already professional: ${report.already}`);
console.log(`promoted${WRITE ? '' : ' (dry run)'}: ${report.promoted.length}`);
for (const p of report.promoted) console.log(`  + ${p}`);
console.log(`left as they are: ${report.skipped.length}`);
for (const s of report.skipped) console.log(`  - ${s}`);
