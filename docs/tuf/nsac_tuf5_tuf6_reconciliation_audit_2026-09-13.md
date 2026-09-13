# TUF 5 + TUF 6 — Nevada State Athletic Commission reconciliation audit (2026-09-13)

Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/nsac_tuf5_tuf6_audit_2026-09-13.json` (`scripts/tuf/audit_nsac_tuf5_tuf6.mjs`). Matrix simulation: `scripts/tuf/evidence/nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json`.

## TUF-5

| Document | |
|---|---|
| URL | https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON5.pdf |
| Live | HTTP 200, application/pdf, 56215 bytes, Last-Modified Wed, 06 Feb 2013 18:18:43 GMT |
| Archive | https://web.archive.org/web/20161213143108/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON5.pdf (HTTP 200, 56215 bytes, raw capture) |
| sha256 (live = archive, byte-identical) | `d12c518bf3289183934696e4f8f4e1107a3142d1107f97c95852753fd2d623cb` |
| Pages | 3 (PDF created 2007-06-20) |
| Title | "MIXED MARTIAL ARTS RESULTS" |
| Classification wording | "Exhibition Results" — results column header, page 1; pages 2 and 3 continue the same table (page 2 headed "Results", page 3 under "SEMI-FINAL BOUT") — the applied TUF 2 pattern |
| Season identity | Printed in the document header: "SEASON 5– THE ULTIMATE FIGHTER™". Consistent with the file name TUFSEASON5.pdf (2007_Results), location "UFC Training Center, Las Vegas", show dates 2007-01-27..2007-02-28 and 14/14 pairings. |
| Location | UFC Training Center, Las Vegas |
| Remarks | The Remarks column carries only the "Referee:" line for all 14 bouts; no other remark. |

| Measure | Value |
|---|---|
| house bouts expected | 14 |
| house bouts in archive | 14 |
| records in document | 14 |
| matched | 14 |
| unmatched | 0 |
| ambiguous | 0 |
| duplicate use | [] |
| unused records | [] |
| match rules | {"weight_class":"document prints none; season bracket has 1 weight class (Lightweight)","unlabeled_records":8,"labeled_stages":["quarter_final","semi_final"]} |
| differences | {"winner":1,"winner_print_defects":0,"method":3,"round":0,"time_contradictions":8,"time_source_only":0} |
| method kinds | {"true_contradiction":[],"primary_normalization":["Corey Hill vs Rob Emerson"],"compatible_secondary_detail":["Gray Maynard vs Wayne Weems","Joe Lauzon vs Cole Miller"],"source_only_new_fact":[]} |
| method readings | ["Matt Wiman vs Marlon Sims: printed \"choke out\" → Technical submission (rear naked choke) (normalization_judgement)"] |
| print date defects | [] |
| fight dates | 14 |
| referees | 14 |
| scorecards | 2 |
| decisions | 4 |
| decisions without cards | ["nsac-2007-tuf5-05","nsac-2007-tuf5-13"] |
| weights | 28 |
| remarks | 0 |
| printed document notes | 0 |
| dob | {"agrees":12,"disagreements":[],"no_canonical_identity":["Noah Thomas: printed 1981-03-27","Wayne Weems: printed 1982-06-23","Marlon Sims: printed 1974-01-18"]} |
| name disagreements | ["Cole Miller: printed JEREMIAH COLE MILLER, canonical Cole Miller [printed_first_initial_differs (weights use the printed-name fallback)]","Manny Gamburyan: printed MANUEL GAMBURYAN, canonical Manvel Gamburyan [canonical_name_differs_from_archive]","Gray Maynard: printed BRADLEY GRAY MAYNARD, canonical Gray Maynard [printed_first_initial_differs (weights use the printed-name fallback)]"] |
| printed winner name defects | [] |
| classification wording | Exhibition Results |
| classification primary possible | true |
| fight dates follow episode order | true |
| open conflicts | ["quarter_finals: commission_resolves","early_rounds: partially_informs","final_method_and_opponent_name: does_not_touch","gamburyan_name: does_not_touch","final_method_wording: does_not_touch"] |
| structure | ["stage status \"unverified\" on elimination and quarter_final: partially_informs","Rob Emerson fights twice in the opening round (bout carries a \"replacement\" note): partially_informs","Gabe Ruediger on the Team Penn roster with no bout: does_not_touch","Corey Hill vs Rob Emerson recorded as a 3-round unanimous decision: commission_resolves","contestants without a canonical identity: Noah Thomas, Wayne Weems, Marlon Sims: does_not_touch"] |

| Bout | Stage | Ep | NSAC record · date | Canonical (winner · method · R · time) | Commission (printed) | Differences |
|---|---|---|---|---|---|---|
| Cole Miller vs Allen Berube | elimination | 1 | nsac-2007-tuf5-01 · 2007-01-27 | Cole Miller · Submission (triangle choke) · R1 · 2:33 | "Miller won by tap out 2:35 of the 1st round – triangle choke" | time [true_contradiction]: 2:33 → 2:35 |
| Manny Gamburyan vs Noah Thomas | elimination | 2 | nsac-2007-tuf5-02 · 2007-01-30 | Manny Gamburyan · Submission (kimura) · R1 · 2:09 | "Gamburyan won by tap out 2:10 of the 1st round – Kimura." | time [true_contradiction]: 2:09 → 2:10 |
| Nate Diaz vs Rob Emerson | elimination | 3 | nsac-2007-tuf5-03 · 2007-02-02 | Nate Diaz · Submission (rear naked choke) · R2 · 4:45 | "Diaz won by tap out 4:46 of the 2nd round – rear naked choke." | time [true_contradiction]: 4:45 → 4:46 |
| Brandon Melendez vs Andy Wang | elimination | 4 | nsac-2007-tuf5-04 · 2007-02-06 | Brandon Melendez · Decision (unanimous) · R2 · — | "Melendez won by unanimous decision." | none |
| Joe Lauzon vs Brian Geraghty | elimination | 6 | nsac-2007-tuf5-06 · 2007-02-12 | Joe Lauzon · Submission (rear naked choke) · R1 · 1:13 | "Lauzon won by tap out 1:13 of the 1st round – rear naked choke." | none |
| Corey Hill vs Rob Emerson | elimination | 6 | nsac-2007-tuf5-05 · 2007-02-12 | Corey Hill · Decision (unanimous) · R3 · — | "Hill won by unanimous decision in the sudden victory round." | method [primary_normalization]: Decision (unanimous) → Decision (unanimous, sudden victory round) |
| Gray Maynard vs Wayne Weems | elimination | 7 | nsac-2007-tuf5-07 · 2007-02-15 | Gray Maynard · TKO (punches) · R1 · 2:47 | "Maynard won by TKO 2:48 of the 1st round." | method [compatible_secondary_detail]: TKO (punches) → TKO; time [true_contradiction]: 2:47 → 2:48 |
| Matt Wiman vs Marlon Sims | elimination | 7 | nsac-2007-tuf5-08 · 2007-02-15 | Matt Wiman · Technical submission (rear naked choke) · R1 · 0:52 | "Wiman won by choke out 0:50 of the 1st round. – rear naked choke." | method_reading [normalization_judgement]: Technical submission (rear naked choke) → Technical submission (rear naked choke); time [true_contradiction]: 0:52 → 0:50 |
| Joe Lauzon vs Cole Miller | quarter final | 8 | nsac-2007-tuf5-10 · 2007-02-21 | Joe Lauzon · TKO (strikes) · R2 · 3:58 | "Lauzon won by TKO 3:59 of the 2nd round." | method [compatible_secondary_detail]: TKO (strikes) → TKO; time [true_contradiction]: 3:58 → 3:59 |
| Brandon Melendez vs Gray Maynard | quarter final | 9 | nsac-2007-tuf5-09 · 2007-02-21 | Brandon Melendez · Submission (guillotine choke) · R2 · 4:07 | "Maynard won by tap out 4:07 of the 2nd round – guillotine choke" | winner [true_contradiction]: Brandon Melendez → Gray Maynard |
| Nate Diaz vs Corey Hill | quarter final | 10 | nsac-2007-tuf5-11 · 2007-02-22 | Nate Diaz · Submission (triangle choke) · R1 · 3:02 | "Diaz won by tap out 3:03 of the 1st round – triangle choke." | time [true_contradiction]: 3:02 → 3:03 |
| Manny Gamburyan vs Matt Wiman | quarter final | 10 | nsac-2007-tuf5-12 · 2007-02-22 | Manny Gamburyan · Decision (unanimous) · R2 · — | "Gamburyan won by unanimous decision." | none |
| Manny Gamburyan vs Joe Lauzon | semi final | 11 | nsac-2007-tuf5-13 · 2007-02-28 | Manny Gamburyan · Decision (unanimous) · R3 · — | "Gamburyan won by unanimous decision." | none |
| Nate Diaz vs Gray Maynard | semi final | 12 | nsac-2007-tuf5-14 · 2007-02-28 | Nate Diaz · Submission (guillotine choke) · R2 · 1:17 | "Diaz won by tap out 1:20 of the 2nd round – Guillotine choke" | time [true_contradiction]: 1:17 → 1:20 |

| Fighter | Printed name | Printed DOB | Canonical DOB | State |
|---|---|---|---|---|
| Cole Miller | JEREMIAH COLE MILLER | 1984-04-26 | 1984-04-26 | agrees |
| Allen Berube | ALLEN M. BERUBE | 1974-08-25 | 1974-08-25 | agrees |
| Manny Gamburyan | MANUEL GAMBURYAN | 1981-05-08 | 1981-05-08 | agrees |
| Noah Thomas | NOAH MARTIN THOMAS | 1981-03-27 | — | no_canonical_identity |
| Nate Diaz | NATHAN DONALD DIAZ | 1985-04-16 | 1985-04-16 | agrees |
| Rob Emerson | ROBERT MICHAEL EMERSON | 1981-07-30 | 1981-07-30 | agrees |
| Brandon Melendez | BRANDON LOUIS MELENDEZ | 1983-03-24 | 1983-03-24 | agrees |
| Andy Wang | ANDREW P. WANG | 1977-05-28 | 1977-05-28 | agrees |
| Joe Lauzon | JOSEPH E. LAUZON, JR. | 1984-05-22 | 1984-05-22 | agrees |
| Brian Geraghty | BRIAN JOSEPH GERAGHTY | 1980-11-04 | 1980-11-04 | agrees |
| Corey Hill | COREY CORNELIUS HILL | 1978-10-03 | 1978-10-03 | agrees |
| Gray Maynard | BRADLEY GRAY MAYNARD | 1979-05-09 | 1979-05-09 | agrees |
| Wayne Weems | WAYNE LEROY WEEMS | 1982-06-23 | — | no_canonical_identity |
| Matt Wiman | MATTHEW CHARLES WIMAN | 1983-09-19 | 1983-09-19 | agrees |
| Marlon Sims | MARLON SIMS | 1974-01-18 | — | no_canonical_identity |

### Open conflicts

- **quarter_finals** — commission resolves. nsac-2007-tuf5-09 (2007-02-21, "Quarter Finals"): "Maynard won by tap out 4:07 of the 2nd round – guillotine choke" — Gray Maynard beat Brandon Melendez. nsac-2007-tuf5-14 (2007-02-28, "SEMI-FINAL BOUT"): Maynard then lost to Diaz. The archive's quarter-final winner (Melendez) is contradicted by the primary record: Maynard won the quarter-final, which is why he appears in the semi-final. Method, round and time agree (guillotine choke, R2, 4:07); only the winner was inverted. On approval: winner corrected to Gray Maynard as a commission_correction, and the conflict can close with the commission record as its resolution. Not applied in this audit.
- **early_rounds** — partially informs. The record lists eight bouts 2007-01-27..2007-02-15 with no stage label, each scheduled for 2 rounds, before four bouts headed "Quarter Finals" (2007-02-21/22) and two headed "SEMI-FINAL BOUT" (2007-02-28). The eight winners (Miller, Gamburyan, Diaz, Melendez, Hill, Lauzon, Maynard, Wiman) are exactly the eight quarter-finalists.  Does not settle: The record prints no name for the opening stage, and states nothing about the source's "Round 2/3/4" numbering or Rob Emerson's reinstatement (it only records that Emerson fought twice). Keep open unless the owner accepts the record's shape as enough to name the stage; the stage label stays as is.
- **final_method_and_opponent_name** — does not touch.   The final was on the professional finale card and is not in the house-bout record. The record prints Gamburyan as "MANUEL GAMBURYAN" — a third rendering, recorded as a name disagreement only.
- **gamburyan_name** — does not touch.   The record prints "MANUEL GAMBURYAN" (the archive has Manny, ufc_fighters has Manvel). A commission printed legal-name rendering does not decide the archive's display spelling; recorded as a name disagreement, no alias or identity write.
- **final_method_wording** — does not touch.   Finale-card bout; not in the house-bout record.

### Structure and format exceptions

- **stage status "unverified" on elimination and quarter_final** — partially informs. The record confirms all 12 bouts in those stages (8 unlabeled + 4 "Quarter Finals") and resolves the quarter-final inversion; stage statuses are not changed by this audit.
- **Rob Emerson fights twice in the opening round (bout carries a "replacement" note)** — partially informs. The record lists both bouts (nsac-2007-tuf5-03 vs Diaz 2007-02-02, nsac-2007-tuf5-05 vs Hill 2007-02-12). It states no reinstatement or replacement; the replacement note stays sourced to the draft.
- **Gabe Ruediger on the Team Penn roster with no bout** — does not touch. No Ruediger bout is in the record, which is consistent with the roster note (expelled for missing weight) but states nothing about it.
- **Corey Hill vs Rob Emerson recorded as a 3-round unanimous decision** — commission resolves. nsac-2007-tuf5-05: "Hill won by unanimous decision in the sudden victory round." Rds "2 + Sudden Victory" — the TUF 4 sudden-victory shape (round 3, scheduled_rounds 2).
- **contestants without a canonical identity: Noah Thomas, Wayne Weems, Marlon Sims** — does not touch. Printed legal names and DOBs are reported for review; no identity write.

## TUF-6

| Document | |
|---|---|
| URL | https://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON6.pdf |
| Live | HTTP 200, application/pdf, 58230 bytes, Last-Modified Wed, 06 Feb 2013 18:18:59 GMT |
| Archive | https://web.archive.org/web/20161213143128/http://boxing.nv.gov/uploadedFiles/boxingnvgov/content/results/2007_Results/TUFSEASON6.pdf (HTTP 200, 58230 bytes, raw capture) |
| sha256 (live = archive, byte-identical) | `bb8e779598068219395c4132f4878df9fce16fb3b499e1b9cbff8835da6deecd` |
| Pages | 3 (PDF created 2007-12-14) |
| Title | "MIXED MARTIAL ARTS RESULTS" |
| Classification wording | "Exhibition Results" — results column header, page 1; pages 2 and 3 continue the same table (page 2 headed "Results", page 3 under "SEMI-FINAL BOUT") — the applied TUF 2 pattern |
| Season identity | Printed in the document header: "SEASON 6 – THE ULTIMATE FIGHTER™". Consistent with the file name TUFSEASON6.pdf (2007_Results), location "UFC Training Center, Las Vegas", show dates 2007-06-11..2007-07-15 and 14/14 pairings. |
| Location | UFC Training Center, Las Vegas |
| Remarks | The Remarks column carries the "Referee:" line for all 14 bouts; one bout (Speer vs Sotiropoulos, semi-final) also carries a suspension remark. |
| Printed note | page 3, bold line above the semi-final table, outside any record row: "MATT ARROYO – Injured and could not compete in Semi-Finals. John Kolosci replaced him." |

| Measure | Value |
|---|---|
| house bouts expected | 14 |
| house bouts in archive | 14 |
| records in document | 14 |
| matched | 14 |
| unmatched | 0 |
| ambiguous | 0 |
| duplicate use | [] |
| unused records | [] |
| match rules | {"weight_class":"document prints none; season bracket has 1 weight class (Tournament)","unlabeled_records":8,"labeled_stages":["quarter_final","semi_final"]} |
| differences | {"winner":0,"winner_print_defects":1,"method":7,"round":0,"time_contradictions":9,"time_source_only":1} |
| method kinds | {"true_contradiction":["Paul Georgieff vs Troy Mandaloniz","Tom Speer vs Ben Saunders","Tom Speer vs George Sotiropoulos"],"primary_normalization":["Tom Speer vs Jon Koppenhaver","Matt Arroyo vs Troy Mandaloniz"],"compatible_secondary_detail":["Blake Bowman vs Richie Hightower","Jared Rollins vs George Sotiropoulos"],"source_only_new_fact":[]} |
| method readings | ["Matt Arroyo vs Troy Mandaloniz: printed \"verbal tap out … – arm bar\" → Submission (armbar) (normalization_judgement)","Richie Hightower vs George Sotiropoulos: printed \"kumara\" → Submission (kimura) (print_date_defect)"] |
| print date defects | ["Mac Danzig vs Joe Scarola: date_printed printed \"0611/07\"","Jared Rollins vs George Sotiropoulos: winner_printed_name printed \"Sotriopoulos\"","Richie Hightower vs George Sotiropoulos: method_reading printed \"kumara\""] |
| fight dates | 14 |
| referees | 14 |
| scorecards | 3 |
| decisions | 3 |
| decisions without cards | [] |
| weights | 28 |
| remarks | 2 |
| printed document notes | 1 |
| dob | {"agrees":12,"disagreements":["Richie Hightower: printed 1981-11-24, canonical 1974-11-26"],"no_canonical_identity":["Joe Scarola: printed 1979-03-12","Blake Bowman: printed 1981-06-20","Jon Koppenhaver: printed 1981-11-30"]} |
| name disagreements | ["Billy Miles: printed WILLIAM SCOT MILES, canonical Billy Miles [printed_first_initial_differs (weights use the printed-name fallback)]","Tom Speer: printed THOMAS CHARLES SPEER, canonical Tommy Speer [canonical_name_differs_from_archive]"] |
| printed winner name defects | ["George Sotiropoulos: result line prints \"Sotriopoulos\" (Jared Rollins vs George Sotiropoulos)"] |
| classification wording | Exhibition Results |
| classification primary possible | true |
| fight dates follow episode order | true |
| open conflicts | [] |
| structure | ["format_exceptions: Kolosci replaces the injured Arroyo in the semi-finals (episode 6): commission_resolves","format_exceptions: Jon Koppenhaver replaces Mitichyan (episode 1): does_not_touch","quarter-final Mac Danzig vs John Kolosci carries the semi-final's values: commission_resolves","quarter-final Matt Arroyo vs Troy Mandaloniz: classification unverified, no time, no episode: partially_informs","weight class labelled \"Tournament\": does_not_touch","ROSTER_MISSING (no teams loaded): does_not_touch","contestants without a canonical identity: Joe Scarola, Blake Bowman, Jon Koppenhaver: does_not_touch","nine title-only episode shells; many house bouts placed in episode 6: does_not_touch"] |

| Bout | Stage | Ep | NSAC record · date | Canonical (winner · method · R · time) | Commission (printed) | Differences |
|---|---|---|---|---|---|---|
| Mac Danzig vs Joe Scarola | round of_16 | 1 | nsac-2007-tuf6-01 · 2007-06-11 | Mac Danzig · Submission (triangle choke) · R1 · 4:54 | "Danzig won by tap out 4:55 of the 1st round – triangle choke." | time [true_contradiction]: 4:54 → 4:55; date_printed [print_date_defect]: null → 2007-06-11 |
| Billy Miles vs John Kolosci | round of_16 | 3 | nsac-2007-tuf6-03 · 2007-06-18 | John Kolosci · Submission (guillotine choke) · R1 · 2:56 | "Kolosci won by tap out 2:58 of the 1st round – guillotine choke." | time [true_contradiction]: 2:56 → 2:58 |
| Dorian Price vs Matt Arroyo | round of_16 | 1 | nsac-2007-tuf6-02 · 2007-06-14 | Matt Arroyo · Submission (rear naked choke) · R1 · 1:48 | "Arroyo won by tap out 1:48 of the 1st round – rear naked choke." | none |
| Paul Georgieff vs Troy Mandaloniz | round of_16 | 3 | nsac-2007-tuf6-05 · 2007-06-26 | Troy Mandaloniz · KO (punch) · R1 · 2:39 | "Mandaloniz won by TKO 2:40 of the 1st round." | method [true_contradiction]: KO (punch) → TKO; time [true_contradiction]: 2:39 → 2:40 |
| Blake Bowman vs Richie Hightower | round of_16 | 3 | nsac-2007-tuf6-04 · 2007-06-21 | Richie Hightower · TKO (strikes) · R1 · 0:49 | "Hightower won by TKO 0:50 of the 1st round." | method [compatible_secondary_detail]: TKO (strikes) → TKO; time [true_contradiction]: 0:49 → 0:50 |
| Jared Rollins vs George Sotiropoulos | round of_16 | 6 | nsac-2007-tuf6-07 · 2007-06-29 | George Sotiropoulos · TKO (strikes) · R1 · 3:48 | "Sotriopoulos won by TKO 3:50 of the 1st round." | winner_printed_name [print_date_defect]: George Sotiropoulos → Sotriopoulos; method [compatible_secondary_detail]: TKO (strikes) → TKO; time [true_contradiction]: 3:48 → 3:50 |
| Tom Speer vs Jon Koppenhaver | round of_16 | 6 | nsac-2007-tuf6-08 · 2007-06-29 | Tom Speer · Decision · R2 · — | "Speer won by unanimous decision" | method [primary_normalization]: Decision → Decision (unanimous) |
| Dan Barrera vs Ben Saunders | round of_16 | 6 | nsac-2007-tuf6-06 · 2007-06-26 | Ben Saunders · Decision (majority) · R2 · — | "Saunders won by majority decision." | none |
| Mac Danzig vs John Kolosci | quarter final | 6 | nsac-2007-tuf6-09 · 2007-07-03 | Mac Danzig · Submission (rear naked choke) · R1 · 4:28 | "Danzig won by tap out 3:57 of the 1st round – rear naked choke." | time [true_contradiction]: 4:28 → 3:57 |
| Matt Arroyo vs Troy Mandaloniz | quarter final | — | nsac-2007-tuf6-10 · 2007-07-05 | Matt Arroyo · Submission · R1 · — | "Arroyo won by verbal tap out 1:07 of the 1st round – arm bar." | method [primary_normalization]: Submission → Submission (armbar); method_reading [normalization_judgement]: Submission → Submission (armbar); time [source_only_new_fact]: null → 1:07 |
| Richie Hightower vs George Sotiropoulos | quarter final | 6 | nsac-2007-tuf6-11 · 2007-07-05 | George Sotiropoulos · Submission (kimura) · R1 · 4:07 | "Sotiropoulos won by tap out 4:10 of the 1st round – kumara." | method_reading [print_date_defect]: Submission (kimura) → Submission (kimura); time [true_contradiction]: 4:07 → 4:10 |
| Tom Speer vs Ben Saunders | quarter final | 6 | nsac-2007-tuf6-12 · 2007-07-09 | Tom Speer · Decision (unanimous) · R2 · — | "Speer won by majority decision." | method [true_contradiction]: Decision (unanimous) → Decision (majority) |
| Mac Danzig vs John Kolosci | semi final | 6 | nsac-2007-tuf6-13 · 2007-07-15 | Mac Danzig · Submission (rear naked choke) · R1 · 4:28 | "Danzig won by tap out 4:29 of the 1st round – rear naked choke." | time [true_contradiction]: 4:28 → 4:29 |
| Tom Speer vs George Sotiropoulos | semi final | 6 | nsac-2007-tuf6-14 · 2007-07-15 | Tom Speer · KO (strikes) · R1 · 2:57 | "Speer won by TKO 2:59 of the 1st round." | method [true_contradiction]: KO (strikes) → TKO; time [true_contradiction]: 2:57 → 2:59; remarks [source_only_new_fact]: null → [{"fighter":"George Sotiropoulos","quote":"Suspend Sotiropoulos until 09/14/07"},{"fighter":"George Sotiropoulos","quote":"No contact until 08/30/07"}] |

| Fighter | Printed name | Printed DOB | Canonical DOB | State |
|---|---|---|---|---|
| Mac Danzig | MAC DANZIG | 1980-01-02 | 1980-01-02 | agrees |
| Joe Scarola | JOSEPH WILLIAM SCAROLA | 1979-03-12 | — | no_canonical_identity |
| Billy Miles | WILLIAM SCOT MILES | 1978-04-28 | 1978-04-28 | agrees |
| John Kolosci | JOHN MICHAEL KOLOSCI | 1974-11-26 | 1974-11-26 | agrees |
| Dorian Price | DORIAN PRICE | 1977-08-20 | 1977-08-20 | agrees |
| Matt Arroyo | MATTHEW VINCENT ARROYO | 1982-09-01 | 1982-09-01 | agrees |
| Paul Georgieff | PAUL KARA GEORGIEFF | 1982-09-22 | 1982-09-22 | agrees |
| Troy Mandaloniz | TROY HISASHI MANDALONIZ | 1980-02-01 | 1980-02-01 | agrees |
| Blake Bowman | BLAKE R. BOWMAN | 1981-06-20 | — | no_canonical_identity |
| Richie Hightower | RICHIE JAMES HIGHTOWER | 1981-11-24 | 1974-11-26 | identity_disagreement |
| Jared Rollins | JARED MICHAEL ROLLINS | 1977-01-26 | 1977-01-26 | agrees |
| George Sotiropoulos | GEORGE SOTIROPOULOS | 1977-07-09 | 1977-07-09 | agrees |
| Tom Speer | THOMAS CHARLES SPEER | 1984-08-20 | 1984-08-20 | agrees |
| Jon Koppenhaver | JONATHON PAUL KOPPENHAVER | 1981-11-30 | — | no_canonical_identity |
| Dan Barrera | DANIEL L. BARRERA | 1980-12-23 | 1980-12-23 | agrees |
| Ben Saunders | BENJAMIN SAUNDERS | 1983-04-13 | 1983-04-13 | agrees |

### Open conflicts

- none recorded in `_conflicts`

### Structure and format exceptions

- **format_exceptions: Kolosci replaces the injured Arroyo in the semi-finals (episode 6)** — commission resolves. The document prints, above its semi-final table (page 3): "MATT ARROYO – Injured and could not compete in Semi-Finals. John Kolosci replaced him." The replacement and its cause are stated by the primary record. Episode placement (6) is not stated and is not settled.
- **format_exceptions: Jon Koppenhaver replaces Mitichyan (episode 1)** — does not touch. The record lists only Koppenhaver's bout (nsac-2007-tuf6-08, lost to Speer 2007-06-29). No Mitichyan, no replacement stated.
- **quarter-final Mac Danzig vs John Kolosci carries the semi-final's values** — commission resolves. The archive QF and SF rows are identical (Submission (rear naked choke), R1, 4:28, episode 6). The record has two distinct bouts: QF nsac-2007-tuf6-09 2007-07-03 at 3:57 (referee John McCarthy) and SF nsac-2007-tuf6-13 2007-07-15 at 4:29 (referee Steve Mazzagatti). Result values resolve; the QF episode placement does not.
- **quarter-final Matt Arroyo vs Troy Mandaloniz: classification unverified, no time, no episode** — partially informs. nsac-2007-tuf6-10: "Arroyo won by verbal tap out 1:07 of the 1st round – arm bar." under "Exhibition Results" — resolves classification, method detail and time (1:07). Episode stays unplaced.
- **weight class labelled "Tournament"** — does not touch. The record prints no weight class; its weights (168–171 lb) are consistent with welterweight but a weight class is not inferred from weights.
- **ROSTER_MISSING (no teams loaded)** — does not touch. The record lists the 16 contestants who fought, with legal names and DOBs, but no teams or coaches.
- **contestants without a canonical identity: Joe Scarola, Blake Bowman, Jon Koppenhaver** — does not touch. Printed legal names and DOBs are reported for review; no identity write.
- **nine title-only episode shells; many house bouts placed in episode 6** — does not touch. Fight dates are new facts; they are not used to move or place episodes.

## Architecture check

Existing commission architecture sufficient: **YES**. No schema change proposed.

- document + 28 records in web/data/tuf/commission_records.json (CommissionDocument / CommissionRecord as typed in web/lib/tuf.ts)
- stage_label null for the 16 unlabeled opening-round records (the applied TUF 2 shape)
- result_sources / classification_basis / fight_date / fight_date_source / commission_record_id on bouts; superseded_result_sources for the draft
- corrections (commission_correction, method_normalization) and method_detail for compatible detail (TUF 5: punches, strikes; TUF 6: strikes x2)
- a winner correction is a FieldCorrection with field "winner" (the type is generic); no season has needed one before, and the TUF 3/4 apply script refuses one by design
- sudden-victory decision (TUF 5 Hill vs Emerson): the TUF 4 shape — method "Decision (unanimous, sudden victory round)", round 3, scheduled_rounds 2
- date_printed for TUF 6 "0611/07" (the generic field added for TUF 3)
- remarks [{fighter, quote}] for the TUF 6 suspension (the TUF 2 shape)
- the TUF 6 page-3 replacement note as timeline_events (injury / withdrawal / replacement with replaces) citing the commission document and the semi-final record it heads — the TUF 2 medical_clearance pattern
- identity_disagreements on the document for the one DOB difference (Hightower); name renderings stay in corners.printed
- commissionWeights: printed-name fallback for corners whose printed first initial differs (Cole Miller x2, Gray Maynard x3, Billy Miles), fail-safe as designed

## Decisions an apply would need

- TUF 5 Brandon Melendez vs Gray Maynard (quarter-final): the commission winner is Gray Maynard; the archive has Melendez. First winner correction in the TUF archive — approve a winner commission_correction and closing the quarter_finals conflict with the record as its resolution.
- TUF 5 Matt Wiman vs Marlon Sims: printed "choke out" read as Technical submission (rear naked choke) (equals the archive). Confirm the reading.
- TUF 6 Matt Arroyo vs Troy Mandaloniz: printed "verbal tap out … – arm bar" read as Submission (armbar); "verbal" kept only in result_text. Confirm.
- TUF 6 method contradictions: Georgieff vs Mandaloniz KO (punch) → TKO; Speer vs Sotiropoulos KO (strikes) → TKO; Speer vs Saunders Decision (unanimous) → Decision (majority). Under the TUF 3 rule the category is corrected; decide whether "punch" / "strikes" survive as method_detail.
- TUF 6 quarter-final Mac Danzig vs John Kolosci: the archive row duplicates the semi-final (4:28); the record gives 3:57 on 2007-07-03. Correct the values; episode placement is not settled by the record.
- TUF 6 "0611/07" → 2007-06-11 with date_printed; "Sotriopoulos" → George Sotiropoulos via the print-defect fallback; "kumara" → kimura. Confirm the three readings.
- TUF 6 page-3 note: carry as commission-sourced timeline events (Arroyo injury/withdrawal, Kolosci replacement) with episode null, or leave for a later timeline batch.
- Recorded only, no write: Richie Hightower printed DOB 1981-11-24 vs canonical 1974-11-26 (the canonical value equals John Kolosci's DOB exactly — worth a separate identity review).

## Generic matrix observation (reported, not changed)

scripts/tuf/completeness_matrix.mjs counts a house (exhibition) bout as verified when a LATER professional bout between the same two fighter ids has the same winner (TUF 5 Diaz vs Maynard via 2013; TUF 6 Barrera vs Saunders via the 2007 finale; 9 house bouts across TUF 5, 6, 7, 11, 24, 26; none in TUF 1-4). Reported only; no matrix rule changed. See nsac_tuf5_tuf6_matrix_simulation_2026-09-13.json.

## Matrix simulation (temporary copy, read-only selects)

| Season | | Status | Blockers | Results verified | Secondary-only | Commission-backed exhibitions | Classification unresolved |
|---|---|---|---|---|---|---|---|
| tuf-5 | before | PARTIAL | OPEN_SOURCE_CONFLICT, HOUSE_RESULTS_SECONDARY_ONLY | 2/15 | 13 | 0/14 | 0 |
| tuf-5 | if applied | PARTIAL | OPEN_SOURCE_CONFLICT | 15/15 | 0 | 14/14 | 0 |
| tuf-6 | before | PARTIAL | ROSTER_MISSING, CLASSIFICATION_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY | 2/15 | 13 | 0/13 | 1 |
| tuf-6 | if applied | PARTIAL | ROSTER_MISSING, BRACKET_NAME_NOT_IN_ROSTER | 15/15 | 0 | 14/14 | 0 |

Only tuf-5 and tuf-6 change; totals stay {"complete":1,"partial":43,"blocked":0}.

