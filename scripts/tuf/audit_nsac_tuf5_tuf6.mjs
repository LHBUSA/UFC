#!/usr/bin/env node
/**
 * TUF 5 + TUF 6 — Nevada State Athletic Commission reconciliation AUDIT. READ-ONLY.
 *
 *   node scripts/tuf/audit_nsac_tuf5_tuf6.mjs [--pdf-dir <dir holding live5.pdf, live6.pdf, arch5.pdf, arch6.pdf>]
 *
 * Same method as scripts/tuf/audit_nsac_tuf3_tuf4.mjs: the commission documents are
 * transcribed below in the shape of web/data/tuf/commission_records.json and
 * compared, field by field, with the canonical house bouts. Writes only:
 *   scripts/tuf/evidence/nsac_tuf5_tuf6_audit_2026-09-13.json
 *   docs/tuf/nsac_tuf5_tuf6_reconciliation_audit_2026-09-13.md
 * No season, ledger, identity, database or page change. Documents are not
 * redistributed; --pdf-dir re-verifies their hashes against local copies.
 *
 * What differs from TUF 3/4 (all handled inside the existing record shape):
 *   - Neither document prints a weight class. A record matches only inside a
 *     season with exactly one bracket weight class.
 *   - The opening-round bouts print no stage label. An unlabeled record may match
 *     only a bout whose stage no labeled record in the document claims.
 *   - A winner printed with a misspelled surname ("Sotriopoulos") is resolved only
 *     when its letters are exactly one corner's surname rearranged AND that corner's
 *     surname is printed correctly in the same record; it is flagged as a print defect.
 *   - Printed readings that need a judgement ("choke out", "verbal tap out",
 *     "kumara", "0611/07") are kept verbatim beside the normalized value.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const pdfDir = argv.includes('--pdf-dir') ? argv[argv.indexOf('--pdf-dir') + 1] : null;
const OUT_JSON = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf5_tuf6_audit_2026-09-13.json');
const OUT_MD = path.join(ROOT, 'docs', 'tuf', 'nsac_tuf5_tuf6_reconciliation_audit_2026-09-13.md');
const RETRIEVED = '2026-09-13';

const OFFICIALS_2007 = (judges) => ({
  referees: ['Steve Mazzagatti'], visiting_referees: ['Herb Dean', 'John McCarthy'],
  judges, visiting_judges: ['Lester Griffin', 'Nelson Hamilton', 'Cecil Peoples', 'Marcos Rosales'],
  timekeepers: ['James Cavin', 'Steve Esposito', 'Ernie Jauregui', 'Mike LaCella'],
  ringside_doctors: ['William Berliner', 'Al Capanna', 'Jeff Davidson', 'James Game', 'Anthony Ruggeroli', 'David Watson'],
});
const DOCS = {
  'tuf-5': {
    id: 'nsac-2007-tuf-season-5', source_family: 'athletic_commission', source_type: 'commission_result_record',
    commission: 'Nevada State Athletic Commission', jurisdiction: 'Nevada',
    document: 'Mixed Martial Arts Results — Season 5, The Ultimate Fighter', seasons: ['tuf-5'],
    url: 'https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON5.pdf',
    archive_url: 'https://web.archive.org/web/20161213143108/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON5.pdf',
    sha256: 'd12c518bf3289183934696e4f8f4e1107a3142d1107f97c95852753fd2d623cb', bytes: 56215, pages: 3, retrieved: RETRIEVED,
    live: { http: 200, content_type: 'application/pdf', last_modified: 'Wed, 06 Feb 2013 18:18:43 GMT' },
    archive: { http: 200, content_type: 'application/pdf', bytes: 56215, fetched_as: 'id_ (raw capture)' }, live_matches_archive: true,
    pdf_metadata: { title: 'STATE OF NEVADA', author: 'Athletic Commission', created: '2007-06-20' },
    title_quote: 'MIXED MARTIAL ARTS RESULTS',
    classification_language: { quote: 'Exhibition Results', where: 'results column header, page 1; pages 2 and 3 continue the same table (page 2 headed "Results", page 3 under "SEMI-FINAL BOUT") — the applied TUF 2 pattern' },
    season_identity: { printed: true, basis: 'Printed in the document header: "SEASON 5– THE ULTIMATE FIGHTER™". Consistent with the file name TUFSEASON5.pdf (2007_Results), location "UFC Training Center, Las Vegas", show dates 2007-01-27..2007-02-28 and 14/14 pairings.' },
    location: 'UFC Training Center, Las Vegas', promoter: 'Zuffa, LLC', executive_director: 'Keith Kizer',
    officials: OFFICIALS_2007(['Adalaide Byrd', 'Glenn Trowbridge', 'Tony Weeks']),
    remarks_note: 'The Remarks column carries only the "Referee:" line for all 14 bouts; no other remark.',
    printed_notes: [],
  },
  'tuf-6': {
    id: 'nsac-2007-tuf-season-6', source_family: 'athletic_commission', source_type: 'commission_result_record',
    commission: 'Nevada State Athletic Commission', jurisdiction: 'Nevada',
    document: 'Mixed Martial Arts Results — Season 6, The Ultimate Fighter', seasons: ['tuf-6'],
    url: 'https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON6.pdf',
    archive_url: 'https://web.archive.org/web/20161213143128/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON6.pdf',
    sha256: 'bb8e779598068219395c4132f4878df9fce16fb3b499e1b9cbff8835da6deecd', bytes: 58230, pages: 3, retrieved: RETRIEVED,
    live: { http: 200, content_type: 'application/pdf', last_modified: 'Wed, 06 Feb 2013 18:18:59 GMT' },
    archive: { http: 200, content_type: 'application/pdf', bytes: 58230, fetched_as: 'id_ (raw capture)' }, live_matches_archive: true,
    pdf_metadata: { title: 'STATE OF NEVADA', author: 'Athletic Commission', created: '2007-12-14' },
    title_quote: 'MIXED MARTIAL ARTS RESULTS',
    classification_language: { quote: 'Exhibition Results', where: 'results column header, page 1; pages 2 and 3 continue the same table (page 2 headed "Results", page 3 under "SEMI-FINAL BOUT") — the applied TUF 2 pattern' },
    season_identity: { printed: true, basis: 'Printed in the document header: "SEASON 6 – THE ULTIMATE FIGHTER™". Consistent with the file name TUFSEASON6.pdf (2007_Results), location "UFC Training Center, Las Vegas", show dates 2007-06-11..2007-07-15 and 14/14 pairings.' },
    location: 'UFC Training Center, Las Vegas', promoter: 'Zuffa, LLC', executive_director: 'Keith Kizer',
    officials: OFFICIALS_2007(['Adalaide Byrd', 'Patricia Morse Jarman', 'Glenn Trowbridge', 'Tony Weeks']),
    remarks_note: 'The Remarks column carries the "Referee:" line for all 14 bouts; one bout (Speer vs Sotiropoulos, semi-final) also carries a suspension remark.',
    printed_notes: [{ page: 3, where: 'bold line above the semi-final table, outside any record row', quote: 'MATT ARROYO – Injured and could not compete in Semi-Finals. John Kolosci replaced him.', fighters: ['Matt Arroyo', 'John Kolosci'] }],
  },
};

const c = (printed, hometown, dob, weight_lbs) => ({ printed, hometown, dob, weight_lbs });
const cards = (order, scores, judges) => ({ order, cards: scores.map((score, i) => ({ judge: judges[i], score })) });
const J = { Byrd: 'Adalaide Byrd', Trowbridge: 'Glenn Trowbridge', Weeks: 'Tony Weeks', Griffin: 'Lester Griffin', Peoples: 'Cecil Peoples', MorseJarman: 'Patricia Morse Jarman' };
const rec = (season, n, o) => ({ id: `nsac-2007-tuf${season}-${String(n).padStart(2, '0')}`, document_id: `nsac-2007-tuf-season-${season}`, remarks: [], ...o });

/* Corners as printed, in document order (page 1 → page 3). stage_label null = no label printed. */
const RECORDS = {
  'tuf-5': [
    rec(5, 1, { date: '2007-01-27', stage_label: null, corners: [c('ALLEN M. BERUBE', 'Lutz, FL', '1974-08-25', 155.5), c('JEREMIAH COLE MILLER', 'Boynton Beach, FL', '1984-04-26', 155)],
      winner_surname: 'Miller', result_text: 'Miller won by tap out 2:35 of the 1st round – triangle choke', method: 'Submission (triangle choke)', round: 1, time: '2:35', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(5, 2, { date: '2007-01-30', stage_label: null, corners: [c('NOAH MARTIN THOMAS', 'Fort Collins, CO', '1981-03-27', 154.5), c('MANUEL GAMBURYAN', 'Los Angeles, CA', '1981-05-08', 156)],
      winner_surname: 'Gamburyan', result_text: 'Gamburyan won by tap out 2:10 of the 1st round – Kimura.', method: 'Submission (kimura)', round: 1, time: '2:10', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 3, { date: '2007-02-02', stage_label: null, corners: [c('ROBERT MICHAEL EMERSON', 'Newport Beach, CA', '1981-07-30', 156), c('NATHAN DONALD DIAZ', 'Stockton, CA', '1985-04-16', 156)],
      winner_surname: 'Diaz', result_text: 'Diaz won by tap out 4:46 of the 2nd round – rear naked choke.', method: 'Submission (rear naked choke)', round: 2, time: '4:46', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(5, 4, { date: '2007-02-06', stage_label: null, corners: [c('ANDREW P. WANG', 'Torrance, CA', '1977-05-28', 155), c('BRANDON LOUIS MELENDEZ', 'Bountiful, UT', '1983-03-24', 155.5)],
      winner_surname: 'Melendez', result_text: 'Melendez won by unanimous decision.', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Wang', 'Melendez'], ['18-20', '18-20', '18-20'], [J.Byrd, J.Trowbridge, J.Griffin]), referee: 'John McCarthy' }),
    rec(5, 5, { date: '2007-02-12', stage_label: null, corners: [c('ROBERT MICHAEL EMERSON', 'Newport Beach, CA', '1981-07-30', 155), c('COREY CORNELIUS HILL', 'Colorado Springs, CA', '1978-10-03', 155)],
      winner_surname: 'Hill', result_text: 'Hill won by unanimous decision in the sudden victory round.', method: 'Decision (unanimous, sudden victory round)', round: 3, time: null, scheduled_rounds: 2,
      rounds_printed: '2 + Sudden Victory', scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 6, { date: '2007-02-12', stage_label: null, corners: [c('JOSEPH E. LAUZON, JR.', 'Quincy, MA', '1984-05-22', 155), c('BRIAN JOSEPH GERAGHTY', 'Kenosha, WI', '1980-11-04', 154)],
      winner_surname: 'Lauzon', result_text: 'Lauzon won by tap out 1:13 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '1:13', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 7, { date: '2007-02-15', stage_label: null, corners: [c('BRADLEY GRAY MAYNARD', 'Las Vegas, NV', '1979-05-09', 156), c('WAYNE LEROY WEEMS', 'Molina, IL', '1982-06-23', 155)],
      winner_surname: 'Maynard', result_text: 'Maynard won by TKO 2:48 of the 1st round.', method: 'TKO', round: 1, time: '2:48', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(5, 8, { date: '2007-02-15', stage_label: null, corners: [c('MATTHEW CHARLES WIMAN', 'Tulsa, OK', '1983-09-19', 156), c('MARLON SIMS', 'Homestead. FL', '1974-01-18', 156)],
      winner_surname: 'Wiman', result_text: 'Wiman won by choke out 0:50 of the 1st round. – rear naked choke.', method: 'Technical submission (rear naked choke)', round: 1, time: '0:50', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy',
      reading: { printed: 'choke out', read_as: 'Technical submission', note: 'the record distinguishes "choke out" from its "tap out" wording elsewhere; read as a technical submission (rear naked choke), which is the archive\'s own category for this bout — a normalization judgement to confirm' } }),
    rec(5, 9, { date: '2007-02-21', stage_label: 'Quarter Finals', corners: [c('BRADLEY GRAY MAYNARD', 'Las Vegas, NV', '1979-05-09', 155), c('BRANDON LOUIS MELENDEZ', 'Bountiful, UT', '1983-03-24', 156)],
      winner_surname: 'Maynard', result_text: 'Maynard won by tap out 4:07 of the 2nd round – guillotine choke', method: 'Submission (guillotine choke)', round: 2, time: '4:07', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 10, { date: '2007-02-21', stage_label: 'Quarter Finals', corners: [c('JOSEPH E. LAUZON, JR.', 'Quincy, MA', '1984-05-22', 155), c('JEREMIAH COLE MILLER', 'Boynton Beach, FL', '1984-04-26', 155)],
      winner_surname: 'Lauzon', result_text: 'Lauzon won by TKO 3:59 of the 2nd round.', method: 'TKO', round: 2, time: '3:59', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 11, { date: '2007-02-22', stage_label: 'Quarter Finals', corners: [c('NATHAN DONALD DIAZ', 'Stockton, CA', '1985-04-16', 156), c('COREY CORNELIUS HILL', 'Colorado Springs, CA', '1978-10-03', 155)],
      winner_surname: 'Diaz', result_text: 'Diaz won by tap out 3:03 of the 1st round – triangle choke.', method: 'Submission (triangle choke)', round: 1, time: '3:03', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(5, 12, { date: '2007-02-22', stage_label: 'Quarter Finals', corners: [c('MATTHEW CHARLES WIMAN', 'Tulsa, OK', '1983-09-19', 156), c('MANUEL GAMBURYAN', 'Los Angeles, CA', '1981-05-08', 155)],
      winner_surname: 'Gamburyan', result_text: 'Gamburyan won by unanimous decision.', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Wiman', 'Gamburyan'], ['18-20', '18-20', '18-20'], [J.Byrd, J.Weeks, J.Peoples]), scores_printed: '18-20 18-2018-20', referee: 'Herb Dean' }),
    rec(5, 13, { date: '2007-02-28', stage_label: 'SEMI-FINAL BOUT', corners: [c('JOSEPH E. LAUZON, JR.', 'Quincy, MA', '1984-05-22', 156), c('MANUEL GAMBURYAN', 'Los Angeles, CA', '1981-05-08', 155)],
      winner_surname: 'Gamburyan', result_text: 'Gamburyan won by unanimous decision.', method: 'Decision (unanimous)', round: 3, time: null, scheduled_rounds: 3, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(5, 14, { date: '2007-02-28', stage_label: 'SEMI-FINAL BOUT', corners: [c('BRADLEY GRAY MAYNARD', 'Las Vegas, NV', '1979-05-09', 156), c('NATHAN DONALD DIAZ', 'Stockton, CA', '1985-04-16', 155)],
      winner_surname: 'Diaz', result_text: 'Diaz won by tap out 1:20 of the 2nd round – Guillotine choke', method: 'Submission (guillotine choke)', round: 2, time: '1:20', scheduled_rounds: 3, scorecards: null, referee: 'John McCarthy' }),
  ],
  'tuf-6': [
    rec(6, 1, { date: '2007-06-11', date_printed: '0611/07', stage_label: null, corners: [c('MAC DANZIG', 'Los Angels, CA', '1980-01-02', 170), c('JOSEPH WILLIAM SCAROLA', 'East Meadow, NY', '1979-03-12', 169)],
      winner_surname: 'Danzig', result_text: 'Danzig won by tap out 4:55 of the 1st round – triangle choke.', method: 'Submission (triangle choke)', round: 1, time: '4:55', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(6, 2, { date: '2007-06-14', stage_label: null, corners: [c('DORIAN PRICE', 'Columbus, OH', '1977-08-20', 170), c('MATTHEW VINCENT ARROYO', 'Tampa, FL', '1982-09-01', 168)],
      winner_surname: 'Arroyo', result_text: 'Arroyo won by tap out 1:48 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '1:48', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(6, 3, { date: '2007-06-18', stage_label: null, corners: [c('WILLIAM SCOT MILES', 'Loomis. CA', '1978-04-28', 171), c('JOHN MICHAEL KOLOSCI', 'Portage, IN', '1974-11-26', 169.5)],
      winner_surname: 'Kolosci', result_text: 'Kolosci won by tap out 2:58 of the 1st round – guillotine choke.', method: 'Submission (guillotine choke)', round: 1, time: '2:58', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(6, 4, { date: '2007-06-21', stage_label: null, corners: [c('BLAKE R. BOWMAN', 'Carrollton, GA', '1981-06-20', 170), c('RICHIE JAMES HIGHTOWER', 'Phoenix, AZ', '1981-11-24', 170)],
      winner_surname: 'Hightower', result_text: 'Hightower won by TKO 0:50 of the 1st round.', method: 'TKO', round: 1, time: '0:50', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(6, 5, { date: '2007-06-26', stage_label: null, corners: [c('PAUL KARA GEORGIEFF', 'Madison, WI', '1982-09-22', 170), c('TROY HISASHI MANDALONIZ', 'Henderson, NV', '1980-02-01', 168)],
      winner_surname: 'Mandaloniz', result_text: 'Mandaloniz won by TKO 2:40 of the 1st round.', method: 'TKO', round: 1, time: '2:40', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(6, 6, { date: '2007-06-26', stage_label: null, corners: [c('DANIEL L. BARRERA', 'Radcliff, KY', '1980-12-23', 171), c('BENJAMIN SAUNDERS', 'Orlando, FL', '1983-04-13', 170)],
      winner_surname: 'Saunders', result_text: 'Saunders won by majority decision.', method: 'Decision (majority)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Barrera', 'Saunders'], ['18-20', '18-20', '19-19'], [J.Byrd, J.Griffin, J.Peoples]), referee: 'Herb Dean' }),
    rec(6, 7, { date: '2007-06-29', stage_label: null, corners: [c('JARED MICHAEL ROLLINS', 'Stanton, CA', '1977-01-26', 171), c('GEORGE SOTIROPOULOS', 'Bell Post Hill, Victoria, Australia', '1977-07-09', 168.5)],
      winner_surname: 'Sotriopoulos', result_text: 'Sotriopoulos won by TKO 3:50 of the 1st round.', method: 'TKO', round: 1, time: '3:50', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(6, 8, { date: '2007-06-29', stage_label: null, corners: [c('THOMAS CHARLES SPEER', 'Elgin, MN', '1984-08-20', 171), c('JONATHON PAUL KOPPENHAVER', 'Chula Vista, CA', '1981-11-30', 169.5)],
      winner_surname: 'Speer', result_text: 'Speer won by unanimous decision', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Speer', 'Koppenhaver'], ['20-18', '20-18', '20-18'], [J.Byrd, J.MorseJarman, J.Peoples]), referee: 'Steve Mazzagatti' }),
    rec(6, 9, { date: '2007-07-03', stage_label: 'Quarter Finals', corners: [c('MAC DANZIG', 'Los Angels, CA', '1980-01-02', 169), c('JOHN MICHAEL KOLOSCI', 'Portage, IN', '1974-11-26', 170)],
      winner_surname: 'Danzig', result_text: 'Danzig won by tap out 3:57 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '3:57', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(6, 10, { date: '2007-07-05', stage_label: 'Quarter Finals', corners: [c('MATTHEW VINCENT ARROYO', 'Tampa, FL', '1982-09-01', 170), c('TROY HISASHI MANDALONIZ', 'Henderson, NV', '1980-02-01', 170.5)],
      winner_surname: 'Arroyo', result_text: 'Arroyo won by verbal tap out 1:07 of the 1st round – arm bar.', method: 'Submission (armbar)', round: 1, time: '1:07', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean',
      reading: { printed: 'verbal tap out … – arm bar', read_as: 'Submission (armbar)', note: '"verbal" is kept in result_text only; the archive has no category for a verbal submission — a normalization judgement to confirm' } }),
    rec(6, 11, { date: '2007-07-05', stage_label: 'Quarter Finals', corners: [c('RICHIE JAMES HIGHTOWER', 'Phoenix, AZ', '1981-11-24', 171), c('GEORGE SOTIROPOULOS', 'Bell Post Hill, Victoria, Australia', '1977-07-09', 168)],
      winner_surname: 'Sotiropoulos', result_text: 'Sotiropoulos won by tap out 4:10 of the 1st round – kumara.', method: 'Submission (kimura)', round: 1, time: '4:10', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean',
      reading: { printed: 'kumara', read_as: 'kimura', note: 'misspelling of the kimura lock; print defect' } }),
    rec(6, 12, { date: '2007-07-09', stage_label: 'Quarter Finals', corners: [c('THOMAS CHARLES SPEER', 'Elgin, MN', '1984-08-20', 171), c('BENJAMIN SAUNDERS', 'Orlando, FL', '1983-04-13', 170)],
      winner_surname: 'Speer', result_text: 'Speer won by majority decision.', method: 'Decision (majority)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Speer', 'Saunders'], ['20-18', '19-19', '20-18'], [J.MorseJarman, J.Trowbridge, J.Griffin]), referee: 'Steve Mazzagatti' }),
    rec(6, 13, { date: '2007-07-15', stage_label: 'SEMI-FINAL BOUT', corners: [c('MAC DANZIG', 'Los Angels, CA', '1980-01-02', 169.5), c('JOHN MICHAEL KOLOSCI', 'Portage, IN', '1974-11-26', 170)],
      winner_surname: 'Danzig', result_text: 'Danzig won by tap out 4:29 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '4:29', scheduled_rounds: 3, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(6, 14, { date: '2007-07-15', stage_label: 'SEMI-FINAL BOUT', corners: [c('THOMAS CHARLES SPEER', 'Elgin, MN', '1984-08-20', 171), c('GEORGE SOTIROPOULOS', 'Bell Post Hill, Victoria, Australia', '1977-07-09', 170)],
      winner_surname: 'Speer', result_text: 'Speer won by TKO 2:59 of the 1st round.', method: 'TKO', round: 1, time: '2:59', scheduled_rounds: 3, scorecards: null, referee: 'John McCarthy',
      remarks: [{ fighter: 'George Sotiropoulos', quote: 'Suspend Sotiropoulos until 09/14/07' }, { fighter: 'George Sotiropoulos', quote: 'No contact until 08/30/07' }] }),
  ],
};

/* Canonical ufc_fighters (name, dob) by fighter id, read-only select 2026-09-13.
 * Identity cross-check only; null = the archive bout carries no canonical id. */
const CANONICAL = {
  'Cole Miller': ['Cole Miller', '1984-04-26'], 'Allen Berube': ['Allen Berube', '1974-08-25'], 'Manny Gamburyan': ['Manvel Gamburyan', '1981-05-08'], 'Noah Thomas': null,
  'Nate Diaz': ['Nate Diaz', '1985-04-16'], 'Rob Emerson': ['Rob Emerson', '1981-07-30'], 'Brandon Melendez': ['Brandon Melendez', '1983-03-24'], 'Andy Wang': ['Andy Wang', '1977-05-28'],
  'Joe Lauzon': ['Joe Lauzon', '1984-05-22'], 'Brian Geraghty': ['Brian Geraghty', '1980-11-04'], 'Corey Hill': ['Corey Hill', '1978-10-03'], 'Gray Maynard': ['Gray Maynard', '1979-05-09'],
  'Wayne Weems': null, 'Matt Wiman': ['Matt Wiman', '1983-09-19'], 'Marlon Sims': null,
  'Mac Danzig': ['Mac Danzig', '1980-01-02'], 'Joe Scarola': null, 'Billy Miles': ['Billy Miles', '1978-04-28'], 'John Kolosci': ['John Kolosci', '1974-11-26'],
  'Dorian Price': ['Dorian Price', '1977-08-20'], 'Matt Arroyo': ['Matt Arroyo', '1982-09-01'], 'Paul Georgieff': ['Paul Georgieff', '1982-09-22'], 'Troy Mandaloniz': ['Troy Mandaloniz', '1980-02-01'],
  'Blake Bowman': null, 'Richie Hightower': ['Richie Hightower', '1974-11-26'], 'Jared Rollins': ['Jared Rollins', '1977-01-26'], 'George Sotiropoulos': ['George Sotiropoulos', '1977-07-09'],
  'Tom Speer': ['Tommy Speer', '1984-08-20'], 'Jon Koppenhaver': null, 'Dan Barrera': ['Dan Barrera', '1980-12-23'], 'Ben Saunders': ['Ben Saunders', '1983-04-13'],
};

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z]+/).filter(Boolean);
const surname = (name) => words(name).at(-1);
const printedHas = (printed, name) => words(printed).includes(surname(name));
/* the weights display rule (web/lib/tufBoutState.ts cornerIs): surname word + first initial */
const cornerIs = (printed, name) => { const p = words(printed), f = words(name); return p.includes(f.at(-1)) && p[0][0] === f[0][0]; };
const STAGE = (label) => (label == null ? null : /semi/i.test(label) ? 'semi_final' : /quarter/i.test(label) ? 'quarter_final' : 'unrecognized');
const base = (m) => String(m ?? '').replace(/\s*\(.*\)$/, '');
const paren = (m) => (String(m ?? '').match(/\((.*)\)$/) || [])[1] ?? null;
const letters = (s) => [...fold(s).replace(/[^a-z]/g, '')].sort().join('');

function methodKind(canon, comm) {
  if (canon === comm) return null;
  if (!canon) return 'source_only_new_fact';
  const cb = base(canon), mb = base(comm);
  if (cb === mb && paren(comm) && (!paren(canon) || fold(paren(comm)).includes(fold(paren(canon))))) return 'primary_normalization';   // commission states more
  if (cb === mb && paren(canon) && !paren(comm)) return 'compatible_secondary_detail';                                             // draft adds detail
  if (cb === mb && paren(canon) && paren(comm) && fold(paren(canon)).endsWith(fold(paren(comm)))) return 'compatible_secondary_detail';
  return 'true_contradiction';
}

/* Winner as printed → one archive corner. Exact surname first; otherwise the conservative
 * print-defect fallback (same letters as exactly one corner surname, that surname printed
 * correctly in the record's own corners). Anything else stays unresolved. */
function commissionWinner(r, a, b) {
  const w = fold(r.winner_surname).replace(/[^a-z]/g, '');
  const exact = [a, b].filter((n) => surname(n) === w);
  if (exact.length === 1) return { winner: exact[0], via: 'surname' };
  const anagram = [a, b].filter((n) => letters(surname(n)) === letters(w) && r.corners.some((x) => printedHas(x.printed, n)));
  if (anagram.length === 1) return { winner: anagram[0], via: 'print_defect_fallback', printed: r.winner_surname };
  return { winner: null, via: 'unresolved', printed: r.winner_surname };
}

const audit = { _about: 'READ-ONLY audit (scripts/tuf/audit_nsac_tuf5_tuf6.mjs). Nothing applied. Documents are not redistributed; records are transcriptions for reconciliation, printed names and hometowns as printed.', seasons: {} };
for (const slug of ['tuf-5', 'tuf-6']) {
  const doc = DOCS[slug];
  const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', `${slug}.json`), 'utf8'));
  const weightClasses = season.bracket.map((wc) => wc.weight_class);
  const records = RECORDS[slug].map((r) => ({ ...r, weight_class: null, stage: STAGE(r.stage_label) }));
  if (records.some((r) => r.stage === 'unrecognized')) throw new Error(`${slug}: unrecognized stage label`);
  const labeledStages = new Set(records.map((r) => r.stage).filter(Boolean));

  let pdf = null;
  if (pdfDir) {
    const n = slug.split('-')[1];
    const h = (f) => { const buf = fs.readFileSync(path.join(pdfDir, f)); return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; };
    pdf = { live: h(`live${n}.pdf`), archive: h(`arch${n}.pdf`) };
    pdf.matches = [pdf.live, pdf.archive].every((x) => x.sha256 === doc.sha256 && x.bytes === doc.bytes);
  }
  const house = season.bracket.flatMap((wc) => wc.stages.flatMap((st) => st.bouts.filter((b) => !b.on_finale_card).map((b) => ({ ...b, weight_class: wc.weight_class, stage: st.stage, stage_status: st.status ?? null }))));

  const used = new Map();
  const bouts = house.map((b) => {
    const cands = records.filter((r) => weightClasses.length === 1
      && (r.stage ? r.stage === b.stage : !labeledStages.has(b.stage))
      && r.corners.length === 2 && ((printedHas(r.corners[0].printed, b.a) && printedHas(r.corners[1].printed, b.b)) || (printedHas(r.corners[0].printed, b.b) && printedHas(r.corners[1].printed, b.a))));
    const r = cands.length === 1 ? cands[0] : null;
    if (r) used.set(r.id, (used.get(r.id) || 0) + 1);
    const diffs = [];
    let win = null;
    if (r) {
      win = commissionWinner(r, b.a, b.b);
      if (win.via === 'print_defect_fallback') diffs.push({ field: 'winner_printed_name', kind: 'print_date_defect', canonical: b.winner, commission: win.printed, note: `the result line misspells the winner's surname; its letters are exactly ${surname(win.winner)} rearranged and the record's own corner prints the name correctly` });
      if (win.winner !== b.winner) diffs.push({ field: 'winner', kind: win.winner ? 'true_contradiction' : 'unresolved', canonical: b.winner, commission: win.winner ?? r.winner_surname });
      const mk = methodKind(b.method, r.method);
      if (mk) diffs.push({ field: 'method', kind: mk, canonical: b.method, commission: r.method,
        ...(mk === 'compatible_secondary_detail' ? { detail: paren(b.method) } : {}),
        ...(mk === 'true_contradiction' && paren(b.method) ? { note: `the draft's "${paren(b.method)}" sits under a different method category or decision type than the record's; per the TUF 1-4 rule a contradicted label is not carried forward, a compatible mechanism may survive as secondary detail` } : {}) });
      if (r.reading) diffs.push({ field: 'method_reading', kind: /defect/.test(r.reading.note) ? 'print_date_defect' : 'normalization_judgement', canonical: b.method, commission: r.method, printed: r.reading.printed, note: r.reading.note });
      if (b.round !== r.round) diffs.push({ field: 'round', kind: 'true_contradiction', canonical: b.round, commission: r.round });
      if ((b.time ?? null) !== (r.time ?? null)) diffs.push({ field: 'time', kind: b.time == null ? 'source_only_new_fact' : 'true_contradiction', canonical: b.time ?? null, commission: r.time });
      if (!b.fight_date) diffs.push({ field: 'fight_date', kind: 'source_only_new_fact', canonical: null, commission: r.date });
      if (r.date_printed) diffs.push({ field: 'date_printed', kind: 'print_date_defect', canonical: null, commission: r.date, printed: r.date_printed, note: 'the separator between month and day is missing; read as 2007-06-11 from the printed month/day and its place before 06/14/07 — a transcription judgement to confirm' });
      diffs.push({ field: 'referee', kind: 'source_only_new_fact', canonical: null, commission: r.referee });
      if (r.scorecards) diffs.push({ field: 'scorecards', kind: 'source_only_new_fact', canonical: null, commission: r.scorecards, ...(r.scores_printed ? { printed: r.scores_printed } : {}) });
      diffs.push({ field: 'weights', kind: 'source_only_new_fact', canonical: null, commission: r.corners.map((x) => [x.printed, x.weight_lbs]) });
      if (r.remarks.length) diffs.push({ field: 'remarks', kind: 'source_only_new_fact', canonical: null, commission: r.remarks });
      if (r.rounds_printed) diffs.push({ field: 'rounds_printed', kind: 'source_only_new_fact', canonical: null, commission: r.rounds_printed, note: 'decided in the sudden victory round after two scheduled rounds' });
    }
    return {
      bout: `${b.a} vs ${b.b}`, weight_class: b.weight_class, stage: b.stage, stage_status: b.stage_status, episode: b.episode ?? null,
      match: cands.length === 1 ? 'deterministic' : cands.length ? 'ambiguous' : 'unmatched', candidates: cands.map((x) => x.id), record_id: r?.id ?? null,
      canonical: { winner: b.winner, method: b.method, round: b.round, time: b.time ?? null, fight_date: b.fight_date ?? null, classification: b.classification, classification_source: b.classification_source ?? null },
      commission: r ? { winner: win.winner, winner_resolved_via: win.via, method: r.method, round: r.round, time: r.time, date: r.date, result_text: r.result_text, referee: r.referee, scorecards: r.scorecards, weights: r.corners.map((x) => [x.printed, x.weight_lbs]), remarks: r.remarks, stage_label: r.stage_label } : null,
      ids: [b.a_fighter_id ?? null, b.b_fighter_id ?? null],
      discrepancies: diffs,
    };
  });
  /* Ledger shape: a matched record names its bracket bout and winner by the archive's names. */
  for (const x of bouts.filter((q) => q.record_id)) {
    const r = records.find((q) => q.id === x.record_id);
    const [a, b] = x.bout.split(' vs ');
    r.bout = { weight_class: x.weight_class, stage: x.stage, a, b };
    r.winner = x.commission.winner;
  }
  const duplicateUse = [...used].filter(([, n]) => n > 1).map(([id]) => id);
  const unusedRecords = records.filter((r) => !used.has(r.id)).map((r) => r.id);

  /* identity: printed names and dates of birth against canonical fighters (recorded only) */
  const dobs = [];
  const names = [];
  for (const b of bouts.filter((x) => x.record_id)) {
    const r = records.find((x) => x.id === b.record_id);
    for (const name of b.bout.split(' vs ')) {
      const corner = r.corners.find((x) => printedHas(x.printed, name));
      const canon = CANONICAL[name];
      if (corner && !dobs.some((d) => d.fighter === name && d.printed === corner.dob)) {
        dobs.push({ fighter: name, printed_name: corner.printed, printed: corner.dob, canonical: canon?.[1] ?? null,
          state: canon === undefined ? 'not_checked' : canon === null ? 'no_canonical_identity' : canon[1] === corner.dob ? 'agrees' : 'identity_disagreement' });
      }
      if (corner && !names.some((n) => n.fighter === name)) {
        const kinds = [];
        if (canon && fold(canon[0]) !== fold(name)) kinds.push('canonical_name_differs_from_archive');
        if (!cornerIs(corner.printed, name)) kinds.push('printed_first_initial_differs (weights use the printed-name fallback)');
        names.push({ fighter: name, printed_name: corner.printed, canonical_name: canon?.[0] ?? null, kinds });
      }
    }
  }
  const printedWinnerDefects = bouts.flatMap((x) => x.discrepancies.filter((d) => d.field === 'winner_printed_name').map((d) => ({ fighter: d.canonical, printed_in_result_line: d.commission, bout: x.bout })));

  /* conflicts and structure */
  const verdicts = conflictVerdicts(slug, records, bouts);
  const conflicts = (season._conflicts || []).map((cf) => ({ field: cf.field, detail: cf.detail, ...(verdicts[cf.field] ?? { verdict: 'does_not_touch' }) }));
  const structure = structureFor(slug, season, records, bouts, doc);

  const counts = (kind, field) => bouts.flatMap((x) => x.discrepancies).filter((d) => (!kind || d.kind === kind) && (!field || d.field === field)).length;
  const byKind = (field) => Object.fromEntries(['true_contradiction', 'primary_normalization', 'compatible_secondary_detail', 'source_only_new_fact'].map((k) => [k, bouts.flatMap((x) => x.discrepancies.filter((d) => d.field === field && d.kind === k).map(() => x.bout))]));
  const placed = bouts.filter((x) => x.episode != null && x.commission);
  audit.seasons[slug] = {
    document: doc, local_pdf_check: pdf, records,
    summary: {
      house_bouts_expected: 14, house_bouts_in_archive: house.length, records_in_document: records.length,
      matched: bouts.filter((x) => x.match === 'deterministic').length, unmatched: bouts.filter((x) => x.match === 'unmatched').length,
      ambiguous: bouts.filter((x) => x.match === 'ambiguous').length, duplicate_use: duplicateUse, unused_records: unusedRecords,
      match_rules: { weight_class: `document prints none; season bracket has ${weightClasses.length} weight class (${weightClasses.join(', ')})`, unlabeled_records: records.filter((r) => !r.stage).length, labeled_stages: [...labeledStages] },
      differences: {
        winner: counts(null, 'winner'), winner_print_defects: counts(null, 'winner_printed_name'), method: counts(null, 'method'), round: counts(null, 'round'),
        time_contradictions: counts('true_contradiction', 'time'), time_source_only: counts('source_only_new_fact', 'time'),
      },
      method_kinds: byKind('method'),
      method_readings: bouts.flatMap((x) => x.discrepancies.filter((d) => d.field === 'method_reading').map((d) => `${x.bout}: printed "${d.printed}" → ${d.commission} (${d.kind})`)),
      print_date_defects: bouts.flatMap((x) => x.discrepancies.filter((d) => d.kind === 'print_date_defect').map((d) => `${x.bout}: ${d.field} printed "${d.printed ?? d.commission}"`)),
      fight_dates: records.length, referees: records.filter((r) => r.referee).length,
      scorecards: records.filter((r) => r.scorecards).length, decisions: records.filter((r) => /^Decision/.test(r.method)).length,
      decisions_without_cards: records.filter((r) => /^Decision/.test(r.method) && !r.scorecards).map((r) => r.id),
      weights: records.reduce((n, r) => n + r.corners.filter((x) => x.weight_lbs > 0).length, 0),
      remarks: records.reduce((n, r) => n + r.remarks.length, 0), printed_document_notes: doc.printed_notes.length,
      dob: { agrees: dobs.filter((d) => d.state === 'agrees').length, disagreements: dobs.filter((d) => d.state === 'identity_disagreement').map((d) => `${d.fighter}: printed ${d.printed}, canonical ${d.canonical}`), no_canonical_identity: dobs.filter((d) => d.state === 'no_canonical_identity').map((d) => `${d.fighter}: printed ${d.printed}`) },
      name_disagreements: names.filter((n) => n.kinds.length).map((n) => `${n.fighter}: printed ${n.printed_name}${n.canonical_name ? `, canonical ${n.canonical_name}` : ''} [${n.kinds.join('; ')}]`),
      printed_winner_name_defects: printedWinnerDefects.map((x) => `${x.fighter}: result line prints "${x.printed_in_result_line}" (${x.bout})`),
      classification_wording: doc.classification_language.quote,
      classification_primary_possible: bouts.every((x) => x.match === 'deterministic') && unusedRecords.length === 0,
      fight_dates_follow_episode_order: [...placed].sort((x, y) => x.episode - y.episode || x.commission.date.localeCompare(y.commission.date)).every((x, i, a) => i === 0 || x.commission.date >= a[i - 1].commission.date),
      open_conflicts: conflicts.map((x) => `${x.field}: ${x.verdict}`),
      structure: structure.map((x) => `${x.item}: ${x.verdict}`),
    },
    bouts, dates_of_birth: dobs, names, conflicts, structure,
  };
}

/* ---- conflict verdicts (facts only; nothing inferred from a bout merely existing) ---- */
function CONFLICT_VERDICTS_TUF5(records) {
  const r = (n) => records[n - 1];
  return {
    quarter_finals: { verdict: 'commission_resolves',
      commission_facts: [`${r(9).id} (${r(9).date}, "Quarter Finals"): "${r(9).result_text}" — Gray Maynard beat Brandon Melendez.`, `${r(14).id} (${r(14).date}, "SEMI-FINAL BOUT"): Maynard then lost to Diaz.`],
      resolves: 'The archive\'s quarter-final winner (Melendez) is contradicted by the primary record: Maynard won the quarter-final, which is why he appears in the semi-final. Method, round and time agree (guillotine choke, R2, 4:07); only the winner was inverted.',
      recommendation: 'On approval: winner corrected to Gray Maynard as a commission_correction, and the conflict can close with the commission record as its resolution. Not applied in this audit.' },
    early_rounds: { verdict: 'partially_informs',
      commission_facts: ['The record lists eight bouts 2007-01-27..2007-02-15 with no stage label, each scheduled for 2 rounds, before four bouts headed "Quarter Finals" (2007-02-21/22) and two headed "SEMI-FINAL BOUT" (2007-02-28).', 'The eight winners (Miller, Gamburyan, Diaz, Melendez, Hill, Lauzon, Maynard, Wiman) are exactly the eight quarter-finalists.'],
      does_not_settle: 'The record prints no name for the opening stage, and states nothing about the source\'s "Round 2/3/4" numbering or Rob Emerson\'s reinstatement (it only records that Emerson fought twice).',
      recommendation: 'Keep open unless the owner accepts the record\'s shape as enough to name the stage; the stage label stays as is.' },
    final_method_and_opponent_name: { verdict: 'does_not_touch', note: 'The final was on the professional finale card and is not in the house-bout record. The record prints Gamburyan as "MANUEL GAMBURYAN" — a third rendering, recorded as a name disagreement only.' },
    gamburyan_name: { verdict: 'does_not_touch', note: 'The record prints "MANUEL GAMBURYAN" (the archive has Manny, ufc_fighters has Manvel). A commission printed legal-name rendering does not decide the archive\'s display spelling; recorded as a name disagreement, no alias or identity write.' },
    final_method_wording: { verdict: 'does_not_touch', note: 'Finale-card bout; not in the house-bout record.' },
  };
}
function conflictVerdicts(slug, records, bouts) { return slug === 'tuf-5' ? CONFLICT_VERDICTS_TUF5(records, bouts) : {}; }

function structureFor(slug, ...args) { return STRUCTURE_BY_SEASON()[slug](...args); }
function STRUCTURE_BY_SEASON() { return {
  'tuf-5': (season, records) => [
    { item: 'stage status "unverified" on elimination and quarter_final', verdict: 'partially_informs', detail: 'The record confirms all 12 bouts in those stages (8 unlabeled + 4 "Quarter Finals") and resolves the quarter-final inversion; stage statuses are not changed by this audit.' },
    { item: 'Rob Emerson fights twice in the opening round (bout carries a "replacement" note)', verdict: 'partially_informs', detail: `The record lists both bouts (${records[2].id} vs Diaz 2007-02-02, ${records[4].id} vs Hill 2007-02-12). It states no reinstatement or replacement; the replacement note stays sourced to the draft.` },
    { item: 'Gabe Ruediger on the Team Penn roster with no bout', verdict: 'does_not_touch', detail: 'No Ruediger bout is in the record, which is consistent with the roster note (expelled for missing weight) but states nothing about it.' },
    { item: 'Corey Hill vs Rob Emerson recorded as a 3-round unanimous decision', verdict: 'commission_resolves', detail: `${records[4].id}: "${records[4].result_text}" Rds "2 + Sudden Victory" — the TUF 4 sudden-victory shape (round 3, scheduled_rounds 2).` },
    { item: 'contestants without a canonical identity: Noah Thomas, Wayne Weems, Marlon Sims', verdict: 'does_not_touch', detail: 'Printed legal names and DOBs are reported for review; no identity write.' },
  ],
  'tuf-6': (season, records, bouts, doc) => {
    const qf = bouts.find((x) => x.stage === 'quarter_final' && x.bout === 'Mac Danzig vs John Kolosci');
    const sf = bouts.find((x) => x.stage === 'semi_final' && x.bout === 'Mac Danzig vs John Kolosci');
    return [
      { item: 'format_exceptions: Kolosci replaces the injured Arroyo in the semi-finals (episode 6)', verdict: 'commission_resolves', detail: `The document prints, above its semi-final table (page 3): "${doc.printed_notes[0].quote}" The replacement and its cause are stated by the primary record. Episode placement (6) is not stated and is not settled.` },
      { item: 'format_exceptions: Jon Koppenhaver replaces Mitichyan (episode 1)', verdict: 'does_not_touch', detail: `The record lists only Koppenhaver's bout (${records[7].id}, lost to Speer 2007-06-29). No Mitichyan, no replacement stated.` },
      { item: 'quarter-final Mac Danzig vs John Kolosci carries the semi-final\'s values', verdict: 'commission_resolves', detail: `The archive QF and SF rows are identical (Submission (rear naked choke), R1, 4:28, episode 6). The record has two distinct bouts: QF ${qf?.record_id} 2007-07-03 at 3:57 (referee John McCarthy) and SF ${sf?.record_id} 2007-07-15 at 4:29 (referee Steve Mazzagatti). Result values resolve; the QF episode placement does not.` },
      { item: 'quarter-final Matt Arroyo vs Troy Mandaloniz: classification unverified, no time, no episode', verdict: 'partially_informs', detail: `${records[9].id}: "${records[9].result_text}" under "Exhibition Results" — resolves classification, method detail and time (1:07). Episode stays unplaced.` },
      { item: 'weight class labelled "Tournament"', verdict: 'does_not_touch', detail: 'The record prints no weight class; its weights (168–171 lb) are consistent with welterweight but a weight class is not inferred from weights.' },
      { item: 'ROSTER_MISSING (no teams loaded)', verdict: 'does_not_touch', detail: 'The record lists the 16 contestants who fought, with legal names and DOBs, but no teams or coaches.' },
      { item: 'contestants without a canonical identity: Joe Scarola, Blake Bowman, Jon Koppenhaver', verdict: 'does_not_touch', detail: 'Printed legal names and DOBs are reported for review; no identity write.' },
      { item: 'nine title-only episode shells; many house bouts placed in episode 6', verdict: 'does_not_touch', detail: 'Fight dates are new facts; they are not used to move or place episodes.' },
    ];
  },
}; }

/* ---- architecture check and decisions for an apply (facts from the audit above) ---- */
audit.architecture = {
  sufficient: true,
  fits_without_change: [
    'document + 28 records in web/data/tuf/commission_records.json (CommissionDocument / CommissionRecord as typed in web/lib/tuf.ts)',
    'stage_label null for the 16 unlabeled opening-round records (the applied TUF 2 shape)',
    'result_sources / classification_basis / fight_date / fight_date_source / commission_record_id on bouts; superseded_result_sources for the draft',
    'corrections (commission_correction, method_normalization) and method_detail for compatible detail (TUF 5: punches, strikes; TUF 6: strikes x2)',
    'a winner correction is a FieldCorrection with field "winner" (the type is generic); no season has needed one before, and the TUF 3/4 apply script refuses one by design',
    'sudden-victory decision (TUF 5 Hill vs Emerson): the TUF 4 shape — method "Decision (unanimous, sudden victory round)", round 3, scheduled_rounds 2',
    'date_printed for TUF 6 "0611/07" (the generic field added for TUF 3)',
    'remarks [{fighter, quote}] for the TUF 6 suspension (the TUF 2 shape)',
    'the TUF 6 page-3 replacement note as timeline_events (injury / withdrawal / replacement with replaces) citing the commission document and the semi-final record it heads — the TUF 2 medical_clearance pattern',
    'identity_disagreements on the document for the one DOB difference (Hightower); name renderings stay in corners.printed',
    'commissionWeights: printed-name fallback for corners whose printed first initial differs (Cole Miller x2, Gray Maynard x3, Billy Miles), fail-safe as designed',
  ],
  transcription_keys_not_in_the_ledger_shape: {
    winner_surname: 'audit helper; replaced by winner at apply (TUF 6 record 07 resolved through the print-defect fallback)',
    weight_class: 'audit helper (null: not printed); carried by bout.weight_class', stage: 'audit helper; carried by bout.stage',
    rounds_printed: 'redundant with method + scheduled_rounds + result_text; drop at apply (as TUF 4)',
    scores_printed: 'the printed run-together "18-20 18-2018-20"; scorecards.cards is normalized; drop at apply',
    reading: 'the normalization judgement for "choke out", "verbal tap out", "kumara"; belongs in the correction reason / provenance; drop at apply',
  },
  no_schema_change_proposed: true,
};
audit.decisions_for_apply = [
  'TUF 5 Brandon Melendez vs Gray Maynard (quarter-final): the commission winner is Gray Maynard; the archive has Melendez. First winner correction in the TUF archive — approve a winner commission_correction and closing the quarter_finals conflict with the record as its resolution.',
  'TUF 5 Matt Wiman vs Marlon Sims: printed "choke out" read as Technical submission (rear naked choke) (equals the archive). Confirm the reading.',
  'TUF 6 Matt Arroyo vs Troy Mandaloniz: printed "verbal tap out … – arm bar" read as Submission (armbar); "verbal" kept only in result_text. Confirm.',
  'TUF 6 method contradictions: Georgieff vs Mandaloniz KO (punch) → TKO; Speer vs Sotiropoulos KO (strikes) → TKO; Speer vs Saunders Decision (unanimous) → Decision (majority). Under the TUF 3 rule the category is corrected; decide whether "punch" / "strikes" survive as method_detail.',
  'TUF 6 quarter-final Mac Danzig vs John Kolosci: the archive row duplicates the semi-final (4:28); the record gives 3:57 on 2007-07-03. Correct the values; episode placement is not settled by the record.',
  'TUF 6 "0611/07" → 2007-06-11 with date_printed; "Sotriopoulos" → George Sotiropoulos via the print-defect fallback; "kumara" → kimura. Confirm the three readings.',
  'TUF 6 page-3 note: carry as commission-sourced timeline events (Arroyo injury/withdrawal, Kolosci replacement) with episode null, or leave for a later timeline batch.',
  'Recorded only, no write: Richie Hightower printed DOB 1981-11-24 vs canonical 1974-11-26 (the canonical value equals John Kolosci\'s DOB exactly — worth a separate identity review).',
];
audit.generic_matrix_observation = 'Found by this audit and FIXED in its own PR (branch tuf-matrix-exact-verification, scripts/tuf/lib/boutVerification.mjs): the old completeness matrix counted a house (exhibition) bout as verified when any other professional bout between the same two fighter ids had the same winner (TUF 5 Diaz vs Maynard via 2013; TUF 6 Barrera vs Saunders via the 2007 finale; 9 house bouts across TUF 5, 6, 7, 11, 24, 26, plus 2 TUF 33 finals with no recorded finale link; none in TUF 1-4). The matrix simulation below is re-measured on the exact verifier; the BEFORE numbers of the first simulation were contaminated and are superseded.';
fs.writeFileSync(OUT_JSON, JSON.stringify(audit, null, 1) + '\n');

const md = ['# TUF 5 + TUF 6 — Nevada State Athletic Commission reconciliation audit (2026-09-13)', '', 'Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/nsac_tuf5_tuf6_audit_2026-09-13.json` (`scripts/tuf/audit_nsac_tuf5_tuf6.mjs`). Matrix simulation: `scripts/tuf/evidence/nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json`.', ''];
const t = (v) => (v == null ? '—' : String(v));
for (const [slug, s] of Object.entries(audit.seasons)) {
  const d = s.document;
  md.push(`## ${slug.toUpperCase()}`, '', '| Document | |', '|---|---|', `| URL | ${d.url} |`, `| Live | HTTP ${d.live.http}, ${d.live.content_type}, ${d.bytes} bytes, Last-Modified ${d.live.last_modified} |`,
    `| Archive | ${d.archive_url} (HTTP ${d.archive.http}, ${d.archive.bytes} bytes, raw capture) |`, `| sha256 (live = archive, byte-identical) | \`${d.sha256}\` |`, `| Pages | ${d.pages} (PDF created ${d.pdf_metadata.created}) |`,
    `| Title | "${d.title_quote}" |`, `| Classification wording | "${d.classification_language.quote}" — ${d.classification_language.where} |`,
    `| Season identity | ${d.season_identity.basis} |`, `| Location | ${d.location} |`, `| Remarks | ${d.remarks_note} |`,
    ...(d.printed_notes.length ? [`| Printed note | page ${d.printed_notes[0].page}, ${d.printed_notes[0].where}: "${d.printed_notes[0].quote}" |`] : []), '');
  md.push('| Measure | Value |', '|---|---|');
  for (const [k, v] of Object.entries(s.summary)) md.push(`| ${k.replace(/_/g, ' ')} | ${typeof v === 'object' ? JSON.stringify(v) : v} |`);
  md.push('', '| Bout | Stage | Ep | NSAC record · date | Canonical (winner · method · R · time) | Commission (printed) | Differences |', '|---|---|---|---|---|---|---|');
  for (const x of s.bouts) md.push(`| ${x.bout} | ${x.stage.replace('_', ' ')} | ${t(x.episode)} | ${t(x.record_id)} · ${t(x.commission?.date)} | ${x.canonical.winner} · ${x.canonical.method} · R${x.canonical.round} · ${t(x.canonical.time)} | "${x.commission?.result_text}" | ${x.discrepancies.filter((q) => ['winner', 'winner_printed_name', 'method', 'method_reading', 'round', 'time', 'date_printed', 'remarks'].includes(q.field)).map((q) => `${q.field} [${q.kind}]: ${t(typeof q.canonical === 'object' ? JSON.stringify(q.canonical) : q.canonical)} → ${t(typeof q.commission === 'object' ? JSON.stringify(q.commission) : q.commission)}`).join('; ') || 'none'} |`);
  md.push('', '| Fighter | Printed name | Printed DOB | Canonical DOB | State |', '|---|---|---|---|---|');
  for (const x of s.dates_of_birth) md.push(`| ${x.fighter} | ${x.printed_name} | ${x.printed} | ${t(x.canonical)} | ${x.state} |`);
  md.push('', '### Open conflicts', '');
  if (!s.conflicts.length) md.push('- none recorded in `_conflicts`');
  for (const cf of s.conflicts) md.push(`- **${cf.field}** — ${cf.verdict.replace(/_/g, ' ')}. ${(cf.commission_facts || []).join(' ')} ${cf.resolves ?? ''}${cf.does_not_settle ? ` Does not settle: ${cf.does_not_settle}` : ''} ${cf.recommendation ?? cf.note ?? ''}`);
  md.push('', '### Structure and format exceptions', '');
  for (const x of s.structure) md.push(`- **${x.item}** — ${x.verdict.replace(/_/g, ' ')}. ${x.detail}`);
  md.push('');
}
md.push('## Architecture check', '', `Existing commission architecture sufficient: **${audit.architecture.sufficient ? 'YES' : 'NO'}**. No schema change proposed.`, '');
for (const x of audit.architecture.fits_without_change) md.push(`- ${x}`);
md.push('', '## Decisions an apply would need', '');
for (const x of audit.decisions_for_apply) md.push(`- ${x}`);
md.push('', '## Generic matrix defect (fixed separately, before any apply)', '', audit.generic_matrix_observation, '');
const simPath = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json');
if (fs.existsSync(simPath)) {
  const sim = JSON.parse(fs.readFileSync(simPath, 'utf8'));
  md.push('## Matrix simulation (temporary copy, read-only selects, exact verifier)', '', '| Season | | Status | Blockers | Results verified | Secondary-only | Commission-backed exhibitions | Classification unresolved |', '|---|---|---|---|---|---|---|---|');
  for (const [slug, v] of Object.entries(sim.seasons)) for (const [k, m] of Object.entries(v)) md.push(`| ${slug} | ${k.replace('_', ' ')} | ${m.status} | ${m.blockers.join(', ') || '—'} | ${m.result_verified}/${m.bouts} | ${m.secondary_only} | ${m.exhibitions_commission_backed}/${m.exhibitions} | ${m.classification_unresolved} |`);
  md.push('', `Only ${sim.seasons_with_changed_verdict_or_counts.join(' and ')} change; totals stay ${JSON.stringify(sim.totals_if_applied)}.`, '');
}
fs.writeFileSync(OUT_MD, md.join('\n') + '\n');
for (const [slug, s] of Object.entries(audit.seasons)) console.log(slug, JSON.stringify({ ...s.summary, pdf: s.local_pdf_check }, null, 1));
