#!/usr/bin/env node
/**
 * TUF 1 — Nevada State Athletic Commission reconciliation AUDIT. READ-ONLY.
 *
 *   node scripts/tuf/audit_tuf1_nsac.mjs [--pdf <path to TUFSEASON1.pdf>]
 *
 * Compares the commission's TUF Season 1 results document, transcribed below in
 * the shape of web/data/tuf/commission_records.json, with the canonical TUF 1
 * house bouts in web/data/tuf/seasons/tuf-1.json. Writes nothing but the audit:
 *   scripts/tuf/evidence/tuf1_nsac_audit_2026-09-13.json
 *   docs/tuf/tuf1_nsac_reconciliation_audit_2026-09-13.md
 * No season, identity, ledger or database change. The document itself is not
 * redistributed; --pdf re-verifies its hash against a local copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const pdfArg = argv.includes('--pdf') ? argv[argv.indexOf('--pdf') + 1] : null;
const OUT_JSON = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf1_nsac_audit_2026-09-13.json');
const OUT_MD = path.join(ROOT, 'docs', 'tuf', 'tuf1_nsac_reconciliation_audit_2026-09-13.md');
const RETRIEVED = '2026-09-13';

const DOCUMENT = {
  id: 'nsac-2004-tuf-season-1',
  source_family: 'athletic_commission', source_type: 'commission_result_record',
  commission: 'Nevada State Athletic Commission', jurisdiction: 'Nevada',
  document: 'Mixed Martial Arts Exhibition Results (TUF Season 1 results record)',
  seasons: ['tuf-1'],
  url: 'https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2005_Results/TUFSEASON1.pdf',
  archive_url: 'https://web.archive.org/web/20160304125359/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2005_Results/TUFSEASON1.pdf',
  sha256: '56e7f0951afcdc44189935c10eb0bac100527cea0adcf56415ca819568690f5d',
  bytes: 165035, pages: 2, retrieved: RETRIEVED,
  live: { http: 200, content_type: 'application/pdf', last_modified: 'Wed, 06 Feb 2013 22:40:06 GMT' },
  live_matches_archive: true,
  pdf_metadata: { title: 'STATE OF NEVADA', author: 'Athletic Commission', created: '2005-06-01', producer: 'Acrobat Distiller 5.0 (Windows)' },
  title_quote: 'MIXED MARTIAL ARTS EXHIBITION RESULTS',
  season_identity: {
    printed: false,
    basis: 'The document prints no season number or show name. Season 1 identity rests on: the file name TUFSEASON1.pdf in the commission 2005_Results directory; location "UFC Training Center, Las Vegas"; show dates 2004-10-01..2004-11-03 inside the season filming window (UFC.com: late 2004); and all 10 pairings and winners matching the 10 TUF 1 house bouts exactly, with 11 of 13 printed dates of birth equal to the canonical fighters\'.',
  },
  location: 'UFC Training Center, Las Vegas', promoter: 'Zuffa, LLC', executive_director: 'Marc Ratner',
  classification_language: {
    quote: 'MIXED MARTIAL ARTS EXHIBITION RESULTS',
    where: 'document title, page 1; the page 1 results column is headed "Exhibition Results" and page 2 continues the same table under "Results"',
    also: ['Exhibition Results'],
  },
  officials: {
    referees: ['Steve Mazzagatti'], visiting_referees: ['Herb Dean', 'John McCarthy'],
    judges: ['Dalby Shirley', 'Glenn Trowbridge', 'Tony Weeks'], visiting_judges: ['Abe Belardo', 'Nelson Hamilton', 'Cecil Peoples', 'Marcos Rosales'],
    timekeepers: ['Jane Broadfoot', 'James Cavin'],
    ringside_doctors: ['William Berliner', 'Al Capanna', 'Jeff Davidson', 'James Game', 'Margaret Goodman', 'David Watson'],
  },
  columns: ['Contestants', 'Exhibition Results', 'Rds', 'Date of Birth', 'Weight', 'Remarks'],
  remarks_note: 'The Remarks column is empty for all 10 bouts.',
  footer_quote: 'ULTIMATE FIGHTING PRODUCTION / MIXED MARTIAL ARTS RESULTS',
};

/* Transcribed from the document, in the commission_records.json record shape.
 * `bout` maps each record to the canonical bracket bout by the archive's names. */
