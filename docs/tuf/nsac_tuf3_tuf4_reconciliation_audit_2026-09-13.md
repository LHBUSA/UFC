# TUF 3 + TUF 4 — Nevada State Athletic Commission reconciliation audit (2026-09-13)

Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/nsac_tuf3_tuf4_audit_2026-09-13.json` (`scripts/tuf/audit_nsac_tuf3_tuf4.mjs`).

## TUF-3

| Document | |
|---|---|
| URL | https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON3.pdf |
| Live | HTTP 200, application/pdf, 51136 bytes, Last-Modified Wed, 06 Feb 2013 22:42:33 GMT |
| Archive | https://web.archive.org/web/20161219211127/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON3.pdf |
| sha256 (live = archive) | `ba5a84252378e0d8d19f5e4749cf965dc2a478207483e59c75da1ba33b6ee2ed` |
| Title | "MIXED MARTIAL ARTS EXHIBITION RESULTS" |
| Classification wording | "MIXED MARTIAL ARTS EXHIBITION RESULTS" — document title, page 1; the results column is headed "Exhibition Results" on both pages |
| Season identity | No season number or show name is printed. Season 3 identity rests on the file name TUFSEASON3.pdf (2006_Results), location "UFC Training Center, Las Vegas", show dates 2006-01-24..2006-02-24, and the pairings matching the TUF 3 house bouts. |
| Remarks | The Remarks column is empty for all 12 bouts. |

| Measure | Value |
|---|---|
| house bouts expected | 12 |
| house bouts in archive | 12 |
| records in document | 12 |
| matched | 12 |
| unmatched | 0 |
| ambiguous | 0 |
| duplicate use | [] |
| unused records | [] |
| differences | {"winner":0,"method":4,"round":0,"time_contradictions":8,"time_source_only":1} |
| method kinds | {"true_contradiction":["Kalib Starnes vs Mike Stine","Solomon Hutcherson vs Rory Singer","Kalib Starnes vs Kendall Grove"],"primary_normalization":[],"compatible_secondary_detail":["Kristian Rothaermel vs Michael Bisping"],"source_only_new_fact":[]} |
| fight dates | 12 |
| referees | 12 |
| scorecards | 2 |
| decisions | 2 |
| decisions without cards | [] |
| weights | 24 |
| remarks | 0 |
| dob | {"agrees":11,"disagreements":["Ross Pointon: printed 1978-02-18, canonical 1980-02-18","Solomon Hutcherson: printed 1972-08-13, canonical 1972-08-31"],"no_canonical_identity":["Mike Stine: printed 1979-01-08","Noah Inhofer: printed 1981-06-17","Tait Fletcher: printed 1971-02-07"]} |
| classification wording | MIXED MARTIAL ARTS EXHIBITION RESULTS |
| classification primary possible | true |
| fight dates follow episode order | true |
| open conflicts | ["Light Heavyweight_semi_final: partially_informs"] |

| Bout | Stage | Ep | NSAC date | Canonical (method · R · time) | Commission | Differences |
|---|---|---|---|---|---|---|
| Kalib Starnes vs Mike Stine | Middleweight quarter final | 1 | 2006-01-24 | KO (punches) · R1 · 2:09 | "Starnes won by TKO 2:10 of the 1st round." | method [true_contradiction]: KO (punches) → TKO; time [true_contradiction]: 2:09 → 2:10 |
| Ross Pointon vs Kendall Grove | Middleweight quarter final | 3 | 2006-01-30 | Submission (rear naked choke) · R1 · 3:45 | "Grove won by tap out 3:47 of the 1st round – rear naked choke." | time [true_contradiction]: 3:45 → 3:47 |
| Solomon Hutcherson vs Rory Singer | Middleweight quarter final | 5 | 2006-02-07 | KO (head kick and punches) · R2 · 0:21 | "Singer won by TKO 0:23 of the 2nd round." | method [true_contradiction]: KO (head kick and punches) → TKO; time [true_contradiction]: 0:21 → 0:23 |
| Ed Herman vs Danny Abbadi | Middleweight quarter final | 8 | 2006-02-14 | Submission (armbar) · R1 · 4:14 | "Herman won by tap out 4:20 of the 1st round – arm bar." | time [true_contradiction]: 4:14 → 4:20 |
| Kalib Starnes vs Kendall Grove | Middleweight semi final | 10 | 2006-02-21 | Verbal submission (rib injury) · R3 · 0:30 | "Grove won by TKO 0:34 of the 3rd round." | method [true_contradiction]: Verbal submission (rib injury) → TKO; time [true_contradiction]: 0:30 → 0:34 |
| Rory Singer vs Ed Herman | Middleweight semi final | 11 | 2006-02-22 | Submission (rear naked choke) · R2 · 2:31 | "Herman won by tap out 2:31 of the 2nd round – rear naked choke." | none |
| Jesse Forbes vs Noah Inhofer | Light Heavyweight quarter final | 2 | 2006-01-27 | Submission (armbar) · R1 · 2:35 | "Inhofer won by tap out 2:36 of the 1st round. – arm bar" | time [true_contradiction]: 2:35 → 2:36 |
| Tait Fletcher vs Josh Haynes | Light Heavyweight quarter final | 7 | 2006-02-10 | Decision (split) · R2 · — | "Haynes won by split decision." | none |
| Mike Nickels vs Matt Hamill | Light Heavyweight quarter final | 9 | 2006-02-18 | Decision (unanimous) · R2 · — | "Hamill won by unanimous decision." | none |
| Kristian Rothaermel vs Michael Bisping | Light Heavyweight quarter final | 4 | 2006-02-02 | TKO (strikes) · R1 · 3:51 | "Bisping won by TKO 4:02 of the 1st round." | method [compatible_secondary_detail]: TKO (strikes) → TKO; time [true_contradiction]: 3:51 → 4:02 |
| Jesse Forbes vs Josh Haynes | Light Heavyweight semi final | 12 | 2006-02-23 | Submission (guillotine choke) · R2 · 0:18 | "Haynes won by tap out 0:19 of the 2nd round – guillotine choke." | time [true_contradiction]: 0:18 → 0:19 |
| Ross Pointon vs Michael Bisping | Light Heavyweight semi final | 12 | 2006-02-24 | Submission (strikes) · R1 · — | "Bisping won by tap out 2:12 of the 1st round – strikes." | time [source_only_new_fact]: — → 2:12 |

| Fighter | Printed DOB | Canonical | State |
|---|---|---|---|
| Kalib Starnes (KALIB AXEL STARNES) | 1975-01-06 | 1975-01-06 | agrees |
| Mike Stine (MICHAEL DANIEL STINE) | 1979-01-08 | — | no_canonical_identity |
| Ross Pointon (ROSS JOHN POINTON) | 1978-02-18 | 1980-02-18 | identity_disagreement |
| Kendall Grove (KENDALL KEKOA GROVE) | 1982-11-12 | 1982-11-12 | agrees |
| Solomon Hutcherson (SOLOMON MARK HUTCHERSON) | 1972-08-13 | 1972-08-31 | identity_disagreement |
| Rory Singer (RORY MICHAEL SINGER) | 1976-05-28 | 1976-05-28 | agrees |
| Ed Herman (EDWARD BENSON HERMAN) | 1980-10-02 | 1980-10-02 | agrees |
| Danny Abbadi (MUNTASER DANNY ABBADI) | 1983-07-03 | 1983-07-03 | agrees |
| Jesse Forbes (JESSE LEE FORBES) | 1984-10-24 | 1984-10-24 | agrees |
| Noah Inhofer (NOAH INHOFER) | 1981-06-17 | — | no_canonical_identity |
| Tait Fletcher (TAIT G. FLETCHER) | 1971-02-07 | — | no_canonical_identity |
| Josh Haynes (JOSHUA LEE HAYNES) | 1977-07-30 | 1977-07-30 | agrees |
| Mike Nickels (MICHAEL JOHN NICKELS) | 1971-12-13 | 1971-12-13 | agrees |
| Matt Hamill (MATTHEW S HAMILL) | 1976-10-05 | 1976-10-05 | agrees |
| Kristian Rothaermel (KRISTIAN BAXTER ROTHAERMEL) | 1972-01-31 | 1972-01-31 | agrees |
| Michael Bisping (MICHAEL GAVIN JOSEPH BISPING) | 1979-02-28 | 1979-02-28 | agrees |

### Open conflicts

- **Light Heavyweight_semi_final** — partially informs. NSAC records Haynes vs Forbes on 2006-02-23 and Bisping vs Pointon on 2006-02-24, both headed "Light Heavyweight Semi Final". Forbes's only other commission bout is his quarter-final loss to Inhofer (2006-01-27); Pointon's is his middleweight quarter-final loss to Grove (2006-01-30). The 12 records account for all 12 house bouts, so no additional sanctioned bout for either fighter exists in this document. Does not settle: Why each fighter entered the semi-finals (the season source's format_exceptions describe replacements: Hamill out injured, Pointon moved up). The record states no replacement, injury or withdrawal. Keep open. The record supports "replacement, not a missing bout" but does not state it; closing needs a source that states the replacements.

## TUF-4

| Document | |
|---|---|
| URL | https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON4.pdf |
| Live | HTTP 200, application/pdf, 52762 bytes, Last-Modified Wed, 06 Feb 2013 22:42:46 GMT |
| Archive | https://web.archive.org/web/20161219211150/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2006_Results/TUFSEASON4.pdf |
| sha256 (live = archive) | `b9c780a2e8fe2b8f740fbb360947a0c97d416e294943468f7fe731201f6dd4dd` |
| Title | "MIXED MARTIAL ARTS RESULTS" |
| Classification wording | "Exhibition Results" — results column header on both pages; the document title reads "MIXED MARTIAL ARTS RESULTS" (the same pattern as the applied TUF 2 record) |
| Season identity | No season number or show name is printed. Season 4 identity rests on the file name TUFSEASON4.pdf (2006_Results), location "UFC Training Center, Las Vegas", show dates 2006-05-25..2006-06-27, and the pairings matching the TUF 4 house bouts. |
| Remarks | The Remarks column is empty for all 12 bouts. |

| Measure | Value |
|---|---|
| house bouts expected | 12 |
| house bouts in archive | 12 |
| records in document | 12 |
| matched | 12 |
| unmatched | 0 |
| ambiguous | 0 |
| duplicate use | [] |
| unused records | [] |
| differences | {"winner":0,"method":2,"round":0,"time_contradictions":4,"time_source_only":0} |
| method kinds | {"true_contradiction":[],"primary_normalization":["Charles McCarthy vs Pete Sell","Gideon Ray vs Edwin DeWees"],"compatible_secondary_detail":[],"source_only_new_fact":[]} |
| fight dates | 12 |
| referees | 12 |
| scorecards | 6 |
| decisions | 8 |
| decisions without cards | ["nsac-2006-tuf4-02","nsac-2006-tuf4-06"] |
| weights | 24 |
| remarks | 0 |
| dob | {"agrees":13,"disagreements":["Mikey Burnett: printed 1976-04-12, canonical 1974-04-12","Pete Sell: printed 1982-08-25, canonical 1982-08-05"],"no_canonical_identity":[]} |
| classification wording | Exhibition Results |
| classification primary possible | true |
| fight dates follow episode order | true |
| open conflicts | ["Welterweight_quarter_final: partially_informs"] |

| Bout | Stage | Ep | NSAC date | Canonical (method · R · time) | Commission | Differences |
|---|---|---|---|---|---|---|
| Rich Clementi vs Shonie Carter | Welterweight quarter final | 1 | 2006-05-25 | Decision (unanimous) · R2 · — | "Carter won by unanimous decision." | none |
| Pete Spratt vs Matt Serra | Welterweight quarter final | 7 | 2006-06-16 | Submission (strikes) · R1 · 3:26 | "Serra won by tap out 3:29 of the 1st round – strikes." | time [true_contradiction]: 3:26 → 3:29 |
| Pete Spratt vs Chris Lytle | Welterweight quarter final | 3 | 2006-06-02 | Submission (guillotine choke) · R1 · 2:06 | "Lytle won by tap out 2:08 of the 1st round – Guillotine choke" | time [true_contradiction]: 2:06 → 2:08 |
| Mikey Burnett vs Din Thomas | Welterweight quarter final | 5 | 2006-06-09 | Submission (triangle choke) · R1 · 2:30 | "Thomas won by tap out 2:33 of the 1st round – triangle choke." | time [true_contradiction]: 2:30 → 2:33 |
| Shonie Carter vs Matt Serra | Welterweight semi final | 10 | 2006-06-26 | Decision (unanimous) · R3 · — | "Serra won by unanimous decision" | none |
| Chris Lytle vs Din Thomas | Welterweight semi final | 9 | 2006-06-26 | Decision (unanimous) · R3 · — | "Lytle won by unanimous decision" | none |
| Charles McCarthy vs Pete Sell | Middleweight quarter final | 6 | 2006-06-13 | Decision (unanimous) · R3 · — | "Sell won by unanimous decision in the sudden victory round." | method [primary_normalization]: Decision (unanimous) → Decision (unanimous, sudden victory round) |
| Travis Lutter vs Scott Smith | Middleweight quarter final | 4 | 2006-06-06 | Submission (rear naked choke) · R1 · 1:13 | "Lutter won by tap out 1:15 of the 1st round – rear naked choke." | time [true_contradiction]: 1:13 → 1:15 |
| Jorge Rivera vs Patrick Côté | Middleweight quarter final | 8 | 2006-06-20 | Decision (unanimous) · R2 · — | "Cote won by unanimous decision." | none |
| Gideon Ray vs Edwin DeWees | Middleweight quarter final | 2 | 2006-05-30 | Decision (unanimous) · R3 · — | "DeWees won by unanimous decision in the sudden victory round." | method [primary_normalization]: Decision (unanimous) → Decision (unanimous, sudden victory round) |
| Pete Sell vs Travis Lutter | Middleweight semi final | 11 | 2006-06-27 | Decision (unanimous) · R3 · — | "Lutter won by unanimous decision." | none |
| Patrick Côté vs Edwin DeWees | Middleweight semi final | 12 | 2006-06-27 | Decision (unanimous) · R3 · — | "Cote won by unanimous decision." | none |

| Fighter | Printed DOB | Canonical | State |
|---|---|---|---|
| Rich Clementi (RICHARD THOMAS CLEMENTI) | 1976-03-31 | 1976-03-31 | agrees |
| Shonie Carter (MEARION BICKHEM aka SHONIE CARTER) | 1972-05-03 | 1972-05-03 | agrees |
| Pete Spratt (AARON PETE SPRATT) | 1971-01-09 | 1971-01-09 | agrees |
| Matt Serra (MATTHEW JOHN SERRA) | 1974-06-02 | 1974-06-02 | agrees |
| Chris Lytle (CHRIS SCOTT LYTLE) | 1974-08-18 | 1974-08-18 | agrees |
| Mikey Burnett (MICHAEL WAYNE BURNETT) | 1976-04-12 | 1974-04-12 | identity_disagreement |
| Din Thomas (DIN YERO THOMAS) | 1976-09-28 | 1976-09-28 | agrees |
| Charles McCarthy (CHARLES SIDNEY McCARTHY) | 1980-08-06 | 1980-08-06 | agrees |
| Pete Sell (PETER K. SELL) | 1982-08-25 | 1982-08-05 | identity_disagreement |
| Travis Lutter (TRAVIS S. LUTTER) | 1973-05-12 | 1973-05-12 | agrees |
| Scott Smith (BRYAN SCOTT SMITH) | 1979-05-21 | 1979-05-21 | agrees |
| Jorge Rivera (JORGE LUIS RIVERA) | 1972-02-28 | 1972-02-28 | agrees |
| Patrick Côté (PATRICK COTE) | 1980-02-29 | 1980-02-29 | agrees |
| Gideon Ray (GIDEON CHARLES RAY) | 1973-05-27 | 1973-05-27 | agrees |
| Edwin DeWees (EDWIN STANTON DeWEES) | 1982-08-07 | 1982-08-07 | agrees |

### Open conflicts

- **Welterweight_quarter_final** — partially informs. NSAC records Pete Spratt ("AARON PETE SPRATT") in two bouts headed "Welterweight Quarter Final": a loss to Lytle on 2006-06-02 and a loss to Serra on 2006-06-16. All 12 records account for all 12 house bouts; no other welterweight quarter-final bout is listed. Does not settle: That Spratt's second quarter-final was a replacement entry (the season source's format_exceptions: a coin toss let Spratt replace the evicted Jeremy Jackson). The record states no replacement. Keep open. The record confirms both bouts, their stage labels and order, but not the replacement.


## Matrix simulation (measured, not applied)

Evidence: `scripts/tuf/evidence/nsac_tuf3_tuf4_matrix_simulation_2026-09-13.json`.

| Season | | Status | Blockers | Results verified | Secondary-only | House commission-verified | Exhibitions commission-backed |
|---|---|---|---|---|---|---|---|
| tuf-3 | before | PARTIAL | OPEN_SOURCE_CONFLICT, HOUSE_RESULTS_SECONDARY_ONLY | 2/14 | 12 | 0 | 0 |
| tuf-3 | if applied | PARTIAL | OPEN_SOURCE_CONFLICT | 14/14 | 0 | 12 | 12 |
| tuf-4 | before | PARTIAL | ROSTER_MISSING, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY | 2/14 | 12 | 0 | 0 |
| tuf-4 | if applied | PARTIAL | ROSTER_MISSING, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER | 14/14 | 0 | 12 | 12 |

No other season changes; totals stay 1 complete / 43 partial. Both seasons stay PARTIAL: each keeps an open bracket conflict the record informs but does not settle, and TUF 4 also lacks rosters.

## Architecture

The TUF 1 / TUF 2 commission path represents everything here without new schema, with one decision before apply: TUF 3 record 05 prints its date as "02/0706", and the ledger has no field for a misprinted value (option a: one optional generic `date_printed`; option b: record the misprint only in the correction reason). The printed-name weight fallback applies to 6 corners (Abbadi, Carter x2, Spratt x2, Smith), fail-safe as designed.
