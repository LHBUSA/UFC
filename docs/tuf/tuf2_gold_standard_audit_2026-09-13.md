# TUF 2 — gold-standard audit (2026-09-13)

Audit only. No season, episode, identity, database or production change.
Evidence: `scripts/tuf/evidence/tuf2_gold_audit_2026-09-13.json`. Reference implementation: TUF 1 (PR #33).

## 0. Headline

**A Nevada State Athletic Commission results document exists for all 12 TUF 2 house bouts.**
It is `boxing.nv.gov/.../2005_Results/TUFSEASON2.pdf`, live and byte-identical to its 2016 archive capture.
- It is headed "MIXED MARTIAL ARTS RESULTS", with the results column titled **"Exhibition Results"**.
- It gives each bout's fight date (06/15/05–07/12/05), winner, method, time, scorecards, judges, referee, DOBs, weights and medical remarks.

That changes TUF 2 from the TUF 1 shape in two ways:
- **Results:** all 12 house results can be **verified from a primary commission record**. On TUF 1 they could only ever be "reported".
- **Classification:** the exhibition label has a **season-specific affirmative commission basis**. The TUF 1 ESPN retrospective is not needed and must not be generalized.

## 1. Current state, verified against main 8cb932c

| Measure | Brief | Verified |
|---|---|---|
| Season | completed | completed |
| Tournament bouts | 14/14 | 14 (4+2+1 per division) |
| Professional | 2 | 2 finals, verified against result rows |
| House | 12 | 12 |
| Results | 2 verified / 12 secondary-only | same; no `result_sources` recorded |
| Classification | 2 pro / 12 exhibition / 0 unresolved | same; exhibition basis = "absent from our complete 2005 records" (absence only) |
| Contestants | 20 / 17 linked / 3 unresolved | same: Josh Burkman, Kenny Stevens, Eli Joslin |
| Open conflicts | 0 | 0 |
| Episodes | 12 + finale | 12 + finale broadcast |
| Episode depth | "effectively zero" | Since PR #33, 11 episodes show a bout referenced from the bracket. 0 timeline events. Episode 1 is an empty shell. |
| Matrix | PARTIAL, `HOUSE_RESULTS_SECONDARY_ONLY` | PARTIAL 71, depth 64; no declared format (elimination stage expected_basis "unknown") |

## 2. Visible product gaps (production /tuf/tuf-2)

1. **"Unassigned" team.** Kenny Stevens, Kerry Schall and Eli Joslin appear as a synthetic third team with no explanation. They are the pre-draft exits.
2. **Hidden roster events.** `format_exceptions` (Schall injury, Christison replacement, MacDonald shoulder, Burkman replaced by Von Flue) exists in the data but **is not rendered anywhere**.
3. **No timeline.** 0 events. There are no team moves (Von Flue to Franklin, Imes to Hughes), withdrawals, draft order, alternate, or semi-final draw.
4. **Empty episode 1.** It reads "Episode details not yet sourced."
5. **Wrong stage note.** The elimination stage is labelled "Elimination round", with the note "Bouts the episode summaries record but the source's bracket does not include". That describes the draft's import, not the format.
6. **Invisible evidence.** Twelve "Winner reported" and twelve "Exhibition" pills carry no evidence line, while the commission record would verify both.
7. **Unsourced dates.** No air dates. No fight dates, although the commission dates every house bout.
8. **Unlinked Burkman.** Josh Burkman appears as plain text, so his finale win over castmate Sammy Morgan shows under "rest of the card". The debut line reads "9 of 17".
9. **No overview.** No format, cast size, premiere, filming window or network.
10. **Staff shown generically.** Randy Couture hosted and designed the challenges, which isn't shown.
11. **Portraits.** 5 of 18 linkable contestants have a licensed portrait; the rest show initials.

## 3. Format

**Current model:** elimination (4 per division), then semi-final, then final. No `competition_format`.

**Actual format:**
- 18 fighters, 9 per division (network: "Eighteen of the world's toughest heavyweights and welterweights").
- **Episode 1 (pre-draft):** Kerry Schall out injured (knee); Eli Joslin left the show; Kenny Stevens, named the weakest welterweight, called out Sammy Morgan and forfeited, saying he could not make weight. Sixteen were drafted.
- **Episode 2:** coin flip, Franklin picks first, 8 picks per coach. Dan Christison joins, replacing Schall.
- **Elimination phase:** Couture's team challenges decided which team chose the matchup; the loser of each house fight left.
  - Josh Burkman won the first fight, then broke his arm and left. Jason Von Flue replaced him and won his way to the semi-finals.
  - Rashad Evans fought twice (Murphy, Whitehead).
  - Sammy Morgan (opponent forfeited) and Keith Jardine reached the last four without a house fight.
  - Team moves: Von Flue to Franklin (episode 7), Imes to Hughes (episode 8).
- **Semi-finals:** matchups set by White, Franklin and Hughes with fighter input (episode 10). Marcus Davis was named alternate for a cut Von Flue, who was cleared. Fought 07/11/05 and 07/12/05 per the commission.
- **Finals:** live finale, 2005-11-05.

**Proposed declared format:** `elimination_then_semifinals`, the same kind as TUF 1.
- The episode 1 pre-draft exits are timeline events, **not bouts**. The forfeit must not be invented as a bout.
- The existing bouts fit this format without change.
- Eli Joslin's division is not stated by any captured source; it stays unassigned rather than guessed.

## 4. Episodes

| Ep | Title | Listing / display / independent | Air date | Bouts (commission date) | Events available |
|---|---|---|---|---|---|
| 1 | A New Crop | 08-22 / 08-23 / 08-22 | resolvable | — | Schall injured out; Joslin leaves; Stevens forfeits; cast of 18 |
| 2 | The Teams Are Picked | 08-29 / 08-30 / 08-29 | resolvable | Burkman def. Guillard (06-15) | Christison replaces Schall; coin flip + draft; Hughes wins WW challenge |
| 3 | No Pain, No Gain | 09-05 / 09-06 / 09-05 | resolvable | Imes def. MacDonald (06-18) | Burkman out (broken arm); Von Flue replaces him; MacDonald shoulder (commission: bicep/labrum tears); Hughes wins HW challenge |
| 4 | Strategy | 09-12 / 09-13 / 09-12 | resolvable | Stevenson def. Davis (06-22) | Franklin wins WW challenge |
| 5 | Leave it in the Octagon | 09-19 / 09-20 / 09-19 | resolvable | Evans def. Murphy (06-25) | Hughes wins HW challenge |
| 6 | Slugfest | 09-26 / 09-27 / 09-26 | resolvable | Von Flue def. Gurgel (06-29) | Hughes wins WW challenge by forfeit; Gurgel torn ACL (commission) |
| 7 | No Respect | 10-03 / 10-04 / 10-03 | resolvable | Petruzelli def. Christison (07-02) | Von Flue to Team Franklin; Franklin wins HW challenge; Christison facial fractures (commission) |
| 8 | Knees & Elbows | 10-10 / 10-11 / 10-10 | resolvable | Cummo def. Torres (07-06) | Imes to Team Hughes; Hughes wins WW challenge |
| 9 | Mental Game | 10-17 / 10-18 / 10-17 | resolvable | Evans def. Whitehead (07-08) | Imes passed over (training cut); Hughes wins HW challenge |
| 10 | Semi-Final #1 Killer Instinct | 10-24 / 10-25 / 10-24 | resolvable | Cummo def. Morgan, WW SF (07-11) | Von Flue cut, Davis named alternate; semi-final matchups set |
| 11 | Semi-Final #2 Bloody Brawl | 10-31 / 11-01 / 10-31 | resolvable | Evans def. Jardine, HW SF (07-11) | — |
| 12 | Semi-Final #3 & 4: Countdown | 10-31 / 11-01 / **11-01** | **unresolved** | Stevenson def. Von Flue (07-12); Imes def. Petruzelli (07-12) | Von Flue cleared; Petruzelli ear injury |
| Finale | TUF 2 Finale | 11-05 / 11-06 / 11-05 | resolvable | professional card | — |

**Episode depth:**
- Total: 12
- With facts currently: 11 (bouts referenced from the bracket; no events)
- With facts available after research: **12**
- Empty after research: **0**

**Network metadata defects:**
- The Paramount+ descriptions for **episodes 10 and 11 are swapped** relative to their titles, the same kind of defect as TUF 1's 11/12. Item 10 describes Evans vs Jardine; item 11 describes the semi-final draw and the first welterweight finalist.
- Episodes 11 and 12 share one listing date (a double-episode night).
- The display date is +1 day on every item.

## 5. House results

| Bout | Ep | Commission result | Draft | State |
|---|---|---|---|---|
| Burkman def. Guillard | 2 | UD 30-27 ×3 | UD R3 | PRIMARY/OFFICIAL |
| Imes def. MacDonald | 3 | tap out 4:10 R1 triangle choke | Sub (triangle) R1 4:07 | PRIMARY/OFFICIAL (time differs) |
| Stevenson def. Davis | 4 | tap out 4:12 R1 elbow strikes | Sub (elbows) R1 4:10 | PRIMARY/OFFICIAL (time differs) |
| Evans def. Murphy | 5 | UD 29-28, 29-28, 30-27 | UD R3 | PRIMARY/OFFICIAL |
| Von Flue def. Gurgel | 6 | UD 29-28 ×3 | UD R3 | PRIMARY/OFFICIAL |
| Petruzelli def. Christison | 7 | UD 29-28 ×3 | UD R3 | PRIMARY/OFFICIAL |
| Cummo def. Torres | 8 | UD 29-28, 30-26, 30-27 | UD R3 | PRIMARY/OFFICIAL |
| Evans def. Whitehead | 9 | UD 30-27 ×3 | UD R3 | PRIMARY/OFFICIAL |
| Cummo def. Morgan (SF) | 10 | TKO 2:08 R2 | KO (knee) R2 2:05 | PRIMARY/OFFICIAL (method wording and time differ) |
| Evans def. Jardine (SF) | 11 | UD 29-28 ×3 | UD R3 | PRIMARY/OFFICIAL |
| Imes def. Petruzelli (SF) | 12 | SD 29-28, 28-29, 29-28 | SD R3 | PRIMARY/OFFICIAL |
| Stevenson def. Von Flue (SF) | 12 | tap out 4:49 R1 armbar | Sub (armbar) R1 4:46 | PRIMARY/OFFICIAL (time differs) |

- Result verified: **12 available** (0 recorded today).
- Reported: 0 after repair. Unknown: 0. Winner conflicts: 0.
- **Differences from the draft:** 4 bouts differ on time and/or method wording. The commission is the authority, and the draft value is preserved as provenance.
- Bracket progression is used as corroboration only; every result stands on the commission line for that bout.

## 6. Classification

- **Professional:** 2 (finals, from result rows).
- **Exhibition with affirmative evidence:** **12 available** (the commission record's "Exhibition Results"). 0 recorded today.
- **Exhibition absence-only:** 12 today; 0 after repair.
- **Unresolved:** 0.
- **Affirmative classification source found:** **YES**, the NSAC commission record for Season 2 itself (evidence level `commission_record`).
- **Caveats to record:**
  - Wikipedia states the commission long treated Season 2 as professional and later changed it, citing the same document. An older record or third-party database may still show these bouts as professional. The current commission document is the authority; record the change.
  - Page 2 of the document continues the same table under the header "Results".
  - Database absence stays corroboration only.

## 7. Identities

- Contestants: 20. Linked: 17. Unresolved: 3.
- **New deterministic link:**
  - **Josh Burkman → Joshua Burkman** (`1f85c086`, UFC Stats `6da99156486ed6c2`). Three independent anchors:
    - finale bout vs castmate Sammy Morgan, 2005-11-05
    - ESPN competition 156030 (Joshua Burkman, winner)
    - the commission's "JOSHUA R BURKMAN", DOB 04/10/80 = the canonical DOB
  - The resolver misses him only because it has no Josh→Joshua convention. Governed alias proposed.
- **Still unresolved (no canonical row expected):**
  - **Kenny Stevens:** forfeited before the draft; no UFC bout anywhere in our records.
  - **Eli Joslin:** left in episode 1; the only similar row, Jeff Joslin, is a namesake and must not be linked.
- **Canonical rows missing:** 0.
- **DOB cross-check against the commission:** 16 of 17 bout participants match exactly. **Brad Imes** differs: canonical 1977-03-13; commission and ESPN both 1977-03-16.

## 8. ESPN ids

- **Already present on contestant rows:** 0.
- **Deterministic attachments available** through the finale event (ESPN `400254173`): **10**, with 0 ambiguous, 0 conflicts and 0 duplicate ids.
  - The 10: Evans, Burkman, Guillard, Stevenson, Davis, Jardine, Imes, Cummo, Morgan, Schall.
- **Not anchorable via the finale:** 8 (Petruzelli, Gurgel, Von Flue, Christison, Torres, MacDonald, Murphy, Whitehead). Their first UFC bouts were on 2006 cards.
- **DOB conflicts:** 1 (Brad Imes, as above).
- **Proposed separately, not applied:**
  - a 10-fighter source-id attachment through the TUF 1 machinery (planner, rollback proof, negative control, audit rows, retired-slug 308s)
  - Burkman's alias first, so his row is the expected set

## 9. Air dates (two-source rule)

- **Resolvable:** 11 episodes + finale (listing date equals Wikipedia's original air date).
- **Unresolved:** 1. Episode 12: network 2005-10-31 vs Wikipedia 2005-11-01.
- **Source disagreements to preserve:** the episode 12 date; the +1 display offset on every item; the episode 10/11 description swap.

## 10. Finale integration (from the database, no copies)

- **Finals:** 2, linked by exact ids, results verified.
  - Scorecards: 3 + 3.
  - Round stats: 3 + 3 rounds.
- **Castmate bouts:** 3. Jardine def. Schall and Guillard def. Davis are shown today. Burkman def. Morgan appears once Burkman links.
- **Other bouts:** Florian def. Cope (Florian is a TUF 1 finalist) and Sanchez def. Diaz (Sanchez is the TUF 1 winner, main event). A generic "alumni of other seasons" marker is a candidate.
- **Debuts:** 9 of 17 today; 10 of 18 after the Burkman link.
- **Coaches' connection:** **none.** Hughes and Franklin did not fight each other; nothing to show, nothing to invent.

## 11. Timeline available

| Kind | Count | Detail |
|---|---|---|
| Draft/team events | 3 | draft with coin flip; Von Flue → Franklin (ep 7); Imes → Hughes (ep 8) |
| Injuries | 8 | Schall knee (1); Burkman arm (3); MacDonald shoulder/bicep+labrum (3, commission remark); Gurgel ACL (6, commission); Christison facial fractures (7, commission); Imes training cut (9); Von Flue cut (10); Petruzelli ear (12) |
| Withdrawals | 3 + 1 forfeit | Schall (injury); Joslin (voluntary); Burkman (injury); Stevens forfeit (episode 1) |
| Replacements | 2 + 1 alternate | Christison for Schall; Von Flue for Burkman; Davis as alternate (unused) |
| Eliminations | 13 | 1 forfeit + 8 elimination-bout losers + 4 semi-final losers |
| Weight events | 1 | Stevens cannot make weight. The commission also records weights for all 24 corners, with no misses. |
| Staff changes | 0 | Randy Couture as challenge host is a season role, not a change |

## 12. Portraits

- With a licensed portrait: 5 (Evans, Stevenson, Davis, Jardine, Von Flue).
- Without: 13.
- Approved candidates: 0.

## 13. Proposed TUF 2 gold repair (not applied)

Reuses the TUF 1 architecture; no TUF 2 renderer logic.

1. **Format.**
   - Declare `competition_format: elimination_then_semifinals`.
   - Relabel the stage "Elimination fights" and replace the draft-import note.
   - Record the episode 1 exits as timeline events.
   - Remove the synthetic "Unassigned" team: those people become timeline events, with roster entries kept in a separate pre-draft cast list.
2. **Commission record as a source.** Add it to the evidence ledger (sha256, URL, archive URL). For each of the 12 house bouts:
   - `result_sources` = the commission line, so the result becomes **verified**
   - corrected time/method where the commission differs, with the draft preserved in provenance
   - `fight_date` from the commission (distinct from air date)
   - `classification_basis.affirmative` = the commission record ("Exhibition Results", `commission_record`)
   - absence recorded as corroboration only
   - officials and cards as bout evidence
   - reopen note for the documented reclassification
3. **Generic support.** The result verifier (`tufBoutState` / matrix) must accept a commission `result_sources` entry as primary. Today only UFC.com repairs, agreeing recaps and result rows verify a result.
4. **Timeline events.** Convert `format_exceptions` into sourced timeline events. Add:
   - the draft (pick order)
   - the 2 team moves and 3 commission medical remarks
   - the alternate
   - the semi-final draw, with its content stated
   - episode 1 exits
   - Burkman's injury withdrawal
5. **Air dates.** Add a TUF 2 entry to `evidence/air_dates.json`: 12 display dates, independent dates, and the episode 10/11 description swap as a source defect. Episode 12 stays unresolved.
6. **Overview:** cast 18 (network), premiere, finale, fight window 2005-06-15 to 2005-07-12 (commission), network, coaches, challenge host.
7. **Identity.** Governed alias Josh Burkman → Joshua Burkman. Kenny Stevens and Eli Joslin stay unlinked with reasons; Jeff Joslin is explicitly rejected as a namesake.
8. **ESPN ids (separate approval):** the 10-fighter finale-anchored attachment, with 308s. The Imes DOB conflict is recorded, not written.
9. **Staff:** Randy Couture as challenge host (role, no team).
10. **Tests** mirroring TUF 1:
    - format coherence (Morgan and Jardine without a house fight, Evans twice, Von Flue as replacement)
    - no forfeit bout invented
    - 12 results verified by the commission
    - 12 exhibitions with commission basis, absence not the authority
    - Burkman alias
    - episode 12 air date unresolved
    - 10/11 swap preserved
    - no empty episodes
11. **QA** at 390px and 1440px, then a production check.

**Expected after repair:** results 12 verified, 0 reported; classification 12 exhibition (commission); episodes 12/12 with facts; contestants 18 of 20 linked. TUF 2 would then be the first season whose house results are verified from a primary source.
