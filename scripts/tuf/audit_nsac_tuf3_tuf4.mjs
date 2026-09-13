#!/usr/bin/env node
/**
 * TUF 3 + TUF 4 — Nevada State Athletic Commission reconciliation AUDIT. READ-ONLY.
 *
 *   node scripts/tuf/audit_nsac_tuf3_tuf4.mjs [--pdf-dir <dir holding live3.pdf, live4.pdf>]
 *
 * Same method as scripts/tuf/audit_tuf1_nsac.mjs: the commission documents are
 * transcribed below in the shape of web/data/tuf/commission_records.json and
 * compared, field by field, with the canonical house bouts. Writes only:
 *   scripts/tuf/evidence/nsac_tuf3_tuf4_audit_2026-09-13.json
 *   docs/tuf/nsac_tuf3_tuf4_reconciliation_audit_2026-09-13.md
 * No season, ledger, identity, database or page change. Documents are not
 * redistributed; --pdf-dir re-verifies their hashes against local copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const pdfDir = argv.includes('--pdf-dir') ? argv[argv.indexOf('--pdf-dir') + 1] : null;
const OUT_JSON = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf3_tuf4_audit_2026-09-13.json');
const OUT_MD = path.join(ROOT, 'docs', 'tuf', 'nsac_tuf3_tuf4_reconciliation_audit_2026-09-13.md');
const RETRIEVED = '2026-09-13';

const OFFICIALS_2006 = (doctors) => ({
  referees: ['Steve Mazzagatti'], visiting_referees: ['Herb Dean', 'John McCarthy'],
  judges: ['Adalaide Byrd', 'Dalby Shirley', 'Glenn Trowbridge', 'Tony Weeks'], visiting_judges: ['Abe Belardo', 'Nelson Hamilton', 'Cecil Peoples', 'Marcos Rosales'],
  timekeepers: ['Jane Broadfoot', 'James Cavin', 'Steve Esposito', 'Mike LaCella'], ringside_doctors: doctors,
});
const DOCS = {
  'tuf-3': {
    id: 'nsac-2006-tuf-season-3', source_family: 'athletic_commission', source_type: 'commission_result_record',
    commission: 'Nevada State Athletic Commission', jurisdiction: 'Nevada',
    document: 'Mixed Martial Arts Exhibition Results (TUF Season 3 results record)', seasons: ['tuf-3'],
    url: 'https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON3.pdf',
    archive_url: 'https://web.archive.org/web/20161219211127/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON3.pdf',
    sha256: 'ba5a84252378e0d8d19f5e4749cf965dc2a478207483e59c75da1ba33b6ee2ed', bytes: 51136, pages: 2, retrieved: RETRIEVED,
    live: { http: 200, content_type: 'application/pdf', last_modified: 'Wed, 06 Feb 2013 22:42:33 GMT' }, live_matches_archive: true,
    pdf_metadata: { title: 'STATE OF NEVADA', author: 'Athletic Commission', created: '2006-06-19' },
    title_quote: 'MIXED MARTIAL ARTS EXHIBITION RESULTS',
    classification_language: { quote: 'MIXED MARTIAL ARTS EXHIBITION RESULTS', where: 'document title, page 1; the results column is headed "Exhibition Results" on both pages' },
    season_identity: { printed: false, basis: 'No season number or show name is printed. Season 3 identity rests on the file name TUFSEASON3.pdf (2006_Results), location "UFC Training Center, Las Vegas", show dates 2006-01-24..2006-02-24, and the pairings matching the TUF 3 house bouts.' },
    location: 'UFC Training Center, Las Vegas', promoter: 'Zuffa, LLC', executive_director: 'Marc Ratner',
    officials: OFFICIALS_2006(['William Berliner', 'Al Capanna', 'Jeff Davidson', 'James Dettling', 'James Game', 'David Watson']),
    remarks_note: 'The Remarks column is empty for all 12 bouts.',
  },
  'tuf-4': {
    id: 'nsac-2006-tuf-season-4', source_family: 'athletic_commission', source_type: 'commission_result_record',
    commission: 'Nevada State Athletic Commission', jurisdiction: 'Nevada',
    document: 'Mixed Martial Arts Results (TUF Season 4 results record)', seasons: ['tuf-4'],
    url: 'https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON4.pdf',
    archive_url: 'https://web.archive.org/web/20161219211150/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON4.pdf',
    sha256: 'b9c780a2e8fe2b8f740fbb360947a0c97d416e294943468f7fe731201f6dd4dd', bytes: 52762, pages: 2, retrieved: RETRIEVED,
    live: { http: 200, content_type: 'application/pdf', last_modified: 'Wed, 06 Feb 2013 22:42:46 GMT' }, live_matches_archive: true,
    pdf_metadata: { title: 'STATE OF NEVADA', author: 'Athletic Commission', created: '2006-11-09' },
    title_quote: 'MIXED MARTIAL ARTS RESULTS',
    classification_language: { quote: 'Exhibition Results', where: 'results column header on both pages; the document title reads "MIXED MARTIAL ARTS RESULTS" (the same pattern as the applied TUF 2 record)' },
    season_identity: { printed: false, basis: 'No season number or show name is printed. Season 4 identity rests on the file name TUFSEASON4.pdf (2006_Results), location "UFC Training Center, Las Vegas", show dates 2006-05-25..2006-06-27, and the pairings matching the TUF 4 house bouts.' },
    location: 'UFC Training Center, Las Vegas', promoter: 'Zuffa, LLC', executive_director: 'Marc Ratner',
    officials: OFFICIALS_2006(['William Berliner', 'Al Capanna', 'Jeff Davidson', 'James Game', 'Anthony Ruggeroli', 'David Watson']),
    remarks_note: 'The Remarks column is empty for all 12 bouts.',
  },
};

const c = (printed, hometown, dob, weight_lbs) => ({ printed, hometown, dob, weight_lbs });
const cards = (order, scores, judges) => ({ order, cards: scores.map((score, i) => ({ judge: judges[i], score })) });
const J = { Weeks: 'Tony Weeks', Shirley: 'Dalby Shirley', Hamilton: 'Nelson Hamilton', Byrd: 'Adalaide Byrd', Peoples: 'Cecil Peoples', Belardo: 'Abe Belardo', Trowbridge: 'Glenn Trowbridge' };
const rec = (docId, n, o) => ({ id: `${docId.replace('-season-', '-')}-${String(n).padStart(2, '0')}`.replace('nsac-2006-tuf-', 'nsac-2006-tuf'), document_id: docId, remarks: [], ...o });

const R3 = DOCS['tuf-3'].id, R4 = DOCS['tuf-4'].id;
const RECORDS = {
  'tuf-3': [
    rec(R3, 1, { date: '2006-01-24', stage_label: 'Middleweight Quarter Final', corners: [c('MICHAEL DANIEL STINE', 'Hicksville, NY', '1979-01-08', 183), c('KALIB AXEL STARNES', 'Surrey, BC, Canada', '1975-01-06', 185)],
      winner_surname: 'Starnes', result_text: 'Starnes won by TKO 2:10 of the 1st round.', method: 'TKO', round: 1, time: '2:10', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(R3, 2, { date: '2006-01-27', stage_label: 'Light Heavyweight Quarter Final', corners: [c('NOAH INHOFER', 'Yankton, SD', '1981-06-17', 206), c('JESSE LEE FORBES', 'Tempe, AZ', '1984-10-24', 204)],
      winner_surname: 'Inhofer', result_text: 'Inhofer won by tap out 2:36 of the 1st round. – arm bar', method: 'Submission (armbar)', round: 1, time: '2:36', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(R3, 3, { date: '2006-01-30', stage_label: 'Middleweight Quarter Final', corners: [c('KENDALL KEKOA GROVE', 'Las Vegas, NV', '1982-11-12', 185), c('ROSS JOHN POINTON', 'Stout on Trent, England', '1978-02-18', 185)],
      winner_surname: 'Grove', result_text: 'Grove won by tap out 3:47 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '3:47', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(R3, 4, { date: '2006-02-02', stage_label: 'Light Heavyweight Quarter Final', corners: [c('MICHAEL GAVIN JOSEPH BISPING', 'Clitheror, Lancs, UK', '1979-02-28', 204.5), c('KRISTIAN BAXTER ROTHAERMEL', 'Metairie, LA', '1972-01-31', 204)],
      winner_surname: 'Bisping', result_text: 'Bisping won by TKO 4:02 of the 1st round.', method: 'TKO', round: 1, time: '4:02', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(R3, 5, { date: '2006-02-07', date_printed: '02/0706', stage_label: 'Middleweight Quarter Final', corners: [c('RORY MICHAEL SINGER', 'Athens, GA', '1976-05-28', 186), c('SOLOMON MARK HUTCHERSON', 'Racine, WI', '1972-08-13', 185)],
      winner_surname: 'Singer', result_text: 'Singer won by TKO 0:23 of the 2nd round.', method: 'TKO', round: 2, time: '0:23', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(R3, 6, { date: '2006-02-10', stage_label: 'Light Heavyweight Quarter Final', corners: [c('JOSHUA LEE HAYNES', 'Medford, OR', '1977-07-30', 202.5), c('TAIT G. FLETCHER', 'Hollywood, CA', '1971-02-07', 205)],
      winner_surname: 'Haynes', result_text: 'Haynes won by split decision.', method: 'Decision (split)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Haynes', 'Fletcher'], ['20-18', '20-18', '18-20'], [J.Weeks, J.Shirley, J.Hamilton]), referee: 'Herb Dean' }),
    rec(R3, 7, { date: '2006-02-14', stage_label: 'Middleweight Quarter Final', corners: [c('MUNTASER DANNY ABBADI', 'Lake Mary, FL', '1983-07-03', 182), c('EDWARD BENSON HERMAN', 'Portland, OR', '1980-10-02', 185)],
      winner_surname: 'Herman', result_text: 'Herman won by tap out 4:20 of the 1st round – arm bar.', method: 'Submission (armbar)', round: 1, time: '4:20', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(R3, 8, { date: '2006-02-18', stage_label: 'Light Heavyweight Quarter Final', corners: [c('MATTHEW S HAMILL', 'New York Mills, NY', '1976-10-05', 204.5), c('MICHAEL JOHN NICKELS', 'Denver, CO', '1971-12-13', 205)],
      winner_surname: 'Hamill', result_text: 'Hamill won by unanimous decision.', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Hamill', 'Nickels'], ['20-18', '20-18', '20-18'], [J.Byrd, J.Weeks, J.Peoples]), referee: 'Steve Mazzagatti' }),
    rec(R3, 9, { date: '2006-02-21', stage_label: 'Middleweight Semi Final', corners: [c('KENDALL KEKOA GROVE', 'Las Vegas, NV', '1982-11-12', 186), c('KALIB AXEL STARNES', 'Surrey, BC, Canada', '1975-01-06', 186)],
      winner_surname: 'Grove', result_text: 'Grove won by TKO 0:34 of the 3rd round.', method: 'TKO', round: 3, time: '0:34', scheduled_rounds: 3, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(R3, 10, { date: '2006-02-22', stage_label: 'Middleweight Semi Final', corners: [c('RORY MICHAEL SINGER', 'Athens, GA', '1976-05-28', 186), c('EDWARD BENSON HERMAN', 'Portland, OR', '1980-10-02', 186)],
      winner_surname: 'Herman', result_text: 'Herman won by tap out 2:31 of the 2nd round – rear naked choke.', method: 'Submission (rear naked choke)', round: 2, time: '2:31', scheduled_rounds: 3, scorecards: null, referee: 'Herb Dean' }),
    rec(R3, 11, { date: '2006-02-23', stage_label: 'Light Heavyweight Semi Final', corners: [c('JOSHUA LEE HAYNES', 'Medford, OR', '1977-07-30', 205.5), c('JESSE LEE FORBES', 'Tempe, AZ', '1984-10-24', 206)],
      winner_surname: 'Haynes', result_text: 'Haynes won by tap out 0:19 of the 2nd round – guillotine choke.', method: 'Submission (guillotine choke)', round: 2, time: '0:19', scheduled_rounds: 3, scorecards: null, referee: 'John McCarthy' }),
    rec(R3, 12, { date: '2006-02-24', stage_label: 'Light Heavyweight Semi Final', corners: [c('MICHAEL GAVIN JOSEPH BISPING', 'Clitheror, Lancs, UK', '1979-02-28', 205), c('ROSS JOHN POINTON', 'Stout on Trent, England', '1978-02-18', 205)],
      winner_surname: 'Bisping', result_text: 'Bisping won by tap out 2:12 of the 1st round – strikes.', method: 'Submission (strikes)', round: 1, time: '2:12', scheduled_rounds: 3, scorecards: null, referee: 'John McCarthy' }),
  ],
  'tuf-4': [
    rec(R4, 1, { date: '2006-05-25', stage_label: 'Welterweight Quarter Final', corners: [c('MEARION BICKHEM aka SHONIE CARTER', 'Chicago, IL', '1972-05-03', 171), c('RICHARD THOMAS CLEMENTI', 'Slidell, LA', '1976-03-31', 171)],
      winner_surname: 'Carter', result_text: 'Carter won by unanimous decision.', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Carter', 'Clementi'], ['20-18', '20-18', '20-18'], [J.Byrd, J.Weeks, J.Belardo]), referee: 'John McCarthy' }),
    rec(R4, 2, { date: '2006-05-30', stage_label: 'Middleweight Quarter Final', corners: [c('EDWIN STANTON DeWEES', 'Scottsdale, AZ', '1982-08-07', 186), c('GIDEON CHARLES RAY', 'Belingbrook, IL', '1973-05-27', 183)],
      winner_surname: 'DeWees', result_text: 'DeWees won by unanimous decision in the sudden victory round.', method: 'Decision (unanimous, sudden victory round)', round: 3, time: null, scheduled_rounds: 2,
      rounds_printed: '2 + Sudden Victory', scorecards: null, referee: 'Herb Dean' }),
    rec(R4, 3, { date: '2006-06-02', stage_label: 'Welterweight Quarter Final', corners: [c('CHRIS SCOTT LYTLE', 'New Palestine, IN', '1974-08-18', 170), c('AARON PETE SPRATT', 'Sherman, TX', '1971-01-09', 170)],
      winner_surname: 'Lytle', result_text: 'Lytle won by tap out 2:08 of the 1st round – Guillotine choke', method: 'Submission (guillotine choke)', round: 1, time: '2:08', scheduled_rounds: 2, scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(R4, 4, { date: '2006-06-06', stage_label: 'Middleweight Quarter Final', corners: [c('BRYAN SCOTT SMITH', 'Elk Grove, CA', '1979-05-21', 184), c('TRAVIS S. LUTTER', 'Fort Worth, TX', '1973-05-12', 185.5)],
      winner_surname: 'Lutter', result_text: 'Lutter won by tap out 1:15 of the 1st round – rear naked choke.', method: 'Submission (rear naked choke)', round: 1, time: '1:15', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(R4, 5, { date: '2006-06-09', stage_label: 'Welterweight Quarter Final', corners: [c('DIN YERO THOMAS', 'Port St. Lucis, FL', '1976-09-28', 167.5), c('MICHAEL WAYNE BURNETT', 'Tulsa, OK', '1976-04-12', 169.5)],
      winner_surname: 'Thomas', result_text: 'Thomas won by tap out 2:33 of the 1st round – triangle choke.', method: 'Submission (triangle choke)', round: 1, time: '2:33', scheduled_rounds: 2, scorecards: null, referee: 'Herb Dean' }),
    rec(R4, 6, { date: '2006-06-13', stage_label: 'Middleweight Quarter Final', corners: [c('PETER K. SELL', 'Westbury, NY', '1982-08-25', 185), c('CHARLES SIDNEY McCARTHY', 'Coconut Creek, FL', '1980-08-06', 185)],
      winner_surname: 'Sell', result_text: 'Sell won by unanimous decision in the sudden victory round.', method: 'Decision (unanimous, sudden victory round)', round: 3, time: null, scheduled_rounds: 2,
      rounds_printed: '2 + Sudden Victory', scorecards: null, referee: 'Steve Mazzagatti' }),
    rec(R4, 7, { date: '2006-06-16', stage_label: 'Welterweight Quarter Final', corners: [c('MATTHEW JOHN SERRA', 'East Meadow, NY', '1974-06-02', 170.5), c('AARON PETE SPRATT', 'Sherman, TX', '1971-01-09', 169.5)],
      winner_surname: 'Serra', result_text: 'Serra won by tap out 3:29 of the 1st round – strikes.', method: 'Submission (strikes)', round: 1, time: '3:29', scheduled_rounds: 2, scorecards: null, referee: 'John McCarthy' }),
    rec(R4, 8, { date: '2006-06-20', stage_label: 'Middleweight Quarter Final', corners: [c('PATRICK COTE', 'Beauport. Quebec, Canada', '1980-02-29', 185), c('JORGE LUIS RIVERA', 'Urbridge, MA', '1972-02-28', 184.5)],
      winner_surname: 'Cote', result_text: 'Cote won by unanimous decision.', method: 'Decision (unanimous)', round: 2, time: null, scheduled_rounds: 2,
      scorecards: cards(['Cote', 'Rivera'], ['20-18', '20-18', '20-18'], [J.Trowbridge, J.Byrd, J.Peoples]), referee: 'Herb Dean' }),
    rec(R4, 9, { date: '2006-06-26', stage_label: 'WELTERWEIGHT SEMI-FINAL BOUT', corners: [c('CHRIS SCOTT LYTLE', 'New Palestine, IN', '1974-08-18', 169), c('DIN YERO THOMAS', 'Port St. Lucis, FL', '1976-09-28', 168.5)],
      winner_surname: 'Lytle', result_text: 'Lytle won by unanimous decision', method: 'Decision (unanimous)', round: 3, time: null, scheduled_rounds: 3,
      scorecards: cards(['Lytle', 'Thomas'], ['29-28', '30-27', '30-27'], [J.Shirley, J.Trowbridge, J.Belardo]), scorecard_order_printed: 'Lytle - Thomasr', referee: 'Steve Mazzagatti' }),
    rec(R4, 10, { date: '2006-06-26', stage_label: 'WELTERWEIGHT SEMI-FINAL BOUT', corners: [c('MATTHEW JOHN SERRA', 'East Meadow, NY', '1974-06-02', 170), c('MEARION BICKHEM aka SHONIE CARTER', 'Chicago, IL', '1972-05-03', 170)],
      winner_surname: 'Serra', result_text: 'Serra won by unanimous decision', method: 'Decision (unanimous)', round: 3, time: null, scheduled_rounds: 3,
      scorecards: cards(['Serra', 'Carter'], ['29-28', '30-27', '29-28'], [J.Shirley, J.Trowbridge, J.Belardo]), referee: 'John McCarthy' }),
    rec(R4, 11, { date: '2006-06-27', stage_label: 'MIDDLEWEIGHT SEMI-FINAL BOUT', corners: [c('PETER K. SELL', 'Westbury, NY', '1982-08-25', 185), c('TRAVIS S. LUTTER', 'Fort Worth, TX', '1973-05-12', 185.5)],
      winner_surname: 'Lutter', result_text: 'Lutter won by unanimous decision.', method: 'Decision (unanimous)', round: 3, time: null, scheduled_rounds: 3,
      scorecards: cards(['Sell', 'Lutter'], ['27-30', '27-30', '26-30'], [J.Weeks, J.Trowbridge, J.Hamilton]), referee: 'John McCarthy' }),
    rec(R4, 12, { date: '2006-06-27', stage_label: 'MIDDLEWEIGHT SEMI-FINAL BOUT', corners: [c('PATRICK COTE', 'Beauport. Quebec, Canada', '1980-02-29', 185), c('EDWIN STANTON DeWEES', 'Scottsdale, AZ', '1982-08-07', 185)],
      winner_surname: 'Cote', result_text: 'Cote won by unanimous decision.', method: 'Decision (unanimous)', round: 3, time: null, scheduled_rounds: 3,
      scorecards: cards(['Cote', 'DeWees'], ['30-27', '30-27', '30-27'], [J.Weeks, J.Trowbridge, J.Hamilton]), referee: 'Steve Mazzagatti' }),
  ],
};
/* Canonical ufc_fighters.dob, read-only select 2026-09-13 (identity cross-check only; null = no canonical id). */
const CANONICAL_DOB = {
  'Kalib Starnes': '1975-01-06', 'Ross Pointon': '1980-02-18', 'Kendall Grove': '1982-11-12', 'Solomon Hutcherson': '1972-08-31', 'Rory Singer': '1976-05-28',
  'Ed Herman': '1980-10-02', 'Danny Abbadi': '1983-07-03', 'Jesse Forbes': '1984-10-24', 'Josh Haynes': '1977-07-30', 'Mike Nickels': '1971-12-13',
  'Matt Hamill': '1976-10-05', 'Kristian Rothaermel': '1972-01-31', 'Michael Bisping': '1979-02-28', 'Mike Stine': null, 'Noah Inhofer': null, 'Tait Fletcher': null,
  'Rich Clementi': '1976-03-31', 'Shonie Carter': '1972-05-03', 'Pete Spratt': '1971-01-09', 'Matt Serra': '1974-06-02', 'Chris Lytle': '1974-08-18',
  'Mikey Burnett': '1974-04-12', 'Din Thomas': '1976-09-28', 'Charles McCarthy': '1980-08-06', 'Pete Sell': '1982-08-05', 'Travis Lutter': '1973-05-12',
  'Scott Smith': '1979-05-21', 'Jorge Rivera': '1972-02-28', 'Patrick Côté': '1980-02-29', 'Gideon Ray': '1973-05-27', 'Edwin DeWees': '1982-08-07',
};

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z]+/).filter(Boolean);
const surname = (name) => words(name).at(-1);
const printedHas = (printed, name) => words(printed).includes(surname(name));
const STAGE = (label) => /semi/i.test(label) ? 'semi_final' : /quarter/i.test(label) ? 'quarter_final' : null;
const WC = (label) => /light heavyweight/i.test(label) ? 'Light Heavyweight' : /middleweight/i.test(label) ? 'Middleweight' : /welterweight/i.test(label) ? 'Welterweight' : null;
const base = (m) => String(m ?? '').replace(/\s*\(.*\)$/, '');
const paren = (m) => (String(m ?? '').match(/\((.*)\)$/) || [])[1] ?? null;