const rec = (n, date, stage_label, corners, bout, winner, result_text, method, round, time, scheduled_rounds, scorecards, referee) => ({
  id: `nsac-2004-tuf1-${String(n).padStart(2, '0')}`, document_id: DOCUMENT.id, date, stage_label,
  corners, bout, winner, result_text, method, round, time, scheduled_rounds, scorecards, referee, remarks: [],
});
const c = (printed, hometown, dob, weight_lbs) => ({ printed, hometown, dob, weight_lbs });
const RECORDS = [
  rec(1, '2004-10-01', null, [c('BOBBY M. SOUTHWORTH', 'San Jose, CA', '1969-12-16', 206), c('LODUNE KI SINCAID', 'North Hollywood, CA', '1973-05-07', 202.5)],
    { weight_class: 'Light Heavyweight', stage: 'elimination', a: 'Bobby Southworth', b: 'Lodune Sincaid' }, 'Bobby Southworth',
    'Southworth won by TKO 0:14 of the 2nd round.', 'TKO', 2, '0:14', 2, null, 'John McCarthy'),
  rec(2, '2004-10-05', null, [c('DIEGO J. SANCHEZ', 'Albuquerque, NM', '1981-12-31', 183), c('ALEXANDER KARALEXIS', 'Las Vegas, NV', '1977-09-20', 185)],
    { weight_class: 'Middleweight', stage: 'elimination', a: 'Diego Sanchez', b: 'Alex Karalexis' }, 'Diego Sanchez',
    'Sanchez won by tap out 1:46 of the 1st round – rear naked choke.', 'Submission (rear naked choke)', 1, '1:46', 2, null, 'John McCarthy'),
  rec(3, '2004-10-13', null, [c('JOSH D. KOSCHECK', 'Tonawanda, NY', '1977-11-30', 185), c('CHRIS LEBEN', 'Portland, OR', '1980-07-21', 186)],
    { weight_class: 'Middleweight', stage: 'elimination', a: 'Josh Koscheck', b: 'Chris Leben' }, 'Josh Koscheck',
    'Koscheck won by unanimous decision.', 'Decision (unanimous)', 2, null, 2,
    { order: ['Koscheck', 'Leben'], cards: [{ judge: 'Glenn Trowbridge', score: '20-18' }, { judge: 'Tony Weeks', score: '20-18' }, { judge: 'Nelson Hamilton', score: '20-18' }] }, 'Herb Dean'),
  rec(4, '2004-10-17', null, [c('BOBBY M. SOUTHWORTH', 'San Jose, CA', '1969-12-16', 205), c('STEPHAN P. BONNAR', 'Chicago, IL', '1977-04-04', 206)],
    { weight_class: 'Light Heavyweight', stage: 'elimination', a: 'Stephan Bonnar', b: 'Bobby Southworth' }, 'Stephan Bonnar',
    'Bonnar won by split decision.', 'Decision (split)', 2, null, 2,
    { order: ['Southworth', 'Bonnar'], cards: [{ judge: 'Dalby Shirley', score: '18-20' }, { judge: 'Tony Weeks', score: '20-18' }, { judge: 'Abe Belardo', score: '18-20' }] }, 'Steve Mazzagatti'),
  rec(5, '2004-10-20', null, [c('DIEGO J. SANCHEZ', 'Albuquerque, NM', '1981-12-31', 183.5), c('JOSH M. RAFFERTY', 'Cleveland, OH', '1981-01-06', 184.25)],
    { weight_class: 'Middleweight', stage: 'elimination', a: 'Diego Sanchez', b: 'Josh Rafferty' }, 'Diego Sanchez',
    'Sanchez won by tap out 1:49 of the 1st round – rear naked choke.', 'Submission (rear naked choke)', 1, '1:49', 2, null, 'Steve Mazzagatti'),
  rec(6, '2004-10-25', null, [c('FORREST GRIFFIN', 'Martinez. CA', '1977-11-26', 205), c('ALEX SCHOENAUER', 'Las Vegas, NV', '1976-05-12', 205)],
    { weight_class: 'Light Heavyweight', stage: 'elimination', a: 'Forrest Griffin', b: 'Alex Schoenauer' }, 'Forrest Griffin',
    'Griffin won by tap out at 1:22 of the 1st round – strikes.', 'Submission (strikes)', 1, '1:22', 2, null, 'Herb Dean'),
  rec(7, '2004-10-28', 'MIDDLEWEIGHT SEMI-FINAL BOUT', [c('CHRIS LEBEN', 'Portland, OR', '1980-07-21', 186), c('KENNETH ALAN FLORIAN', 'Dover, MA', '1976-05-26', 182)],
    { weight_class: 'Middleweight', stage: 'semi_final', a: 'Kenny Florian', b: 'Chris Leben' }, 'Kenny Florian',
    'Florian won by TKO 3:10 of the 2nd round.', 'TKO', 2, '3:10', 3, null, 'John McCarthy'),
  rec(8, '2004-10-30', 'MIDDLEWEIGHT SEMI-FINAL BOUT', [c('DIEGO J. SANCHEZ', 'Albuquerque, NM', '1981-12-31', 183.5), c('JOSH D. KOSCHECK', 'Tonawanda, NY', '1977-11-30', 185.5)],
    { weight_class: 'Middleweight', stage: 'semi_final', a: 'Diego Sanchez', b: 'Josh Koscheck' }, 'Diego Sanchez',
    'Sanchez won by split decision.', 'Decision (split)', 3, null, 3,
    { order: ['Sanchez', 'Koscheck'], cards: [{ judge: 'Tony Weeks', score: '29-28' }, { judge: 'Glenn Trowbridge', score: '27-30' }, { judge: 'Cecil Peoples', score: '29-28' }] }, 'Herb Dean'),
  rec(9, '2004-11-02', 'LIGHT HEAVYWEIGHT SEMI-FINAL BOUT', [c('MIKE SWICK', 'San Jose, CA', '1979-06-19', 192), c('STEPHAN P. BONNAR', 'Chicago, IL', '1977-04-04', 204.5)],
    { weight_class: 'Light Heavyweight', stage: 'semi_final', a: 'Stephan Bonnar', b: 'Mike Swick' }, 'Stephan Bonnar',
    'Bonnar won by tap out 4:58 of the 1st round – arm bar.', 'Submission (armbar)', 1, '4:58', 3, null, 'John McCarthy'),
  rec(10, '2004-11-03', 'LIGHT HEAVYWEIGHT SEMI-FINAL BOUT', [c('SAMUEL EARL HOGER', 'Eagle River, AK', '1980-06-28', 205), c('FORREST GRIFFIN', 'Martinez. CA', '1977-11-26', 206)],
    { weight_class: 'Light Heavyweight', stage: 'semi_final', a: 'Forrest Griffin', b: 'Sam Hoger' }, 'Forrest Griffin',
    'Griffin won by TKO 1:08 of the 2nd round.', 'TKO', 2, '1:08', 3, null, 'John McCarthy'),
];
/* Canonical ufc_fighters.dob, read-only select 2026-09-13, for the identity cross-check only. */
const CANONICAL_DOB = {
  'Bobby Southworth': '1969-12-16', 'Lodune Sincaid': '1973-05-07', 'Diego Sanchez': '1981-12-31', 'Alex Karalexis': '1977-09-20',
  'Josh Koscheck': '1977-11-30', 'Chris Leben': '1980-07-21', 'Stephan Bonnar': '1977-04-04', 'Josh Rafferty': '1981-01-06',
  'Forrest Griffin': '1979-03-16', 'Alex Schoenauer': '1976-05-05', 'Kenny Florian': '1976-05-26', 'Mike Swick': '1979-06-19', 'Sam Hoger': '1980-06-28',
};

