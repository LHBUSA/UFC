# TUF matrix — exact result verification, impact (2026-09-13)

Read-only. Evidence: `scripts/tuf/evidence/tuf_matrix_exact_verification_impact_2026-09-13.json` (`scripts/tuf/audit_matrix_exact_verification.mjs`).

**Old rule.** dbVerified = any ufc_bouts row between the two fighter ids with the archive winner, applied to every TUF bout (house or final); classificationRepairable and professional_final_linked used the same pair-level test.

**New rule.** House bouts: only commission record, official repair covering the winner, or official recap for the same pairing. Finale-card finals additionally: the exact finale row (ufc_bout_id, else the single bout between the ids on the recorded finale date and event). Classification repair and professional_final_linked use the exact row only.

False-positive database verifications under the old rule: **11** (9 house bouts, 2 finals). Results that change: **9**.

| Season | Stage | TUF pairing | TUF winner | Professional bout(s) the old rule used | Why it was not evidence | Result before → after |
|---|---|---|---|---|---|---|
| tuf-5 | semi_final | Nate Diaz vs Gray Maynard | Nate Diaz | `868820d3-f69d-4cfb-ac5d-0be1eb03c369` The Ultimate Fighter: Team Rousey vs. Team Tate Finale, 2013-11-30, winner Nate Diaz | a house exhibition; the professional bout(s) above are different fights between the same two people (2013-11-30), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-6 | round_of_16 | Dan Barrera vs Ben Saunders | Ben Saunders | `70a3ef04-253a-4d13-97f1-fd007e364574` The Ultimate Fighter: Team Hughes vs. Team Serra Finale, 2007-12-08, winner Ben Saunders | a house exhibition; the professional bout(s) above are different fights between the same two people (2007-12-08), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-7 | semi_final | Amir Sadollah vs C. B. Dollaway | Amir Sadollah | `21bdd837-d7cb-4c4b-8d0b-668a6cd4d4c4` The Ultimate Fighter: Team Rampage vs Team Forrest Finale, 2008-06-21, winner Amir Sadollah | a house exhibition; the professional bout(s) above are different fights between the same two people (2008-06-21), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-11 | round_of_16 | Court McGee vs Nick Ring | Nick Ring | `2db46009-af04-46df-babd-c41ef7d281fe` UFC 149: Faber vs Barao, 2012-07-21, winner Nick Ring | a house exhibition; the professional bout(s) above are different fights between the same two people (2012-07-21), and a professional result says nothing about who won the TUF house bout | still verified: its own evidence (official_recap) verifies it |
| tuf-11 | quarter_final | Brad Tavares vs Seth Baczynski | Brad Tavares | `9b703460-fe98-419c-87a5-218cc817c8ac` The Ultimate Fighter: Team Liddell vs Team Ortiz Finale, 2010-06-19, winner Brad Tavares | a house exhibition; the professional bout(s) above are different fights between the same two people (2010-06-19), and a professional result says nothing about who won the TUF house bout | still verified: its own evidence (official_recap) verifies it |
| tuf-24 | elimination | Alexandre Pantoja vs Kai Kara-France | Alexandre Pantoja | `ca2ac578-6ceb-42ed-a9e3-05975d9ffac7` UFC 317: Topuria vs. Oliveira, 2025-06-28, winner Alexandre Pantoja | a house exhibition; the professional bout(s) above are different fights between the same two people (2025-06-28), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-24 | round_of_16 | Alexandre Pantoja vs Brandon Moreno | Alexandre Pantoja | `e3f32807-87a7-4740-81ff-18dd9a127c85` UFC Fight Night: Maia vs. Usman, 2018-05-19, winner Alexandre Pantoja; `eefd181c-c3cc-47cf-a5c5-b137ccbcc9bf` UFC 290: Volkanovski vs. Rodriguez, 2023-07-08, winner Alexandre Pantoja | a house exhibition; the professional bout(s) above are different fights between the same two people (2018-05-19, 2023-07-08), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-24 | quarter_final | Alexandre Pantoja vs Kai Kara France | Alexandre Pantoja | `ca2ac578-6ceb-42ed-a9e3-05975d9ffac7` UFC 317: Topuria vs. Oliveira, 2025-06-28, winner Alexandre Pantoja | a house exhibition; the professional bout(s) above are different fights between the same two people (2025-06-28), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-26 | semi_final | Roxanne Modafferi vs Sijara Eubanks | Sijara Eubanks | `4992c0b7-366e-4858-bf0d-9bb7c19292ce` UFC 230: Cormier vs. Lewis, 2018-11-03, winner Sijara Eubanks | a house exhibition; the professional bout(s) above are different fights between the same two people (2018-11-03), and a professional result says nothing about who won the TUF house bout | verified -> partial |
| tuf-33 | final | Daniil Donchenko vs Rodrigo Sezinando | Daniil Donchenko | `94616427-2d11-4216-b248-bc57e3ab83e2` UFC Fight Night: Lopes vs. Silva, 2025-09-13, winner Daniil Donchenko | a finale-card final with no ufc_bout_id and no recorded finale date or event (no ufc_bout_id and no recorded finale date); the old rule accepted any bout between the pair, so the result row was never shown to be THIS final | verified -> partial |
| tuf-33 | final | Joseph Morales vs Alibi Idiris | Joseph Morales | `aa7c0491-43f3-4c90-a668-10ccbdc118ac` UFC 319: Du Plessis vs. Chimaev, 2025-08-16, winner Joseph Morales | a finale-card final with no ufc_bout_id and no recorded finale date or event (no ufc_bout_id and no recorded finale date); the old rule accepted any bout between the pair, so the result row was never shown to be THIS final | verified -> partial |