function methodKind(canon, comm) {
  if (canon === comm) return null;
  if (!canon) return 'source_only_new_fact';
  const cb = base(canon), mb = base(comm);
  if (cb === mb && paren(comm) && (!paren(canon) || fold(paren(comm)).includes(fold(paren(canon))))) return 'primary_normalization';   // commission states more
  if (cb === mb && paren(canon) && !paren(comm)) return 'compatible_secondary_detail';                                             // draft adds detail
  if (cb === mb && paren(canon) && paren(comm) && fold(paren(canon)).endsWith(fold(paren(comm)))) return 'compatible_secondary_detail';
  return 'true_contradiction';
}

const audit = { _about: 'READ-ONLY audit (scripts/tuf/audit_nsac_tuf3_tuf4.mjs). Nothing applied. Documents are not redistributed; records are transcriptions for reconciliation, printed names and hometowns as printed.', seasons: {} };
for (const slug of ['tuf-3', 'tuf-4']) {
  const doc = DOCS[slug];
  const records = RECORDS[slug].map((r) => ({ ...r, weight_class: WC(r.stage_label), stage: STAGE(r.stage_label) }));
  let pdf = null;
  if (pdfDir) {
    const buf = fs.readFileSync(path.join(pdfDir, `live${slug.split('-')[1]}.pdf`));
    pdf = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    pdf.matches = pdf.sha256 === doc.sha256 && pdf.bytes === doc.bytes;
  }
  const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', `${slug}.json`), 'utf8'));
  const house = season.bracket.flatMap((wc) => wc.stages.flatMap((st) => st.bouts.filter((b) => !b.on_finale_card).map((b) => ({ ...b, weight_class: wc.weight_class, stage: st.stage, stage_status: st.status ?? null }))));

  const used = new Map();
  const bouts = house.map((b) => {
    const cands = records.filter((r) => r.weight_class === b.weight_class && r.stage === b.stage
      && r.corners.length === 2 && ((printedHas(r.corners[0].printed, b.a) && printedHas(r.corners[1].printed, b.b)) || (printedHas(r.corners[0].printed, b.b) && printedHas(r.corners[1].printed, b.a))));
    const r = cands.length === 1 ? cands[0] : null;
    if (r) used.set(r.id, (used.get(r.id) || 0) + 1);
    const diffs = [];
    if (r) {
      const commWinner = [b.a, b.b].find((n) => surname(n) === fold(r.winner_surname).replace(/[^a-z]/g, '')) ?? null;
      if (commWinner !== b.winner) diffs.push({ field: 'winner', kind: 'true_contradiction', canonical: b.winner, commission: commWinner ?? r.winner_surname });
      const mk = methodKind(b.method, r.method);
      if (mk) diffs.push({ field: 'method', kind: mk, canonical: b.method, commission: r.method,
        ...(mk === 'compatible_secondary_detail' ? { detail: paren(b.method) } : {}),
        ...(mk === 'true_contradiction' && paren(b.method) ? { note: `the draft's "${paren(b.method)}" sits under a different method category than the record's; per the TUF 1 rule a contradicted label is not carried forward, but the injury/strike detail itself may be reviewed` } : {}) });
      if (b.round !== r.round) diffs.push({ field: 'round', kind: 'true_contradiction', canonical: b.round, commission: r.round });
      if ((b.time ?? null) !== (r.time ?? null)) diffs.push({ field: 'time', kind: b.time == null ? 'source_only_new_fact' : 'true_contradiction', canonical: b.time ?? null, commission: r.time });
      if (!b.fight_date) diffs.push({ field: 'fight_date', kind: 'source_only_new_fact', canonical: null, commission: r.date, ...(r.date_printed ? { printed: r.date_printed, note: 'misprinted in the document; read as 2006-02-07 from the printed day/month and its place between 02/02/06 and 02/10/06 — a transcription judgement to confirm' } : {}) });
      diffs.push({ field: 'referee', kind: 'source_only_new_fact', canonical: null, commission: r.referee });
      if (r.scorecards) diffs.push({ field: 'scorecards', kind: 'source_only_new_fact', canonical: null, commission: r.scorecards });
      diffs.push({ field: 'weights', kind: 'source_only_new_fact', canonical: null, commission: r.corners.map((x) => [x.printed, x.weight_lbs]) });
      if (r.rounds_printed) diffs.push({ field: 'rounds_printed', kind: 'source_only_new_fact', canonical: null, commission: r.rounds_printed, note: 'decided in the sudden victory round after two scheduled rounds' });
    }
    return {
      bout: `${b.a} vs ${b.b}`, weight_class: b.weight_class, stage: b.stage, stage_status: b.stage_status, episode: b.episode,
      match: cands.length === 1 ? 'deterministic' : cands.length ? 'ambiguous' : 'unmatched', record_id: r?.id ?? null,
      canonical: { winner: b.winner, method: b.method, round: b.round, time: b.time ?? null, fight_date: b.fight_date ?? null, classification: b.classification, classification_source: b.classification_source ?? null },
      commission: r ? { winner_surname: r.winner_surname, method: r.method, round: r.round, time: r.time, date: r.date, result_text: r.result_text, referee: r.referee, scorecards: r.scorecards, weights: r.corners.map((x) => [x.printed, x.weight_lbs]), remarks: r.remarks, stage_label: r.stage_label } : null,
      ids: [b.a_fighter_id ?? null, b.b_fighter_id ?? null],
      discrepancies: diffs,
    };
  });
  /* Ledger shape: a matched record names its bracket bout and winner by the archive's names. */
  for (const x of bouts.filter((q) => q.record_id)) {
    const r = records.find((q) => q.id === x.record_id);
    const [a, b] = x.bout.split(' vs ');
    r.bout = { weight_class: x.weight_class, stage: x.stage, a, b };
    r.winner = [a, b].find((n) => surname(n) === fold(r.winner_surname).replace(/[^a-z]/g, '')) ?? null;
  }
  const duplicateUse = [...used].filter(([, n]) => n > 1).map(([id]) => id);
  const unusedRecords = records.filter((r) => !used.has(r.id)).map((r) => r.id);

  /* dates of birth */
  const dobs = [];
  for (const b of bouts.filter((x) => x.record_id)) {
    const r = records.find((x) => x.id === b.record_id);
    for (const name of b.bout.split(' vs ')) {
      const corner = r.corners.find((x) => printedHas(x.printed, name));
      if (!corner || dobs.some((d) => d.fighter === name && d.printed === corner.dob)) continue;
      const canonical = CANONICAL_DOB[name];
      dobs.push({ fighter: name, printed_name: corner.printed, printed: corner.dob, canonical: canonical ?? null,
        state: canonical === undefined ? 'not_checked' : canonical === null ? 'no_canonical_identity' : canonical === corner.dob ? 'agrees' : 'identity_disagreement' });
    }
  }

  /* conflicts */
  const conflicts = (season._conflicts || []).map((cf) => {
    if (slug === 'tuf-3' && /Light Heavyweight_semi_final/.test(cf.field)) {
      return { field: cf.field, verdict: 'partially_informs', detail: cf.detail,
        commission_facts: ['NSAC records Haynes vs Forbes on 2006-02-23 and Bisping vs Pointon on 2006-02-24, both headed "Light Heavyweight Semi Final".', 'Forbes\'s only other commission bout is his quarter-final loss to Inhofer (2006-01-27); Pointon\'s is his middleweight quarter-final loss to Grove (2006-01-30). The 12 records account for all 12 house bouts, so no additional sanctioned bout for either fighter exists in this document.'],
        does_not_settle: 'Why each fighter entered the semi-finals (the season source\'s format_exceptions describe replacements: Hamill out injured, Pointon moved up). The record states no replacement, injury or withdrawal.',
        recommendation: 'Keep open. The record supports "replacement, not a missing bout" but does not state it; closing needs a source that states the replacements.' };
    }
    if (slug === 'tuf-4' && /Welterweight_quarter_final/.test(cf.field)) {
      return { field: cf.field, verdict: 'partially_informs', detail: cf.detail,
        commission_facts: ['NSAC records Pete Spratt ("AARON PETE SPRATT") in two bouts headed "Welterweight Quarter Final": a loss to Lytle on 2006-06-02 and a loss to Serra on 2006-06-16.', 'All 12 records account for all 12 house bouts; no other welterweight quarter-final bout is listed.'],
        does_not_settle: 'That Spratt\'s second quarter-final was a replacement entry (the season source\'s format_exceptions: a coin toss let Spratt replace the evicted Jeremy Jackson). The record states no replacement.',
        recommendation: 'Keep open. The record confirms both bouts, their stage labels and order, but not the replacement.' };
    }
    return { field: cf.field, verdict: 'not_touched', detail: cf.detail };
  });

  const counts = (kind, field) => bouts.flatMap((x) => x.discrepancies).filter((d) => (!kind || d.kind === kind) && (!field || d.field === field)).length;
  audit.seasons[slug] = {
    document: doc, local_pdf_check: pdf, records,
    summary: {
      house_bouts_expected: 12, house_bouts_in_archive: house.length, records_in_document: records.length,
      matched: bouts.filter((x) => x.match === 'deterministic').length, unmatched: bouts.filter((x) => x.match === 'unmatched').length,
      ambiguous: bouts.filter((x) => x.match === 'ambiguous').length, duplicate_use: duplicateUse, unused_records: unusedRecords,
      differences: {
        winner: counts(null, 'winner'), method: counts(null, 'method'), round: counts(null, 'round'),
        time_contradictions: counts('true_contradiction', 'time'), time_source_only: counts('source_only_new_fact', 'time'),
      },
      method_kinds: Object.fromEntries(['true_contradiction', 'primary_normalization', 'compatible_secondary_detail', 'source_only_new_fact'].map((k) => [k, bouts.flatMap((x) => x.discrepancies.filter((d) => d.field === 'method' && d.kind === k).map(() => x.bout))])),
      fight_dates: records.length, referees: records.filter((r) => r.referee).length,
      scorecards: records.filter((r) => r.scorecards).length, decisions: records.filter((r) => /^Decision/.test(r.method)).length,
      decisions_without_cards: records.filter((r) => /^Decision/.test(r.method) && !r.scorecards).map((r) => r.id),
      weights: records.reduce((n, r) => n + r.corners.filter((x) => x.weight_lbs > 0).length, 0), remarks: 0,
      dob: { agrees: dobs.filter((d) => d.state === 'agrees').length, disagreements: dobs.filter((d) => d.state === 'identity_disagreement').map((d) => `${d.fighter}: printed ${d.printed}, canonical ${d.canonical}`), no_canonical_identity: dobs.filter((d) => d.state === 'no_canonical_identity').map((d) => `${d.fighter}: printed ${d.printed}`) },
      classification_wording: doc.classification_language.quote,
      classification_primary_possible: bouts.every((x) => x.match === 'deterministic'),
      fight_dates_follow_episode_order: [...bouts].sort((x, y) => x.episode - y.episode || x.commission.date.localeCompare(y.commission.date)).every((x, i, a) => i === 0 || x.commission.date >= a[i - 1].commission.date),
      open_conflicts: conflicts.map((x) => `${x.field}: ${x.verdict}`),
    },
    bouts, dates_of_birth: dobs, conflicts,
  };
}
fs.writeFileSync(OUT_JSON, JSON.stringify(audit, null, 1) + '\n');

