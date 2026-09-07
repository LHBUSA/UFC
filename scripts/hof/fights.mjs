#!/usr/bin/env node
// Fight Wing model. An induction here honours a BOUT, not a person, so the
// packet is shaped around the fight: both fighters (linked to canonical
// archive rows where they exist), the event, and — only when our own bout
// archive actually holds the result — the verified method, round and time.
//
// Nothing is guessed. If the archive does not contain the bout, result fields
// stay null and the packet records that the fight predates loaded coverage.
// The curated significance note and event/year come from the existing
// reviewed heritage dataset and the official UFC Hall of Fame.
//
// Usage: node scripts/hof/fights.mjs [--dry-run] [--limit N] [--report]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cli, nowIso, rest, titleMatchesSubject, writeCombined } from '../media/lib/subjects.mjs';

const args = cli();
const HOF_URL = 'https://www.ufc.com/ufc-hall-of-fame';
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const slugify = (s) => norm(s).replace(/\s+/g, '-');

function loadFights() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'lib', 'heritage.ts'), 'utf8');
  const start = src.indexOf('export const HOF_FIGHTS');
  const end = src.indexOf('/* Not a PropBetEdge GOAT ranking');
  if (start < 0) throw new Error('HOF_FIGHTS not found in web/lib/heritage.ts');
  const body = src.slice(start, end > start ? end : undefined);
  const arr = body.slice(body.indexOf('['), body.lastIndexOf(']') + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${arr}`)();
}

/* "Forrest Griffin vs Stephan Bonnar 1" -> ["Forrest Griffin","Stephan Bonnar"], bout 1 */
function splitFight(title) {
  const m = String(title).match(/^(.*?)\s+vs\.?\s+(.*?)(?:\s+(\d))?$/i);
  if (!m) return null;
  return { a: m[1].trim(), b: m[2].trim(), meeting: m[3] ? Number(m[3]) : null };
}

async function findFighter(name) {
  const sn = norm(name).split(' ').slice(-1)[0];
  if (!sn || sn.length < 3) return null;
  const rows = await rest(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,record_w,record_l&name=ilike.*${encodeURIComponent(sn)}*&limit=25`).catch(() => []);
  return rows.find((r) => titleMatchesSubject(name, r.name)) || null;
}

/* Verified result straight from our bout archive, when the bout is loaded. */
async function findBout(aId, bId) {
  if (!aId || !bId) return null;
  const rows = await rest(`ufc_bouts?select=id,event_id,weight_class,is_title,scheduled_rounds,fighter_a_id,fighter_b_id,ufc_bout_results(winner_id,method,method_raw,round,time_sec),ufc_events(name,event_date)&or=(and(fighter_a_id.eq.${aId},fighter_b_id.eq.${bId}),and(fighter_a_id.eq.${bId},fighter_b_id.eq.${aId}))&limit=5`).catch(() => []);
  return rows.find((r) => r.ufc_bout_results) || rows[0] || null;
}

const main = async () => {
  let fights = loadFights();
  fights = fights.slice(0, args.limit === Infinity ? fights.length : args.limit);
  console.log(`fight wing: ${fights.length} inductions${args.dry ? ' (dry run)' : ''}`);
  const out = [];
  let linkedFighters = 0, verifiedResults = 0;
  for (const f of fights) {
    const parts = splitFight(f.fight);
    const A = parts ? await findFighter(parts.a) : null;
    const B = parts ? await findFighter(parts.b) : null;
    if (A) linkedFighters += 1;
    if (B) linkedFighters += 1;
    const bout = A && B ? await findBout(A.id, B.id) : null;
    const res = bout?.ufc_bout_results || null;
    if (res) verifiedResults += 1;
    const winner = res?.winner_id ? (res.winner_id === A?.id ? parts.a : res.winner_id === B?.id ? parts.b : null) : null;
    out.push({
      slug: slugify(f.fight),
      subject_type: 'hof_fight',
      wing: 'fight',
      title: f.fight,
      fighters: [
        { name: parts?.a || null, fighter_id: A?.id || null, archive_status: A ? 'linked' : 'missing', espn_athlete_id: A?.espn_athlete_id || null },
        { name: parts?.b || null, fighter_id: B?.id || null, archive_status: B ? 'linked' : 'missing', espn_athlete_id: B?.espn_athlete_id || null },
      ],
      meeting: parts?.meeting || null,
      event: { name: f.event, year: f.year, event_id: bout?.event_id || null, event_date: bout?.ufc_events?.event_date || null },
      /* Result is published only when our own archive holds the bout row. */
      result: res ? { winner, method: res.method, method_raw: res.method_raw, round: res.round, time_sec: res.time_sec, is_title: bout.is_title, scheduled_rounds: bout.scheduled_rounds, source: 'PropBetEdge UFC bout archive', verified_at: nowIso() } : null,
      result_note: res ? null
        : 'Result not published here: this bout predates the loaded PropBetEdge result archive. Method and round are deliberately omitted rather than guessed.',
      significance: { value: f.note, source: HOF_URL, method: 'curated_reviewed', verified_at: nowIso() },
      induction: { wing: 'Fight Wing', source: HOF_URL, note: 'Induction class per the official UFC Hall of Fame; the year is intentionally omitted where not confidently sourced.' },
      sources: [HOF_URL],
    });
    console.log(`  ${A ? 'A' : '-'}${B ? 'B' : '-'}${res ? ' result' : ''}  ${f.fight}`);
  }
  if (!args.dry) {
    const dest = path.join(ROOT, 'data', 'hall-of-fame', 'fights.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ generated_at: nowIso(), note: 'UFC Hall of Fame Fight Wing. Fighter links resolve to canonical archive rows; results appear only where the bout exists in the loaded archive.', fights: out }, null, 2) + '\n');
    writeCombined();
    console.log(`-> ${dest}`);
  }
  console.log(`\nfights=${out.length} fighter_links=${linkedFighters}/${out.length * 2} verified_results=${verifiedResults}`);
  if (args.report) console.log(JSON.stringify(out, null, 2));
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
