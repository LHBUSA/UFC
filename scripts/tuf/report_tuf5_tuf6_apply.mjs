#!/usr/bin/env node
/**
 * TUF 5 + TUF 6 NSAC apply — review report. READ-ONLY, no network.
 *
 *   node scripts/tuf/report_tuf5_tuf6_apply.mjs
 *
 * Reads the applied season files, the commission ledger, and two matrices produced by
 * the same exact verifier (main 552ed92): the pre-apply matrix committed on main
 * (tuf_completeness_2026-09-13.after_exact_verification.json) and the post-apply matrix
 * (tuf_completeness_2026-09-13.after_tuf5_tuf6_nsac.json). Writes
 * docs/tuf/nsac_tuf5_tuf6_apply_2026-09-13.md and
 * scripts/tuf/evidence/nsac_tuf5_tuf6_apply_2026-09-13.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EV = path.join(ROOT, 'scripts', 'tuf', 'evidence');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const BATCH = 'tuf5-tuf6-nsac-reconciliation';
const before = read(path.join(EV, 'tuf_completeness_2026-09-13.after_exact_verification.json'));
const after = read(path.join(EV, 'tuf_completeness_2026-09-13.after_tuf5_tuf6_nsac.json'));
const ledger = read(path.join(ROOT, 'web', 'data', 'tuf', 'commission_records.json'));

const corrections = [];
const details = [];
const timeline = [];
const resolved = [];
for (const slug of ['tuf-5', 'tuf-6']) {
  const s = read(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', `${slug}.json`));
  for (const wc of s.bracket) for (const st of wc.stages) {
    if (st.sources?.some((x) => String(x.repair).startsWith(BATCH))) resolved.push({ season: slug, stage: st.stage, status_now: st.status ?? null, note: st.note });
    for (const b of st.bouts) {
      for (const c of (b.corrections || []).filter((x) => x.batch === BATCH)) corrections.push({ season: slug, stage: st.stage, bout: `${b.a} vs ${b.b}`, field: c.field, kind: c.kind, old: c.old, new: c.new, document_id: c.source.document_id, record_id: c.source.record_id, reason: c.reason });
      if (b.method_detail && b.commission_record_id) details.push({ season: slug, stage: st.stage, bout: `${b.a} vs ${b.b}`, value: b.method_detail.value, source: `${b.method_detail.source.family} (${b.method_detail.source.evidence_level})` });
    }
  }
  for (const e of s.timeline_events || []) if (e.sources?.some((x) => x.document_id === 'nsac-2007-tuf-season-6')) timeline.push({ season: slug, id: e.id, type: e.type, fighters: e.fighters, replaces: e.replaces ?? null, episode: e.episode, detail: e.detail, record_id: e.sources[0].record_id, quote: e.sources[0].quote });
  for (const c of (s._resolved_conflicts || []).filter((x) => x.resolved_by === BATCH)) resolved.push({ season: slug, conflict: c.field, resolved_with: c.resolved_with });
}

const bySlug = (m) => Object.fromEntries(m.seasons.map((s) => [s.slug, s]));
const B = bySlug(before), A = bySlug(after);
const hub = (s) => (s.season_state === 'ongoing' ? 'Season ongoing' : s.structure === 'complete' ? (s.status === 'COMPLETE' ? 'Complete + Verified' : 'Complete') : 'Partial');
const metrics = (s) => {
  const house = s.bouts.filter((b) => !b.on_finale_card);
  return {
    status: s.status, structure: s.structure, hub_card: hub(s), score: s.score, depth_score: s.depth.depth_score,
    results_verified: `${s.tournament.result_verified}/${s.tournament.bouts_present}`, house_secondary_only: house.filter((b) => b.result_verification === 'partial').length,
    house_commission_verified: s.depth.house_bouts_commission_verified, commission_backed_exhibitions: `${s.depth.exhibition_commission_backed}/${s.tournament.exhibition}`,
    classification_unresolved: s.tournament.classification_unresolved, open_conflicts: s.conflicts.open, timeline_events: s.depth.timeline_events, professional_final_linked: s.finale.professional_final_linked,
    blockers: s.blockers,
  };
};
const changedSeasons = Object.keys(B).filter((k) => JSON.stringify(B[k]) !== JSON.stringify(A[k]));
const TOTALS = ['complete', 'partial', 'blocked', 'result_verified', 'result_partial', 'result_unknown', 'finals_verified', 'finale_links_verified', 'classification_exhibition', 'classification_unresolved', 'exhibition_with_affirmative_basis', 'exhibition_absence_only', 'depth_timeline_events'];
const count = (m, f) => m.seasons.reduce((n, s) => n + f(s), 0);
const totals = Object.fromEntries([
  ...TOTALS.map((k) => [k, { before: before.totals[k], after: after.totals[k] }]),
  ['commission_backed_exhibitions', { before: count(before, (s) => s.depth.exhibition_commission_backed), after: count(after, (s) => s.depth.exhibition_commission_backed) }],
  ['house_secondary_only', { before: count(before, (s) => s.bouts.filter((b) => !b.on_finale_card && b.result_verification === 'partial').length), after: count(after, (s) => s.bouts.filter((b) => !b.on_finale_card && b.result_verification === 'partial').length) }],
  ['structure_complete', { before: count(before, (s) => (s.structure === 'complete' ? 1 : 0)), after: count(after, (s) => (s.structure === 'complete' ? 1 : 0)) }],
]);
const hubCounts = (m) => m.seasons.reduce((o, s) => ({ ...o, [hub(s)]: (o[hub(s)] || 0) + 1 }), {});

const report = {
  _about: 'READ-ONLY review report for the TUF 5 + TUF 6 NSAC apply (scripts/tuf/report_tuf5_tuf6_apply.mjs). Matrices from the exact verifier on main 552ed92.',
  batch: BATCH, reviewer: 'Justin Erickson',
  commission_documents: ledger.documents.filter((d) => d.seasons.some((x) => ['tuf-5', 'tuf-6'].includes(x))).map((d) => ({ id: d.id, url: d.url, sha256: d.sha256, records: ledger.records.filter((r) => r.document_id === d.id).length })),
  corrections, secondary_method_detail_kept: details, timeline_events_added: timeline, resolved,
  seasons: Object.fromEntries(['tuf-5', 'tuf-6'].map((k) => [k, { before: metrics(B[k]), after: metrics(A[k]) }])),
  seasons_changed: changedSeasons, totals, hub_cards: { before: hubCounts(before), after: hubCounts(after) },
};
fs.writeFileSync(path.join(EV, 'nsac_tuf5_tuf6_apply_2026-09-13.json'), JSON.stringify(report, null, 1) + '\n');

const t = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const md = ['# TUF 5 + TUF 6 — NSAC reconciliation apply (2026-09-13)', '', `Batch \`${BATCH}\`, decisions reviewed by Justin Erickson. Generated by \`scripts/tuf/report_tuf5_tuf6_apply.mjs\`; evidence \`scripts/tuf/evidence/nsac_tuf5_tuf6_apply_2026-09-13.json\`. Apply: \`scripts/tuf/apply_tuf5_tuf6_nsac.mjs\` (idempotent, \`--check\`).`, '',
  '## Commission documents', '', '| Document | Records | sha256 |', '|---|---|---|', ...report.commission_documents.map((d) => `| [${d.id}](${d.url}) | ${d.records} | \`${d.sha256}\` |`), '',
  '## Corrections (every one cites its document and record)', '', '| Season | Stage | Bout | Field | Kind | Old | New | Record |', '|---|---|---|---|---|---|---|---|',
  ...corrections.map((c) => `| ${c.season} | ${c.stage} | ${c.bout} | ${c.field} | ${c.kind} | ${t(c.old)} | ${t(c.new)} | ${c.record_id} |`), '',
  `Totals: ${['winner', 'method', 'time', 'round', 'classification'].map((f) => `${f} ${corrections.filter((c) => c.field === f).length}`).join(', ')}.`, '',
  '## Secondary method detail kept (category agrees; draft-sourced, not commission-sourced)', '', ...details.map((d) => `- ${d.season} ${d.bout}: "${d.value}" — ${d.source}`), '',
  '## Timeline events added', '', ...timeline.map((e) => `- ${e.id}: ${e.type} ${e.fighters.join(', ')}${e.replaces ? ` (replaces ${e.replaces})` : ''}, episode ${t(e.episode)} — ${e.record_id}: "${e.quote}"`), '',
  '## Resolved', '', ...resolved.map((r) => `- ${r.season} ${r.conflict ? `conflict \`${r.conflict}\` — ${r.resolved_with}` : `stage ${r.stage}: status ${t(r.status_now)}; ${r.note}`}`), '',
  '## Matrix before → after (exact verifier)', '', '| Measure | TUF 5 before | TUF 5 after | TUF 6 before | TUF 6 after |', '|---|---|---|---|---|',
  ...Object.keys(report.seasons['tuf-5'].before).map((k) => `| ${k.replace(/_/g, ' ')} | ${t(report.seasons['tuf-5'].before[k])} | ${t(report.seasons['tuf-5'].after[k])} | ${t(report.seasons['tuf-6'].before[k])} | ${t(report.seasons['tuf-6'].after[k])} |`), '',
  `Seasons whose matrix entry changed: ${changedSeasons.join(', ')}.`, '', '| Total | Before | After |', '|---|---|---|', ...Object.entries(totals).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v.before} | ${v.after} |`), '',
  `Hub cards before: ${JSON.stringify(report.hub_cards.before)}; after: ${JSON.stringify(report.hub_cards.after)}.`, ''];
fs.writeFileSync(path.join(ROOT, 'docs', 'tuf', 'nsac_tuf5_tuf6_apply_2026-09-13.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ corrections: corrections.length, by_field: Object.fromEntries(['winner', 'method', 'time', 'round', 'classification'].map((f) => [f, corrections.filter((c) => c.field === f).length])), seasons_changed: changedSeasons, totals, hub_cards: report.hub_cards, resolved, timeline: timeline.map((e) => e.id) }, null, 1));
