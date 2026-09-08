#!/usr/bin/env node
/**
 * One migration sequence, one meaning. Fails the build when two migrations
 * claim the same number.
 *
 *   node scripts/db/check_migration_ledger.mjs
 *   node scripts/db/check_migration_ledger.mjs --json docs/migration_ledger.json
 *
 * WHY THIS EXISTS
 *
 * This repository kept two parallel ledgers - hand-numbered `migrations/` and
 * timestamped `supabase/migrations/` - while five feature branches ran at once.
 * Each branch picked the next free number against the branch it forked from,
 * which is the right thing to do locally and produces a collision the moment
 * two of them merge. Unifying the branches turned up four:
 *
 *   migrations/006_ufc_image_candidates      vs 006_ufc_media_registry_videos
 *   migrations/011_store_orders              vs 011_ufc_model_predictions
 *   supabase/20260906000006_official_videos  vs 20260906000006_media_registry_videos
 *   supabase/20260908000011_store_orders     vs 20260908000011_ufc_fighter_status
 *
 * A duplicate number is not a cosmetic problem. `supabase db push` applies by
 * version; two files claiming one version means a fresh environment applies an
 * arbitrary one of them and silently skips the other. The failure surfaces
 * later, as a missing table, in whichever environment lost the coin toss.
 *
 * Renumbering is only safe for migrations that have never been applied, so this
 * script also refuses to let an APPLIED migration be renumbered: the applied
 * set is listed explicitly and checked by name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const jsonOut = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();

/**
 * Migrations confirmed applied to the production project, by information_schema
 * probe on 2026-09-09. These filenames are frozen: renaming one desynchronises
 * every environment that already ran it, and the mismatch is invisible until a
 * fresh environment applies it a second time.
 */
export const APPLIED = new Set([
  '20260906000001_ufc_phase1_core.sql',
  '20260906000002_ufc_result_enrichment.sql',
  '20260906000003_ufc_rankings.sql',
  '20260906000004_ufc_fight_dna.sql',
  '20260906000005_ufc_fight_state_ledger.sql',
  '20260906000006_ufc_official_videos.sql',
  '20260906000007_ufc_video_channels.sql',
  '20260907000008_ufc_referee_intelligence.sql',
  '20260907000009_ufc_market.sql',
]);

const parse = (dir, re) => fs.readdirSync(path.join(ROOT, dir))
  .filter((f) => f.endsWith('.sql'))
  .map((file) => {
    const m = file.match(re);
    return { dir, file, version: m ? m[1] : null, slug: m ? m[2] : file };
  });

function collisions(rows) {
  const byVersion = new Map();
  for (const r of rows) {
    if (!r.version) continue;
    if (!byVersion.has(r.version)) byVersion.set(r.version, []);
    byVersion.get(r.version).push(r);
  }
  return [...byVersion.entries()].filter(([, v]) => v.length > 1);
}

const root = parse('migrations', /^(\d{3})_(.+)\.sql$/);
const supa = parse('supabase/migrations', /^(\d{14})_(.+)\.sql$/);

const problems = [];
for (const [version, rows] of collisions(root)) {
  problems.push(`migrations/: ${rows.length} files claim ${version} -> ${rows.map((r) => r.file).join(', ')}`);
}
for (const [version, rows] of collisions(supa)) {
  problems.push(`supabase/migrations/: ${rows.length} files claim ${version} -> ${rows.map((r) => r.file).join(', ')}`);
}
for (const name of APPLIED) {
  if (!supa.some((r) => r.file === name)) problems.push(`APPLIED migration ${name} is missing or was renamed; an applied migration must never move`);
}
for (const r of [...root, ...supa]) {
  if (!r.version) problems.push(`${r.dir}/${r.file} does not carry a parseable version number`);
}

const ledger = {
  generated_at: new Date().toISOString(),
  applied_boundary: '20260907000009_ufc_market.sql',
  root: root.sort((a, b) => a.file.localeCompare(b.file)).map((r) => ({ ...r, applied: null })),
  supabase: supa.sort((a, b) => a.file.localeCompare(b.file)).map((r) => ({ ...r, applied: APPLIED.has(r.file) })),
  collisions: problems.length,
  problems,
};
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.join(ROOT, jsonOut)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, jsonOut), `${JSON.stringify(ledger, null, 2)}\n`);
}

console.log(`root migrations:     ${root.length}`);
console.log(`supabase migrations: ${supa.length}  (${supa.filter((r) => APPLIED.has(r.file)).length} applied, ${supa.filter((r) => !APPLIED.has(r.file)).length} pending)`);
console.log('\npending, in application order:');
for (const r of supa.filter((x) => !APPLIED.has(x.file)).sort((a, b) => a.version.localeCompare(b.version))) {
  console.log(`  ${r.version}  ${r.slug}`);
}
if (problems.length) {
  console.error(`\nMIGRATION LEDGER FAILED (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nno duplicate migration versions; no applied migration has moved.');