/* ---- verify the local copy, if given ---- */
let pdfCheck = null;
if (pdfArg) {
  const buf = fs.readFileSync(pdfArg);
  pdfCheck = { path: pdfArg, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  pdfCheck.matches = pdfCheck.sha256 === DOCUMENT.sha256 && pdfCheck.bytes === DOCUMENT.bytes;
}

/* ---- canonical house bouts ---- */
const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', 'tuf-1.json'), 'utf8'));
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const surname = (s) => fold(String(s).trim().split(/\s+/).pop());
const house = [];
for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
  if (b.on_finale_card) continue;
  house.push({ ...b, weight_class: wc.weight_class, stage: st.stage });
}

const rows = house.map((b) => {
  /* Deterministic: same weight class, same stage, the same two surnames in the
   * printed corners (either order), exactly one record. */
  const candidates = RECORDS.filter((r) => r.bout.weight_class === b.weight_class && r.bout.stage === b.stage
    && [surname(b.a), surname(b.b)].sort().join('|') === r.corners.map((x) => surname(x.printed)).sort().join('|'));
  const r = candidates.length === 1 ? candidates[0] : null;
  const diff = [];
  if (r) {
    const base = (m) => String(m ?? '').replace(/\s*\(.*\)$/, '');
    /* contradiction: the two say different things; draft_detail: same result type, the draft adds a detail the record does not print. */
    const kindOf = (field, canon, comm) => (field === 'method' && base(canon) === base(comm) && !/^Submission/.test(base(canon)) ? 'draft_detail'
      : field === 'method' && /^Submission \((triangle )?armbar\)$/i.test(canon) && /armbar/i.test(comm) ? 'draft_detail' : 'contradiction');
    const cmp = (field, canon, comm, note) => { if (String(canon ?? '') !== String(comm ?? '')) diff.push({ field, kind: kindOf(field, canon, comm), canonical: canon ?? null, commission: comm ?? null, ...(note ? { note } : {}) }); };
    cmp('winner', b.winner, r.winner);
    cmp('method', b.method, r.method, /doctor/i.test(b.method || '') ? 'the commission prints "TKO" with no stoppage cause; "doctor stoppage" is the draft\'s detail, unsupported by the record'
      : /triangle/i.test(b.method || '') ? 'the commission prints "arm bar"; "triangle" is the draft\'s detail, unsupported by the record'
        : /^KO/.test(b.method || '') ? 'the commission prints TKO, not KO'
          : /^TKO \(/.test(b.method || '') ? 'the commission prints "TKO" with no cause; the parenthetical is the draft\'s detail' : undefined);
    cmp('round', b.round, r.round);
    cmp('time', b.time, r.time);
  }
  return {
    bout: `${b.a} vs ${b.b}`, weight_class: b.weight_class, stage: b.stage, episode: b.episode,
    match: candidates.length === 1 ? 'deterministic' : candidates.length ? 'ambiguous' : 'unmatched',
    record_id: r?.id ?? null, fight_date: r?.date ?? null, current_fight_date: b.fight_date ?? null,
    canonical: { winner: b.winner, method: b.method, round: b.round, time: b.time },
    commission: r ? { winner: r.winner, method: r.method, round: r.round, time: r.time, result_text: r.result_text, scheduled_rounds: r.scheduled_rounds, referee: r.referee, scorecards: r.scorecards, weights: r.corners.map((x) => [x.printed, x.weight_lbs]), remarks: r.remarks } : null,
    discrepancies: diff,
    current_result_authority: (b.result_sources || []).map((s) => `${s.family}:${s.evidence_level}`),
    current_classification_authority: (b.classification_basis?.affirmative || []).map((s) => `${s.family}:${s.evidence_level}`),
    ids: [b.a_fighter_id, b.b_fighter_id],
  };
});

/* dates of birth: printed vs canonical, per fighter */
const dob = new Map();
for (const r of RECORDS) r.bout && [r.bout.a, r.bout.b].forEach((name) => {
  const corner = r.corners.find((x) => surname(x.printed) === surname(name));
  if (!corner) return;
  const e = dob.get(name) || { fighter: name, printed: new Set(), canonical: CANONICAL_DOB[name] ?? null };
  e.printed.add(corner.dob); dob.set(name, e);
});
const dobRows = [...dob.values()].map((e) => ({ fighter: e.fighter, printed: [...e.printed], canonical: e.canonical, agrees: e.printed.size === 1 && [...e.printed][0] === e.canonical }));

/* episode order vs fight date (a consistency check, not a placement source) */
const byEpisode = [...rows].sort((x, y) => x.episode - y.episode || String(x.fight_date).localeCompare(String(y.fight_date)));
const monotonic = byEpisode.every((x, i) => i === 0 || String(x.fight_date) >= String(byEpisode[i - 1].fight_date));

const matched = rows.filter((x) => x.match === 'deterministic').length;
const counts = (f) => rows.filter((x) => x.discrepancies.some((d) => d.field === f)).length;
const conflicts = season._conflicts || [];
const summary = {
  house_bouts_expected: 10, house_bouts_in_archive: house.length, records_in_document: RECORDS.length,
  matched, unmatched: rows.filter((x) => x.match === 'unmatched').length, ambiguous: rows.filter((x) => x.match === 'ambiguous').length,
  every_record_used_once: new Set(rows.map((x) => x.record_id).filter(Boolean)).size === RECORDS.length,
  discrepancies: { winner: counts('winner'), method: counts('method'), round: counts('round'), time: counts('time') },
  discrepancy_kinds: Object.fromEntries(['contradiction', 'draft_detail'].map((k) => [k, rows.flatMap((x) => x.discrepancies).filter((d) => d.kind === k).map((d) => d.field)])),
  fight_dates: RECORDS.length, scorecards: RECORDS.filter((r) => r.scorecards).length, decisions: RECORDS.filter((r) => /^Decision/.test(r.method)).length,
  referees: RECORDS.filter((r) => r.referee).length, weights: RECORDS.reduce((n, r) => n + r.corners.filter((x) => x.weight_lbs != null).length, 0),
  remarks: RECORDS.reduce((n, r) => n + r.remarks.length, 0),
  dob_agree: dobRows.filter((x) => x.agrees).length, dob_fighters: dobRows.length,
  fight_dates_follow_episode_order: monotonic,
  classification_wording: DOCUMENT.classification_language.quote,
  can_results_become_verified: matched === 10 && counts('winner') === 0,
  can_exhibition_basis_become_primary: true,
  open_conflicts: conflicts.map((x) => x.field),
  rafferty_conflict_resolved_by_commission: false,
};

const out = {
  _about: 'READ-ONLY audit (scripts/tuf/audit_tuf1_nsac.mjs). Nothing applied. The commission document is not redistributed; records are a transcription for reconciliation: printed names and hometowns as printed (including "Martinez. CA"); the dash the PDF text layer renders as an unknown glyph before a submission type is transcribed as an en dash.',
  document: DOCUMENT, local_pdf_check: pdfCheck, records: RECORDS, summary, bouts: rows, dates_of_birth: dobRows,
  rafferty: {
    conflict: conflicts.find((x) => /rafferty/i.test(x.field)) ?? null,
    commission_fact: 'Josh Rafferty fought Diego Sanchez on 2004-10-20 (record nsac-2004-tuf1-05).',
    resolves: false,
    why: 'The conflict is which broadcast episode showed his move to Team Couture (7 or 8). The document records bouts, dates and results; it names no team, trade or episode. A fight date cannot say which episode aired the trade.',
  },
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1) + '\n');

