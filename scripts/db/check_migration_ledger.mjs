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
 * probe. These filenames are frozen: renaming one desynchronises every
 * environment that already ran it, and the mismatch is invisible until a fresh
 * environment applies it a second time.
 *
 * THE LEDGER IN THE DATABASE CANNOT ANSWER THIS QUESTION
 *
 * supabase_migrations.schema_migrations exists, but its versions correspond to
 * nothing in this repository: production records ufc_phase1_core as
 * 20260905230410 while the file is 20260906000001_ufc_phase1_core.sql, and none
 * of the repo's seventeen versions appear in it at all. Every migration here was
 * applied by executing SQL rather than through the CLI, so the CLI's bookkeeping
 * was never written. `supabase db push` would therefore consider the entire
 * directory unapplied and re-run all of it. That is why this list is maintained
 * by hand against a schema probe, and why scripts/db/apply_supabase_migration.ps1
 * addresses files by path.
 *
 * A CORRECTION, KEPT VISIBLE BECAUSE IT COST SOMETHING
 *
 * 20260906000006_ufc_media_registry_videos was renumbered to ...16 on the belief
 * that it was unapplied. A probe run immediately before applying the batch found
 * ufc_images_kind_check already widened to five kinds, 540 image rows including
 * public_domain, ufc_video_channels at 8 rows and ufc_videos at 63: applied in
 * substance, under its pre-renumber identity. It is listed under BOTH names
 * under its new name, and the rename is recorded in RENAMED_AFTER_APPLY so the
 * frozen-name check does not demand a file that no longer exists. Nothing needs
 * re-running. The lesson is the general one - the applied set must be probed,
 * never inferred from which files a branch happens to carry.
 */

/**
 * old filename -> new filename, for a migration that was renamed AFTER it had
 * already been applied. There should never be a second entry here. It exists so
 * the rename is recorded rather than smoothed over: a fresh environment applying
 * this directory runs the file under its new name and gets the right schema, but
 * anyone comparing production's history to these filenames needs to know why the
 * numbers do not line up.
 */
export const RENAMED_AFTER_APPLY = new Map([
  ['20260906000006_ufc_media_registry_videos.sql', '20260908000016_ufc_media_registry_videos.sql'],
]);
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

  // Applied 2026-09-08 as a single chained transaction, after a BEGIN..ROLLBACK
  // proof of the same seven files in the same order against the live schema.
  '20260907000010_store_provisioning.sql',
  '20260908000010_ufc_model_predictions.sql',
  '20260908000011_ufc_fighter_status.sql',
  '20260908000012_ufc_judge_intelligence.sql',
  '20260908000013_ufc_weigh_ins.sql',
  '20260908000014_referee_view_security.sql',
  '20260908000015_store_orders.sql',

  // Applied before the renumber, under the old name in RENAMED_AFTER_APPLY.
  '20260908000016_ufc_media_registry_videos.sql',

  // Applied 2026-09-09 after a BEGIN..ROLLBACK proof, a double-apply proof of
  // idempotence, and a BEGIN..ROLLBACK proof of its own rollback file. Purely
  // additive; no deployed Worker, the API or the website reads any of it yet.
  '20260909180000_ufc_news_pipeline.sql',

  // Applied 2026-09-13 after a BEGIN..ROLLBACK proof; probe: table present,
  // RLS on. Additive.
  '20260913000001_ufc_dwcs_outcome_claims.sql',
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
  if (supa.some((r) => r.file === name)) continue;
  // A rename that is recorded is a documented fact; a rename that is not is the
  // failure this check exists to catch.
  const renamedTo = RENAMED_AFTER_APPLY.get(name);
  if (renamedTo && supa.some((r) => r.file === renamedTo)) continue;
  problems.push(`APPLIED migration ${name} is missing or was renamed; an applied migration must never move`);
}
for (const [oldName, newName] of RENAMED_AFTER_APPLY) {
  if (!APPLIED.has(newName)) {
    problems.push(`${oldName} is recorded as renamed to ${newName}, but ${newName} is not in APPLIED`);
  }
}
for (const r of [...root, ...supa]) {
  if (!r.version) problems.push(`${r.dir}/${r.file} does not carry a parseable version number`);
}

const ledger = {
  generated_at: new Date().toISOString(),
  applied_boundary: '20260908000016_ufc_media_registry_videos.sql',
  renamed_after_apply: Object.fromEntries(RENAMED_AFTER_APPLY),
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