## Seasons

| Season | | Status | Score | Results verified | House secondary-only | Blockers |
|---|---|---|---|---|---|---|
| tuf-1 | before | PARTIAL | 90 | 12/12 | 0 | OPEN_SOURCE_CONFLICT |
| tuf-1 | after | PARTIAL | 90 | 12/12 | 0 | OPEN_SOURCE_CONFLICT |
| tuf-2 | before | COMPLETE | 89 | 14/14 | 0 | — |
| tuf-2 | after | COMPLETE | 89 | 14/14 | 0 | — |
| tuf-3 | before | PARTIAL | 88 | 14/14 | 0 | OPEN_SOURCE_CONFLICT |
| tuf-3 | after | PARTIAL | 88 | 14/14 | 0 | OPEN_SOURCE_CONFLICT |
| tuf-4 | before | PARTIAL | 90 | 14/14 | 0 | ROSTER_MISSING, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER |
| tuf-4 | after | PARTIAL | 90 | 14/14 | 0 | ROSTER_MISSING, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER |
| tuf-5 | before | PARTIAL | 71 | 2/15 | 13 | OPEN_SOURCE_CONFLICT, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-5 | after | PARTIAL | 70 | 1/15 | 14 | OPEN_SOURCE_CONFLICT, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-6 | before | PARTIAL | 70 | 2/15 | 13 | ROSTER_MISSING, CLASSIFICATION_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-6 | after | PARTIAL | 69 | 1/15 | 14 | ROSTER_MISSING, CLASSIFICATION_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-7 | before | PARTIAL | 66 | 2/31 | 29 | OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-7 | after | PARTIAL | 65 | 1/31 | 30 | OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-11 | before | PARTIAL | 91 | 27/29 | 2 | ROSTER_MISSING, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-11 | after | PARTIAL | 91 | 27/29 | 2 | ROSTER_MISSING, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-24 | before | PARTIAL | 67 | 3/17 | 13 | ROSTER_MISSING, FINAL_NOT_VERIFIED, PROFESSIONAL_FINAL_NOT_LINKED, CLASSIFICATION_UNRESOLVED, FINALIST_IDENTITY_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-24 | after | PARTIAL | 63 | 0/17 | 16 | ROSTER_MISSING, FINAL_NOT_VERIFIED, PROFESSIONAL_FINAL_NOT_LINKED, CLASSIFICATION_UNRESOLVED, FINALIST_IDENTITY_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-26 | before | PARTIAL | 71 | 2/16 | 14 | CLASSIFICATION_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-26 | after | PARTIAL | 70 | 1/16 | 15 | CLASSIFICATION_UNRESOLVED, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-33 | before | PARTIAL | 58 | 11/14 | 3 | SPELLING_SPLIT_IDENTITY, WINNER_UNRESOLVED, PROFESSIONAL_FINAL_NOT_LINKED, CLASSIFICATION_UNRESOLVED, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |
| tuf-33 | after | PARTIAL | 55 | 9/14 | 3 | SPELLING_SPLIT_IDENTITY, FINAL_NOT_VERIFIED, WINNER_UNRESOLVED, PROFESSIONAL_FINAL_NOT_LINKED, CLASSIFICATION_UNRESOLVED, OPEN_SOURCE_CONFLICT, BRACKET_NAME_NOT_IN_ROSTER, HOUSE_RESULTS_SECONDARY_ONLY |

Every other season unchanged: yes.

## Totals

| | Before | After |
|---|---|---|
| complete | 1 | 1 |
| partial | 43 | 43 |
| blocked | 0 | 0 |
| result verified | 206 | 197 |
| result partial | 547 | 556 |
| finals verified | 65 | 63 |
| finale links verified | 63 | 63 |
| structure complete | 44 | 44 |
| structure partial | 0 | 0 |
