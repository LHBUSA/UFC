#!/usr/bin/env node
/**
 * TUF 33 — matrix simulation of the HELD finale-link proposals. READ-ONLY.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/simulate_tuf33_finale_links.mjs --tmp <empty scratch dir>
 *
 * Copies scripts/tuf, web/lib and web/data/tuf into --tmp and runs the unchanged
 * scripts/tuf/completeness_matrix.mjs there for three states, each on its own copy:
 *   before           current main
 *   welterweight     + verified_against on the welterweight final only
 *   both             + verified_against on both finals
 * The proposals come from scripts/tuf/evidence/tuf33_finale_link_proposal_2026-09-13.json.
 * The matrix makes read-only database selects. Writes only
 * scripts/tuf/evidence/tuf33_finale_links_matrix_simulation_2026-09-13.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const TMP = argv.includes('--tmp') ? path.resolve(argv[argv.indexOf('--tmp') + 1]) : null;
if (!TMP) { console.error('--tmp <dir> required'); process.exit(2); }
if (fs.existsSync(TMP) && fs.readdirSync(TMP).length) { console.error(`${TMP} must be empty`); process.exit(2); }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const proposal = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf33_finale_link_proposal_2026-09-13.json'));

function run(tag, divisions) {
  const root = path.join(TMP, tag);
  for (const rel of ['scripts/tuf', 'web/lib', 'web/data/tuf']) fs.cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  const seasonPath = path.join(root, 'web', 'data', 'tuf', 'seasons', 'tuf-33.json');
  const season = readJson(seasonPath);
  const applied = [];
  for (const rec of proposal.records.filter((r) => divisions.includes(r.final.weight_class))) {
    const wc = season.bracket.find((x) => x.weight_class === rec.final.weight_class);
    const b = wc.stages.find((s) => s.stage === 'final').bouts.find((x) => x.a === rec.final.a && x.b === rec.final.b);
    if (!b || (b.verified_against ?? null) !== rec.old) throw new Error(`${rec.repair_key}: final not found or old value differs`);
    b.verified_against = rec.new;
    applied.push(rec.repair_key);
  }
  fs.writeFileSync(seasonPath, JSON.stringify(season, null, 2) + '\n');
  const out = path.join(root, 'matrix.json');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'tuf', 'completeness_matrix.mjs'), '--as-of', '2026-09-13', '--out-json', out, '--out-md', path.join(root, 'matrix.md'), '--out-status', path.join(root, 'status.json')], { cwd: root, env: process.env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  return { applied, matrix: readJson(out) };
}

const states = { before: run('before', []), welterweight: run('welterweight', ['Welterweight']), both: run('both', ['Welterweight', 'Flyweight']) };
const seasonOf = (m, slug) => m.seasons.find((s) => s.slug === slug);
const view = (s) => ({
  status: s.status, structure: s.structure, score: s.score, blockers: s.blockers, final_not_verified: s.blockers.includes('FINAL_NOT_VERIFIED'),
  finals: s.bouts.filter((b) => b.stage === 'final').map((b) => ({ bout: `${b.a} vs ${b.b}`, result: b.result_verification, evidence: b.result_evidence, db_finale_bout: b.db_finale_bout, bout_blockers: b.blockers })),
  finals_verified: s.bouts.filter((b) => b.stage === 'final' && b.result_verification === 'verified').length,
  professional_final_linked: s.finale.professional_final_linked, hub_card: s.season_state === 'ongoing' ? 'Season ongoing' : s.structure === 'complete' ? (s.status === 'COMPLETE' ? 'Complete + Verified' : 'Complete') : 'Partial',
});
const others = (a, b) => a.matrix.seasons.filter((s) => s.slug !== 'tuf-33' && JSON.stringify(s) !== JSON.stringify(seasonOf(b.matrix, s.slug))).map((s) => s.slug);
const totals = (m) => ({ finals_verified: m.totals.finals_verified, result_verified: m.totals.result_verified, finale_links_verified: m.totals.finale_links_verified, complete: m.totals.complete, partial: m.totals.partial, blocked: m.totals.blocked });
const hubCounts = (m) => m.seasons.reduce((o, s) => { const k = view(s).hub_card; return { ...o, [k]: (o[k] || 0) + 1 }; }, {});
const fresh = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf_completeness_2026-09-13.after_tuf5_tuf6_nsac.json'));

const report = {
  _about: 'Measured simulation of HELD proposals, not applied. Each state ran the unchanged exact-verifier matrix on its own temporary copy with read-only database selects.',
  proposal: 'scripts/tuf/evidence/tuf33_finale_link_proposal_2026-09-13.json',
  before_equals_committed_main_matrix: JSON.stringify(states.before.matrix.seasons) === JSON.stringify(fresh.seasons),
  states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { applied: v.applied, tuf33: view(seasonOf(v.matrix, 'tuf-33')), totals: totals(v.matrix), hub_cards: hubCounts(v.matrix), other_seasons_changed_vs_before: others(states.before, v) }])),
};
fs.writeFileSync(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf33_finale_links_matrix_simulation_2026-09-13.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));