/* ---- markdown ---- */
const md = [];
const t = (v) => (v == null ? '—' : String(v));
md.push('# TUF 1 — Nevada State Athletic Commission reconciliation audit (2026-09-13)', '', 'Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/tuf1_nsac_audit_2026-09-13.json` (generated by `scripts/tuf/audit_tuf1_nsac.mjs`).', '');
md.push('## Document', '', '| | |', '|---|---|',
  `| URL | ${DOCUMENT.url} |`, `| Live | HTTP 200, application/pdf, ${DOCUMENT.bytes} bytes, Last-Modified ${DOCUMENT.live.last_modified} |`,
  `| Archive | ${DOCUMENT.archive_url} |`, `| sha256 (live = archive) | \`${DOCUMENT.sha256}\` |`,
  `| Pages | ${DOCUMENT.pages}; PDF created ${DOCUMENT.pdf_metadata.created} by "${DOCUMENT.pdf_metadata.author}" |`,
  `| Title | "${DOCUMENT.title_quote}" |`, `| Classification wording | "${DOCUMENT.classification_language.quote}" (title) and "Exhibition Results" (page 1 column); page 2 column "Results" |`,
  `| Season identity | ${DOCUMENT.season_identity.basis} |`, `| Officials | referee ${DOCUMENT.officials.referees.join(', ')}; visiting referees ${DOCUMENT.officials.visiting_referees.join(', ')}; judges ${DOCUMENT.officials.judges.join(', ')}; visiting judges ${DOCUMENT.officials.visiting_judges.join(', ')}; timekeepers ${DOCUMENT.officials.timekeepers.join(', ')}; ringside doctors ${DOCUMENT.officials.ringside_doctors.join(', ')} |`,
  `| Remarks | ${DOCUMENT.remarks_note} |`, '');
