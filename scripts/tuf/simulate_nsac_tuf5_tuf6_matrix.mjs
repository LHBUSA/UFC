#!/usr/bin/env node
/**
 * TUF 5 + TUF 6 — matrix simulation of the proposed NSAC reconciliation. READ-ONLY.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/simulate_nsac_tuf5_tuf6_matrix.mjs --tmp <empty scratch dir>
 *
 * Copies scripts/tuf, web/lib and web/data/tuf into --tmp, runs the unchanged
 * scripts/tuf/completeness_matrix.mjs there (BEFORE), applies the audited proposal
 * from scripts/tuf/evidence/nsac_tuf5_tuf6_audit_2026-09-13.json to the COPY only
 * (the TUF 3/4 apply shape: commission result_sources, winner/method/round/time
 * from the record, fight_date, commission classification basis with the former
 * record-absence basis as corroboration, ledger document + records), runs the
 * matrix again (IF APPLIED). The matrix makes read-only database selects. Conflicts,
 * stage statuses, rosters, identities, episodes and finals are not touched.
 * Writes only scripts/tuf/evidence/nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json.
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
const AS_OF = '2026-09-13';
const OUT = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

for (const rel of ['scripts/tuf', 'web/lib', 'web/data/tuf']) fs.cpSync(path.join(ROOT, rel), path.join(TMP, rel), { recursive: true });

function runMatrix(tag) {
  const out = path.join(TMP, `matrix.${tag}.json`);
  const r = spawnSync(process.execPath, [path.join(TMP, 'scripts', 'tuf', 'completeness_matrix.mjs'), '--as-of', AS_OF, '--out-json', out, '--out-md', path.join(TMP, `matrix.${tag}.md`), '--out-status', path.join(TMP, `status.${tag}.json`)],
    { cwd: TMP, env: process.env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  const m = readJson(out);
  return Array.isArray(m.seasons) ? m.seasons : Object.values(m.seasons);
}
const metrics = (s) => ({
  status: s.status, structure: s.structure, blockers: s.blockers, critical_blockers: s.critical_blockers, score: s.score, depth_score: s.depth.depth_score,
  result_verified: s.tournament.result_verified, bouts: s.tournament.bouts_present, secondary_only: s.tournament.result_partial,
  house_commission_verified: s.depth.house_bouts_commission_verified, exhibitions_commission_backed: s.depth.exhibition_commission_backed,
  exhibitions: s.tournament.exhibition, classification_unresolved: s.tournament.classification_unresolved, house_bouts_with_fight_date: s.depth.house_bouts_with_fight_date,
  house_verified_by_later_db_pairing: s.bouts.filter((b) => b.stage !== 'final' && !b.on_finale_card && (b.db_pairing || []).some((p) => p.winner_matches_archive)).map((b) => `${b.a} vs ${b.b}`),
});

const before = runMatrix('before');

/* ---- apply the audited proposal to the copy ---- */
const audit = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf5_tuf6_audit_2026-09-13.json'));
const DATA = path.join(TMP, 'web', 'data', 'tuf');
const ledger = readJson(path.join(DATA, 'commission_records.json'));
const BATCH = 'tuf5-tuf6-nsac-simulation';
const applied = {};
for (const slug of ['tuf-5', 'tuf-6']) {
  const A = audit.seasons[slug];
  if (A.summary.matched !== 14 || A.summary.unmatched || A.summary.ambiguous || A.summary.duplicate_use.length || A.summary.unused_records.length) throw new Error(`${slug}: not 14/14 deterministic`);
  const D = A.document;
  ledger.documents.push({ id: D.id, source_family: D.source_family, source_type: D.source_type, commission: D.commission, jurisdiction: D.jurisdiction, document: D.document, seasons: D.seasons,
    url: D.url, archive_url: D.archive_url, sha256: D.sha256, pages: D.pages, retrieved: D.retrieved, live_matches_archive: D.live_matches_archive, title_quote: D.title_quote,
    location: D.location, promoter: D.promoter, executive_director: D.executive_director, classification_language: D.classification_language, officials: D.officials, season_identity: D.season_identity });
  const AUDIT_ONLY = ['winner_surname', 'weight_class', 'stage', 'rounds_printed', 'scores_printed', 'reading'];
  const records = A.records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !AUDIT_ONLY.includes(k))));
  ledger.records.push(...records);

  const seasonPath = path.join(DATA, 'seasons', `${slug}.json`);
  const season = readJson(seasonPath);
  const tally = { bouts: 0, winner: 0, method: 0, round: 0, time: 0 };
  for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
    if (b.on_finale_card) continue;
    const row = A.bouts.find((x) => x.bout === `${b.a} vs ${b.b}` && x.stage === st.stage);
    const rec = records.find((r) => r.id === row?.record_id);
    if (!row || row.match !== 'deterministic' || !rec || !rec.winner) throw new Error(`${slug} ${b.a} vs ${b.b}: no deterministic record`);
    const doc = { family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record', jurisdiction: D.jurisdiction, commission: D.commission, document_id: D.id, record_id: rec.id, url: D.url, archive_url: D.archive_url, sha256: D.sha256, retrieved: D.retrieved };
    const corrections = [];
    for (const f of ['winner', 'method', 'round', 'time']) {
      if ((b[f] ?? null) !== (rec[f] ?? null)) { corrections.push({ field: f, kind: 'commission_correction', old: b[f] ?? null, new: rec[f], source: { document_id: D.id, record_id: rec.id }, reason: 'simulation', batch: BATCH }); tally[f] += 1; }
    }
    Object.assign(b, { winner: rec.winner, method: rec.method, round: rec.round, time: rec.time, fight_date: rec.date, fight_date_source: { document_id: D.id, record_id: rec.id }, commission_record_id: rec.id });
    if (corrections.length) b.corrections = [...(b.corrections || []), ...corrections];
    b.result_sources = [{ ...doc, winner: rec.winner, quote: rec.result_text }];
    b.classification = 'exhibition';
    b.classification_basis = { affirmative: [{ ...doc, quote: D.classification_language.quote }], corroborating: b.classification_source ? [{ kind: 'record_absence', family: 'our_records', evidence_level: 'corroboration_only', quote: b.classification_source, former_authority: true }] : [], authority: 'affirmative' };
    b.classification_source = `exhibition: the Nevada State Athletic Commission record lists it under "${D.classification_language.quote}" (commission_record ${rec.id}, ${rec.date})`;
    tally.bouts += 1;
  }
  fs.writeFileSync(seasonPath, JSON.stringify(season, null, 2) + '\n');
  applied[slug] = tally;
}
fs.writeFileSync(path.join(DATA, 'commission_records.json'), JSON.stringify(ledger, null, 2) + '\n');