const md = ['# TUF 3 + TUF 4 — Nevada State Athletic Commission reconciliation audit (2026-09-13)', '', 'Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/nsac_tuf3_tuf4_audit_2026-09-13.json` (`scripts/tuf/audit_nsac_tuf3_tuf4.mjs`).', ''];
const t = (v) => (v == null ? '—' : String(v));
for (const [slug, s] of Object.entries(audit.seasons)) {
  const d = s.document;
  md.push(`## ${slug.toUpperCase()}`, '', '| Document | |', '|---|---|', `| URL | ${d.url} |`, `| Live | HTTP ${d.live.http}, ${d.live.content_type}, ${d.bytes} bytes, Last-Modified ${d.live.last_modified} |`,
    `| Archive | ${d.archive_url} |`, `| sha256 (live = archive) | \`${d.sha256}\` |`, `| Title | "${d.title_quote}" |`, `| Classification wording | "${d.classification_language.quote}" — ${d.classification_language.where} |`,
    `| Season identity | ${d.season_identity.basis} |`, `| Remarks | ${d.remarks_note} |`, '');
  md.push('| Measure | Value |', '|---|---|');
  for (const [k, v] of Object.entries(s.summary)) md.push(`| ${k.replace(/_/g, ' ')} | ${typeof v === 'object' ? JSON.stringify(v) : v} |`);
  md.push('', '| Bout | Stage | Ep | NSAC date | Canonical (method · R · time) | Commission | Differences |', '|---|---|---|---|---|---|---|');
  for (const x of s.bouts) md.push(`| ${x.bout} | ${x.weight_class} ${x.stage.replace('_', ' ')} | ${x.episode} | ${t(x.commission?.date)} | ${x.canonical.method} · R${x.canonical.round} · ${t(x.canonical.time)} | "${x.commission?.result_text}" | ${x.discrepancies.filter((q) => ['winner', 'method', 'round', 'time'].includes(q.field)).map((q) => `${q.field} [${q.kind}]: ${t(q.canonical)} → ${t(q.commission)}`).join('; ') || 'none'} |`);
  md.push('', '| Fighter | Printed DOB | Canonical | State |', '|---|---|---|---|');
  for (const x of s.dates_of_birth) md.push(`| ${x.fighter} (${x.printed_name}) | ${x.printed} | ${t(x.canonical)} | ${x.state} |`);
  md.push('', '### Open conflicts', '');
  for (const cf of s.conflicts) md.push(`- **${cf.field}** — ${cf.verdict.replace('_', ' ')}. ${(cf.commission_facts || []).join(' ')} Does not settle: ${cf.does_not_settle ?? '—'} ${cf.recommendation ?? ''}`);
  md.push('');
}
fs.writeFileSync(OUT_MD, md.join('\n') + '\n');
for (const [slug, s] of Object.entries(audit.seasons)) console.log(slug, JSON.stringify({ ...s.summary, pdf: s.local_pdf_check }, null, 1));
