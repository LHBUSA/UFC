# TUF 33 — exact finals linkage audit (2026-09-13)

Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/tuf33_finals_linkage_audit_2026-09-13.json`; proposal (held): `scripts/tuf/evidence/tuf33_finale_link_proposal_2026-09-13.json`.

## Summary

| Measure | Value |
|---|---|
| total finals | 2 |
| verified now | 0 |
| unverified now | 2 |
| with exact candidate bout | 2 |
| blocked by identity | 0 |
| blocked by missing event or date | 2 |
| genuinely ambiguous | 1 |
| event not proven exactly | 1 |
| clean exact links | 0 |
| final not verified removable now | false |

## Welterweight: Daniil Donchenko vs Rodrigo Sezinando

| Field | Value |
|---|---|
| Recorded winner | Daniil Donchenko |
| verified_against / ufc_bout_id | — / — |
| Recorded finale event / date | — / — |
| Inventory finalists | Daniil Donchenko vs Matt Dixon |
| Fighter ids | Daniil Donchenko 45866b70-3f63-4996-8ec4-416e40b4c6b6 (Daniil Donchenko); Rodrigo Sezinando 6e2660b2-6505-4a25-bd1a-17356aec23cf (Rodrigo Sezinando) |
| Identities resolved | true |
| Verifier today | partial; refusal: no explicit bout link and no recorded finale date or event |
| Candidate bouts | `94616427-2d11-4216-b248-bc57e3ab83e2` UFC Fight Night: Lopes vs. Silva 2025-09-13, winner 45866b70-3f63-4996-8ec4-416e40b4c6b6, KO_TKO R1 267s, is_title false |
| Verdict | **HOLD_EVENT_NOT_PROVEN_EXACTLY** (high on bout identity; event not proven exactly) |

| Check | Pass | Detail |
|---|---|---|
| 1_finalist_ids_map_to_bout | yes | ufc_bouts 94616427-2d11-4216-b248-bc57e3ab83e2 is between 45866b70-3f63-4996-8ec4-416e40b4c6b6 and 6e2660b2-6505-4a25-bd1a-17356aec23cf |
| 2_on_the_actual_tuf33_finale_event | NO | NOT PROVEN EXACTLY. No finale event is recorded for TUF 33 and no first-party page labels this bout a TUF 33 final. Corroboration only: the broadcaster's season listing names "TUF 33 Finale: Lopes vs. Silva", whose headline equals the headline of the canonical event "UFC Fight Night: Lopes vs. Silva" (the only "Lopes vs. Silva" event in ufc_events) — a headline correspondence, not an exact event-name match. |
| 3_canonical_date_matches_recorded_date | NO | no finale date is recorded for TUF 33 (the broadcaster listing date 2026-05-25 is documented as wrong); the canonical date 2025-09-13 has nothing exact to match |
| 4_recorded_winner_matches_result | yes | archive winner Daniil Donchenko (45866b70-3f63-4996-8ec4-416e40b4c6b6); canonical winner_id 45866b70-3f63-4996-8ec4-416e40b4c6b6. The archive winner itself is draft-sourced: the inventory records winners [] and an open "winners" conflict |
| 5_no_other_bout_between_the_pair | yes | 1 ufc_bouts row(s) between the two ids, ever |
| 6_professional_card_bout_not_house | yes | UFC Fight Night: Lopes vs. Silva, prelim bout 1, status complete; a UFC card, not a TUF house bout |
| 7_not_a_later_rematch | yes | the only meeting of the two finalists in the canonical database, so no earlier or later bout between them exists to confuse it with |

**Danger / ambiguity flags**

- final classification is "unverified"; a link would make it CLASSIFICATION_REPAIRABLE, not repaired
- inventory winners [] with an open "winners" conflict; the archive winner is draft-sourced
- inventory finalists list Daniil Donchenko vs Matt Dixon; the bracket final and the official episode 12 recap say Daniil Donchenko vs Rodrigo Sezinando
- event evidence is a broadcaster listing headline, not an exact event record

## Flyweight: Joseph Morales vs Alibi Idiris

| Field | Value |
|---|---|
| Recorded winner | Joseph Morales |
| verified_against / ufc_bout_id | — / — |
| Recorded finale event / date | — / — |
| Inventory finalists | Joseph Morales vs Alibi Idiris |
| Fighter ids | Joseph Morales 5be77aa0-2a5b-4a31-90b8-5f5b7513e0e7 (Joseph Morales); Alibi Idiris 3b0f9220-12df-43e3-89cb-55f4489d6d8b (Alibi Idiris) |
| Identities resolved | true |
| Verifier today | partial; refusal: no explicit bout link and no recorded finale date or event |
| Candidate bouts | `aa7c0491-43f3-4c90-a668-10ccbdc118ac` UFC 319: Du Plessis vs. Chimaev 2025-08-16, winner 5be77aa0-2a5b-4a31-90b8-5f5b7513e0e7, SUB R2 184s, is_title true |
| Verdict | **HOLD_AMBIGUOUS_EVENT** (bout identity unique; finale event contradicted) |

| Check | Pass | Detail |
|---|---|---|
| 1_finalist_ids_map_to_bout | yes | ufc_bouts aa7c0491-43f3-4c90-a668-10ccbdc118ac is between 5be77aa0-2a5b-4a31-90b8-5f5b7513e0e7 and 3b0f9220-12df-43e3-89cb-55f4489d6d8b |
| 2_on_the_actual_tuf33_finale_event | NO | CONTRADICTED. The candidate is on "UFC 319: Du Plessis vs. Chimaev" (2025-08-16). The official recap puts this final in "the live finale", and the only finale the broadcaster names is "TUF 33 Finale: Lopes vs. Silva" — a different card. No first-party page labels this bout a TUF 33 final (UFC.com: "Flyweight Bout"); ESPN types it "Flyweight Title", which is not a TUF label. |
| 3_canonical_date_matches_recorded_date | NO | no finale date is recorded for TUF 33 (the broadcaster listing date 2026-05-25 is documented as wrong); the canonical date 2025-08-16 has nothing exact to match |
| 4_recorded_winner_matches_result | yes | archive winner Joseph Morales (5be77aa0-2a5b-4a31-90b8-5f5b7513e0e7); canonical winner_id 5be77aa0-2a5b-4a31-90b8-5f5b7513e0e7. The archive winner itself is draft-sourced: the inventory records winners [] and an open "winners" conflict |
| 5_no_other_bout_between_the_pair | yes | 1 ufc_bouts row(s) between the two ids, ever |
| 6_professional_card_bout_not_house | yes | UFC 319: Du Plessis vs. Chimaev, early bout 1, status complete; a UFC card, not a TUF house bout |
| 7_not_a_later_rematch | yes | the only meeting of the two finalists in the canonical database, so no earlier or later bout between them exists to confuse it with |

**Danger / ambiguity flags**

- final classification is "unverified"; a link would make it CLASSIFICATION_REPAIRABLE, not repaired
- inventory winners [] with an open "winners" conflict; the archive winner is draft-sourced
- the candidate card differs from the only finale card any source names

## Separate recommendations

- DATA (not identity): seasons.json tuf-33 finalists list the welterweight pair as Daniil Donchenko vs Matt Dixon (Wikipedia). Donchenko beat Dixon in the semi-final (episode 12 recap); the official recap names the finale pairing Sezinando vs Donchenko, which is the bracket final. Correct the inventory finalists in their own reviewed batch before or with any finale linkage.
- EVIDENCE: neither final can be linked exactly without a first-party record of where each TUF 33 final was fought (a UFC.com results article or event page that labels the bout as the TUF 33 final, or an athletic commission result). The broadcaster listing names only one finale card ("Lopes vs. Silva"); the flyweight candidate is on UFC 319 a month earlier.
- WINNERS: TUF 33 winners stay unresolved (open inventory "winners" conflict) independently of linkage; WINNER_UNRESOLVED does not clear by linking a bout.
- DISPLAY (observation, not changed): web/lib/tufGraph.ts marks a TUF 33 final by title flag + year when no finale date is on file; it uses the inventory finalists, so it can mark the flyweight bout but not the welterweight one.

Identity: No identity blocker: all four bracket finalists resolve to canonical fighters with ufcstats and ESPN ids. No identity change is proposed.