md.push('## Summary', '', '| Measure | Value |', '|---|---|');
for (const [k, v] of Object.entries(summary)) md.push(`| ${k.replace(/_/g, ' ')} | ${typeof v === 'object' ? JSON.stringify(v) : v} |`);
md.push('', '## Bout by bout', '', '| Bout | Stage | Ep | NSAC date | Canonical (method · R · time) | Commission | Discrepancies | Referee | Cards | Weights |', '|---|---|---|---|---|---|---|---|---|---|');
for (const x of rows) md.push(`| ${x.bout} | ${x.weight_class} ${x.stage.replace('_', ' ')} | ${x.episode} | ${t(x.fight_date)} | ${x.canonical.method} · R${x.canonical.round} · ${t(x.canonical.time)} | "${x.commission?.result_text}" | ${x.discrepancies.map((d) => `${d.field}: ${t(d.canonical)} → ${t(d.commission)}`).join('; ') || 'none'} | ${t(x.commission?.referee)} | ${x.commission?.scorecards ? `${x.commission.scorecards.order.join('–')}: ${x.commission.scorecards.cards.map((c2) => `${c2.score} (${c2.judge})`).join(', ')}` : '—'} | ${x.commission?.weights.map((w) => w[1]).join(' / ')} |`);
md.push('', '## Dates of birth (identity cross-check only; no identity or DOB change)', '', '| Fighter | Printed | Canonical | Agrees |', '|---|---|---|---|');
for (const x of dobRows) md.push(`| ${x.fighter} | ${x.printed.join(', ')} | ${t(x.canonical)} | ${x.agrees ? 'yes' : '**no**'} |`);
md.push('', '## Rafferty placement conflict', '', `${out.rafferty.commission_fact} ${out.rafferty.why} **Not resolved.**`, '');
md.push('## If applied (proposal, not applied)', '',
  '- Result authority, all 10 house bouts: Wikipedia secondary draft → NSAC commission record (`result_sources`), result state reported → verified. Draft sources move to history; draft values that differ go to each bout\'s `corrections` (old, new, source, reason).',
  '- Commission values become canonical: 6 times (contradictions of 1-3 s), 1 method contradiction (TKO for "KO (strikes)") and 3 draft details the record does not print ("TKO (doctor stoppage)" and "TKO (strikes)" become "TKO"; "Submission (triangle armbar)" becomes "Submission (armbar)"). Every draft value is kept in corrections.',
  '- Classification: affirmative basis → NSAC record ("MIXED MARTIAL ARTS EXHIBITION RESULTS"); ESPN 2020 retrospective and our 2004 record absence → corroborating. Nothing deleted.',
  '- `fight_date` from the show dates (2004-10-01 … 2004-11-03), with `fight_date_source`; episode and air dates unchanged and separate.',
  '- Referee, scorecards (3 decisions), printed names, hometowns, dates of birth and weights through the generic commission ledger (`web/data/tuf/commission_records.json`), as TUF 2. No remarks exist to attach.',
  '- Unchanged: finale professional results, identities, fighter DOBs (Griffin and Schoenauer print different DOBs — reported, not written), the Rafferty conflict, episode placement.',
  '- Matrix: HOUSE_RESULTS_SECONDARY_ONLY clears; OPEN_SOURCE_CONFLICT (the Rafferty episode-placement conflict) remains, so TUF 1 stays PARTIAL and the hub stays "Format complete · Research gaps". See the audit report for the measured simulation.', '');
fs.writeFileSync(OUT_MD, md.join('\n') + '\n');
console.log(JSON.stringify({ summary, pdfCheck, dob: dobRows.filter((x) => !x.agrees) }, null, 1));
