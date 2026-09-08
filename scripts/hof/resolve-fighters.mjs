#!/usr/bin/env node
// Resolve Hall of Fame inductees to canonical rows in the PropBetEdge fighter
// archive. Never creates a fighter row: this only links, or records that the
// fighter is genuinely absent and emits a backfill candidate.
//
// Matching ladder (strongest first):
//   1. exact name, case-insensitive
//   2. diacritic- and punctuation-normalized name ("Jose Aldo" = "José Aldo",
//      "Georges St-Pierre" = "Georges St. Pierre", "BJ Penn" = "B.J. Penn")
//   3. curated historical display-name aliases ("Minotauro Nogueira" =
//      "Antonio Rodrigo Nogueira", "Shogun Rua" = "Mauricio Rua")
//   4. surname candidates scored on given-name agreement — a match still has
//      to satisfy the same name lock the media pipeline uses, so "Anderson
//      Silva" can never bind to "Wanderlei Silva".
//
// Usage: node scripts/hof/resolve-fighters.mjs [--dry-run] [--limit N]
//                                               [--slug s] [--report]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cli, listPackets, nowIso, readPacket, rest, titleMatchesSubject, writeCombined, writePacket } from '../media/lib/subjects.mjs';

const args = cli({
  flags: ['--dry-run', '--report'],
  opts: ['--limit', '--slug'],
});

/* Historical / promotional display names the archive may store differently.
 * Each entry is a documented alternate spelling of the SAME person. */
const ALIASES = {
  'minotauro-nogueira': ['Antonio Rodrigo Nogueira', 'Antônio Rodrigo Nogueira', 'Rodrigo Nogueira'],
  'shogun-rua': ['Mauricio Rua', 'Maurício Rua', 'Mauricio Shogun Rua'],
  'bj-penn': ['B.J. Penn', 'Jay Dee Penn'],
  'jose-aldo': ['José Aldo', 'Jose Aldo Junior'],
  'georges-st-pierre': ['Georges St. Pierre', 'Georges St Pierre', 'Georges Saint-Pierre'],
  'joanna-jedrzejczyk': ['Joanna Jędrzejczyk'],
  'khabib-nurmagomedov': ['Khabib Nurmagomedov'],
  'wanderlei-silva': ['Wanderlei Silva'],
  'minotouro-nogueira': ['Antonio Rogerio Nogueira'],
  'charles-mask-lewis': ['Charles Lewis'],
  'kazushi-sakuraba': ['Kazushi Sakuraba'],
  'vitor-belfort': ['Vitor Belfort'],
};

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const surname = (s) => norm(s).split(' ').filter(Boolean).slice(-1)[0] || '';

async function findFighter(name, slug) {
  const tries = [name, ...(ALIASES[slug] || [])];
  /* 1 + 2: exact / normalized on each candidate spelling. */
  for (const t of tries) {
    const rows = await rest(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,record_w,record_l,record_d,record_nc,is_active&name=ilike.${encodeURIComponent(t)}&limit=5`).catch(() => []);
    const hit = rows.find((r) => norm(r.name) === norm(t));
    if (hit) return { fighter: hit, method: norm(hit.name) === norm(name) ? 'exact_name' : 'alias', matched_on: t };
  }
  /* 3 + 4: surname sweep, then the shared name lock decides. */
  const sn = surname(name);
  if (sn.length < 3) return null;
  const rows = await rest(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,record_w,record_l,record_d,record_nc,is_active&name=ilike.*${encodeURIComponent(sn)}*&limit=25`).catch(() => []);
  for (const t of tries) {
    const hit = rows.find((r) => titleMatchesSubject(t, r.name));
    if (hit) return { fighter: hit, method: 'surname_namelock', matched_on: t };
  }
  return null;
}

const main = async () => {
  let packets = listPackets('hall-of-fame').filter((p) => p.subject_type === 'hof_inductee' && p.wing !== 'contributor');
  if (args.slug) packets = packets.filter((p) => p.slug === args.slug);
  packets = packets.slice(0, args.limit === Infinity ? packets.length : args.limit);
  console.log(`hof -> fighter resolution: ${packets.length} inductees${args.dry ? ' (dry run)' : ''}`);
  const map = {}; const missing = []; const counts = { linked: 0, missing: 0 };
  for (const p of packets) {
    const fresh = readPacket('hall-of-fame', p.slug) || p;
    const clean = fresh.name.replace(/[“”"]/g, '');
    const hit = await findFighter(clean, fresh.slug).catch(() => null);
    if (hit) {
      counts.linked += 1;
      const f = hit.fighter;
      map[fresh.slug] = { fighter_id: f.id, fighter_name: f.name, espn_athlete_id: f.espn_athlete_id, ufcstats_id: f.ufcstats_id, method: hit.method, matched_on: hit.matched_on, verified_at: nowIso() };
      fresh.archive = { archive_status: 'linked', ...map[fresh.slug], record: { w: f.record_w, l: f.record_l, d: f.record_d, nc: f.record_nc } };
      console.log(`  linked   ${clean} -> ${f.name} (${hit.method})`);
    } else {
      counts.missing += 1;
      missing.push({ slug: fresh.slug, name: clean, wing: fresh.wing });
      fresh.archive = { archive_status: 'missing', searched_at: nowIso(), note: 'No canonical fighter row matched under exact, normalized, alias or name-locked surname matching. Backfill candidate; no fighter row was created.' };
      console.log(`  missing  ${clean}`);
    }
    if (!args.dry) writePacket('hall-of-fame', fresh.slug, fresh);
  }
  if (!args.dry) {
    const dest = path.join(ROOT, 'data', 'hall-of-fame', '_fighter-map.json');
    fs.writeFileSync(dest, JSON.stringify({ generated_at: nowIso(), note: 'Explicit Hall of Fame to canonical fighter mapping. Linked entries reference an existing ufc_fighters row; missing entries are backfill candidates and never create rows.', linked: map, backfill_candidates: missing }, null, 2) + '\n');
    const c = writeCombined();
    console.log(`map -> ${dest}; combined -> ${c.dest}`);
  }
  console.log(`\nlinked=${counts.linked} missing=${counts.missing}`);
  if (args.report) console.log(JSON.stringify({ map, missing }, null, 2));
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