const after = runMatrix('after');
const bySlug = (list) => Object.fromEntries(list.map((s) => [s.slug, s]));
const B = bySlug(before), Af = bySlug(after);
const changed = Object.keys(B).filter((k) => B[k].status !== Af[k]?.status || JSON.stringify(B[k].blockers) !== JSON.stringify(Af[k]?.blockers) || B[k].tournament.result_verified !== Af[k]?.tournament.result_verified);
const totals = (list) => ({ complete: list.filter((s) => s.status === 'COMPLETE').length, partial: list.filter((s) => s.status === 'PARTIAL').length, blocked: list.filter((s) => s.status === 'BLOCKED').length });

const report = {
  _about: 'Measured simulation, not applied. A temporary copy of scripts/tuf, web/lib and web/data/tuf had the TUF 5 and TUF 6 proposals from nsac_tuf5_tuf6_audit_2026-09-13.json applied (commission result_sources, commission winner/method/round/time, fight_date, commission classification basis with the former record-absence basis as corroboration, ledger document + records); the unchanged scripts/tuf/completeness_matrix.mjs ran against the copy before and after, with read-only database selects. Conflicts, stage statuses, rosters, identities, episodes and finals untouched. Repository data unchanged.',
  as_of: AS_OF, script: 'scripts/tuf/simulate_nsac_tuf5_tuf6_matrix.mjs',
  applied_to_copy: applied,
  seasons: Object.fromEntries(['tuf-5', 'tuf-6'].map((k) => [k, { before: metrics(B[k]), if_applied: metrics(Af[k]) }])),
  seasons_with_changed_verdict_or_counts: changed,
  totals_before: totals(before), totals_if_applied: totals(after),
  generic_matrix_observation: {
    finding: 'A house (exhibition) bout is counted "verified" when a LATER professional bout between the same two fighter ids has the same winner (dbVerified in completeness_matrix.mjs does not require the result row to be the house bout itself). Reported only; no matrix rule changed.',
    house_bouts_affected_before: before.flatMap((s) => s.bouts.filter((b) => b.stage !== 'final' && !b.on_finale_card && (b.db_pairing || []).some((p) => p.winner_matches_archive)).map((b) => `${s.slug}: ${b.a} vs ${b.b} (${b.db_pairing.filter((p) => p.winner_matches_archive).map((p) => `${p.event} ${p.date}`).join('; ')})`)),
    tuf_1_to_4_affected: before.filter((s) => ['tuf-1', 'tuf-2', 'tuf-3', 'tuf-4'].includes(s.slug)).some((s) => s.bouts.some((b) => b.stage !== 'final' && !b.on_finale_card && (b.db_pairing || []).some((p) => p.winner_matches_archive))),
  },
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));
