#!/usr/bin/env node
/**
 * Impact audit of the exact result-verification rule. READ-ONLY, no network.
 *
 *   node scripts/tuf/audit_matrix_exact_verification.mjs
 *
 * Compares the matrix produced under the old rule (committed
 * scripts/tuf/evidence/tuf_completeness_2026-09-13.after_tuf3_tuf4_nsac.json,
 * byte-for-byte the same verdicts as a fresh old-rule run) with the corrected
 * matrix (tuf_completeness_2026-09-13.after_exact_verification.json).
 *
 * Old rule: dbVerified = ANY ufc_bouts row between the two fighter ids whose
 * winner is the archive winner — for every TUF bout, house or final.
 * New rule: scripts/tuf/lib/boutVerification.mjs — only the exact finale-card row.
 *
 * Writes scripts/tuf/evidence/tuf_matrix_exact_verification_impact_2026-09-13.json
 * and docs/tuf/tuf_matrix_exact_verification_impact_2026-09-13.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EV = path.join(ROOT, 'scripts', 'tuf', 'evidence');
const OLD = 'tuf_completeness_2026-09-13.after_tuf3_tuf4_nsac.json';
const NEW = 'tuf_completeness_2026-09-13.after_exact_verification.json';
const read = (f) => JSON.parse(fs.readFileSync(path.join(EV, f), 'utf8'));
const oldM = read(OLD), newM = read(NEW);
const oldBy = Object.fromEntries(oldM.seasons.map((s) => [s.slug, s]));
const key = (b) => `${b.weight_class}|${b.stage}|${b.a}|${b.b}`;

const falsePositives = [];
for (const s of newM.seasons) {
  const olds = new Map(oldBy[s.slug].bouts.map((b) => [key(b), b]));
  for (const b of s.bouts) {
    const pairWinnerMatches = (b.db_pair_matches || []).filter((m) => m.winner_matches_archive);
    const oldDbVerified = pairWinnerMatches.length > 0;
    if (!oldDbVerified || b.db_finale_verified) continue;
    const old = olds.get(key(b));
    const winnerOf = (id) => (id === b.a_fighter_id ? b.a : id === b.b_fighter_id ? b.b : null);
    falsePositives.push({
      season: s.slug, stage: b.stage, on_finale_card: b.on_finale_card, pairing: `${b.a} vs ${b.b}`, tuf_winner: b.winner,
      professional_bouts_used_by_old_rule: pairWinnerMatches.map((m) => ({ ufc_bout_id: m.id, event: m.event, date: m.date, professional_winner: b.winner })),
      other_professional_bouts_between_the_pair: (b.db_pair_matches || []).filter((m) => !m.winner_matches_archive).map((m) => ({ ufc_bout_id: m.id, event: m.event, date: m.date, winner_is_archive_winner: false })),
      why_wrong: b.on_finale_card
        ? `a finale-card final with no ufc_bout_id and no recorded finale date or event (${b.db_finale_unlinked_reason}); the old rule accepted any bout between the pair, so the result row was never shown to be THIS final`
        : `a house exhibition; the professional bout(s) above are different fights between the same two people (${pairWinnerMatches.map((m) => m.date).join(', ')}), and a professional result says nothing about who won the TUF house bout`,
      result_before: old?.result_verification ?? null, result_after: b.result_verification, evidence_after: b.result_evidence,
      verdict: old?.result_verification === b.result_verification ? `still ${b.result_verification}: its own evidence (${b.result_evidence.join(', ')}) verifies it` : `${old?.result_verification} -> ${b.result_verification}`,
    });
  }
}
const affected = [...new Set(falsePositives.map((x) => x.season))];
const houseSecondary = (s) => s.bouts.filter((b) => !(b.stage === 'final' && b.on_finale_card) && b.result_verification === 'partial').length;
const measure = (s) => ({ status: s.status, score: s.score, depth_score: s.depth.depth_score, results_verified: s.tournament.result_verified, bouts: s.tournament.bouts_present, house_secondary_only: houseSecondary(s), blockers: s.blockers, structure: s.structure, professional_final_linked: s.finale.professional_final_linked });
const seasonsReport = Object.fromEntries([...new Set(['tuf-1', 'tuf-2', 'tuf-3', 'tuf-4', ...affected])].map((slug) => {
  const n = newM.seasons.find((x) => x.slug === slug);
  const b = measure(oldBy[slug]), a = measure(n);
  return [slug, { before: b, after: a, changed: JSON.stringify(b) !== JSON.stringify(a) }];
}));
const unchangedElsewhere = newM.seasons.filter((s) => !affected.includes(s.slug)).every((s) => JSON.stringify(measure(s)) === JSON.stringify(measure(oldBy[s.slug])));
const t = (m) => ({ complete: m.totals.complete, partial: m.totals.partial, blocked: m.totals.blocked, result_verified: m.totals.result_verified, result_partial: m.totals.result_partial, finals_verified: m.totals.finals_verified, finale_links_verified: m.totals.finale_links_verified, structure_complete: m.seasons.filter((s) => s.structure === 'complete').length, structure_partial: m.seasons.filter((s) => s.structure !== 'complete').length });

const report = {
  _about: 'READ-ONLY impact audit of the exact result-verification rule (scripts/tuf/audit_matrix_exact_verification.mjs). No season data changed.',
  old_rule: 'dbVerified = any ufc_bouts row between the two fighter ids with the archive winner, applied to every TUF bout (house or final); classificationRepairable and professional_final_linked used the same pair-level test.',
  new_rule: 'House bouts: only commission record, official repair covering the winner, or official recap for the same pairing. Finale-card finals additionally: the exact finale row (ufc_bout_id, else the single bout between the ids on the recorded finale date and event). Classification repair and professional_final_linked use the exact row only.',
  old_matrix: `scripts/tuf/evidence/${OLD}`, new_matrix: `scripts/tuf/evidence/${NEW}`,
  false_positive_db_verifications: falsePositives.length,
  false_positive_house_bouts: falsePositives.filter((x) => !x.on_finale_card).length,
  false_positive_finals: falsePositives.filter((x) => x.on_finale_card).length,
  results_changed: falsePositives.filter((x) => x.result_before !== x.result_after).length,
  false_positives: falsePositives,
  seasons: seasonsReport,
  seasons_outside_this_list_unchanged: unchangedElsewhere,
  totals: { before: t(oldM), after: t(newM) },
};
fs.writeFileSync(path.join(EV, 'tuf_matrix_exact_verification_impact_2026-09-13.json'), JSON.stringify(report, null, 1) + '\n');

const md = ['# TUF matrix — exact result verification, impact (2026-09-13)', '', 'Read-only. Evidence: `scripts/tuf/evidence/tuf_matrix_exact_verification_impact_2026-09-13.json` (`scripts/tuf/audit_matrix_exact_verification.mjs`).', '',
  `**Old rule.** ${report.old_rule}`, '', `**New rule.** ${report.new_rule}`, '',
  `False-positive database verifications under the old rule: **${report.false_positive_db_verifications}** (${report.false_positive_house_bouts} house bouts, ${report.false_positive_finals} finals). Results that change: **${report.results_changed}**.`, '',
  '| Season | Stage | TUF pairing | TUF winner | Professional bout(s) the old rule used | Why it was not evidence | Result before → after |', '|---|---|---|---|---|---|---|'];
for (const x of falsePositives) md.push(`| ${x.season} | ${x.stage} | ${x.pairing} | ${x.tuf_winner} | ${x.professional_bouts_used_by_old_rule.map((p) => `\`${p.ufc_bout_id}\` ${p.event}, ${p.date}, winner ${p.professional_winner}`).join('; ')} | ${x.why_wrong} | ${x.verdict} |`);
md.push('', '## Seasons', '', '| Season | | Status | Score | Results verified | House secondary-only | Blockers |', '|---|---|---|---|---|---|---|');
for (const [slug, v] of Object.entries(seasonsReport)) for (const k of ['before', 'after']) md.push(`| ${slug} | ${k} | ${v[k].status} | ${v[k].score} | ${v[k].results_verified}/${v[k].bouts} | ${v[k].house_secondary_only} | ${v[k].blockers.join(', ') || '—'} |`);
md.push('', `Every other season unchanged: ${unchangedElsewhere ? 'yes' : 'NO'}.`, '', '## Totals', '', '| | Before | After |', '|---|---|---|');
for (const k of Object.keys(report.totals.before)) md.push(`| ${k.replace(/_/g, ' ')} | ${report.totals.before[k]} | ${report.totals.after[k]} |`);
fs.mkdirSync(path.join(ROOT, 'docs', 'tuf'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'tuf', 'tuf_matrix_exact_verification_impact_2026-09-13.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ ...report, false_positives: report.false_positives.map((x) => `${x.season} ${x.stage} ${x.pairing}: ${x.verdict}`) }, null, 1));
