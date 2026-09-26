#!/usr/bin/env node
// Write verified research facts (verify_research.mjs output) through enrich.mjs, one CLI call per fact.
//
//   node scripts/training/apply_verified.mjs verified.json [--dry]
//
// Rules: oldest source first (the newest fact ends up current); a camp is linked only on an exact
// name/alias match (research never creates camps: that is how duplicates are born); a switch or a
// temporary camp whose gym does not resolve exactly is skipped and reported. Coaches may be created
// (exact normalized-name reuse first). The quote goes into evidence_note.
//
// A switch is applied only when its destination IS the fighter's current camp: an undated switch sorts at
// capture time, so a stale "moved to X" article must never override today's observed camp. Other switches
// are reported for review. A coach with a stated discipline suppresses the same coach recorded as OTHER.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const facts = JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith('--')), 'utf8'))
  .sort((a, b) => String(a.source_published || '').localeCompare(String(b.source_published || '')));

function cli(argv) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(HERE, 'enrich.mjs'), ...argv, ...(DRY ? ['--dry'] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}
const exactCamp = (gym) => {
  if (!gym) return null;
  const r = cli(['find-camp', gym]);
  if (!r.ok) return null;
  const j = JSON.parse(r.out);
  return j.exact?.length === 1 ? `slug:${j.exact[0].slug}` : null;
};

const withRole = new Set(facts.filter((x) => x.kind === 'coach' && x.coach_role && x.coach_role !== 'OTHER').map((x) => `${x.espn_athlete_id}|${x.coach_name}`));
async function currentCampSlug(espn) {
  const [f] = await get(`ufc_fighters?select=id&espn_athlete_id=eq.${espn}`);
  if (!f) return null;
  const [c] = await get(`ufc_fighter_training_current?select=current_camp&fighter_id=eq.${f.id}`);
  return c?.current_camp?.slug ? `slug:${c.current_camp.slug}` : null;
}
const common = (x) => ['--fighter', String(x.espn_athlete_id), '--source', x.source_url,
  ...(x.source_published ? ['--published', x.source_published] : []), '--note', String(x.quote).slice(0, 480)];
const seen = new Set();
const report = { applied: 0, duplicate: 0, skipped: [], failed: [] };
for (const x of facts) {
  let argv;
  if (x.kind === 'coach') {
    const key = `${x.espn_athlete_id}|${x.coach_name}|${x.coach_role}`;
    if (seen.has(key)) continue; seen.add(key);
    if ((x.coach_role || 'OTHER') === 'OTHER' && withRole.has(`${x.espn_athlete_id}|${x.coach_name}`)) continue;
    argv = ['coach', ...common(x), '--coach', x.coach_name, '--role', x.coach_role || 'OTHER', '--create'];
    const camp = exactCamp(x.gym); if (camp) argv.push('--camp', camp);
  } else if (x.kind === 'training_location' || x.kind === 'fighting_out_of') {
    argv = [x.kind.replace(/_/g, '-'), ...common(x)];
    for (const k of ['city', 'region', 'country']) if (x[k]) argv.push(`--${k}`, x[k]);
    if (x.kind === 'training_location') { const camp = exactCamp(x.gym); if (camp) argv.push('--camp', camp); }
  } else if (x.kind === 'switch') {
    const to = exactCamp(x.gym);
    if (!to) { report.skipped.push({ fighter: x.fighter, kind: x.kind, why: `camp "${x.gym}" has no exact match` }); continue; }
    const cur = await currentCampSlug(x.espn_athlete_id);
    if (to !== cur) { report.skipped.push({ fighter: x.fighter, kind: x.kind, why: `switch to ${to} but current camp is ${cur}; review` }); continue; }
    argv = ['switch', ...common(x), '--to', to];
    const from = exactCamp(x.from_gym); if (from) argv.push('--from', from);
    if (x.effective) argv.push('--effective', x.effective);
  } else if (x.kind === 'temporary_camp') {
    const camp = exactCamp(x.gym);
    if (!camp) { report.skipped.push({ fighter: x.fighter, kind: x.kind, why: `camp "${x.gym}" has no exact match` }); continue; }
    argv = ['camp', ...common(x), '--camp', camp, '--type', 'TEMPORARY_CAMP'];
  } else continue;
  const r = cli(argv);
  if (!r.ok) { report.failed.push({ fighter: x.fighter, kind: x.kind, error: r.out }); continue; }
  if (/"duplicate"/.test(r.out)) report.duplicate += 1; else report.applied += 1;
}
console.log(JSON.stringify(report, null, 1));
