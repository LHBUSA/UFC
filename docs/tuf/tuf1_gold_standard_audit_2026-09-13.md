# TUF 1 — gold-standard audit (2026-09-13)

Research and audit only. Nothing in the season, episode, identity or database layers has been changed.
Evidence with short quotes, URLs and retrieval times: `scripts/tuf/evidence/tuf1_gold_audit_2026-09-13.json`.
Production page inspected: https://ufc.propbetedge.ai/tuf/tuf-1 at 1440px and 390px.

## 1. Visible product gaps (production, before any edit)

| # | Area | What a reader sees | Why it is wrong or thin |
|---|---|---|---|
| 1 | Episodes | 12 of 12 expand to "No official recap found for this episode." | The graph already places 8 bouts and 3 trades by episode, and the network listing carries short factual descriptions. It reads as an error, not a data state. |
| 2 | Episodes | "no air date is shown because no source states one" | False for TUF 1: the network listing date equals the secondary original airdate for all 12 episodes. |
| 3 | Episodes | No episode 13 / finale broadcast | The listing carries the finale broadcast; the episode file holds it as `finale_broadcast`, but nothing renders it. |
| 4 | Tournament | Quarter-finals with an "Unverified" stage pill in both divisions, plus a "Where sources disagree" panel | The season was not a bracket (§5). Southworth "winning and losing in one round", Sanchez listed twice, and Hoger/Florian with no prior bout are artefacts of the model, not source conflicts. |
| 5 | Tournament | Three house bouts show no episode | Koscheck–Leben (ep 6), Bonnar–Southworth (ep 7) and Griffin–Schoenauer (ep 9) are placeable; ep 6 is named by the network itself. |
| 6 | Result | Ten "Winner reported" chips with no visible source | The result's evidence is invisible, so the reader can't see that it is Wikipedia-only. |
| 7 | Classification | Ten "Exhibition" pills | The recorded basis is "absent from our complete 2005 records", but the house fights were **filmed in late 2004** (UFC.com). There is no 2004 completeness entry. No affirmative source is recorded. |
| 8 | Roster | Loose italic notes under names ("Traded … episode 4", "Withdrew in episode 8 …") | Disconnected from any timeline. The Quarry note merges an episode 5 injury with an episode 8 withdrawal. The Rafferty trade episode conflicts with the secondary source (7 vs 8) and is unflagged. Draft pick order is missing. |
| 9 | Identity | "Nathan Quarry" unlinked, monogram face | Canonical row `Nate Quarry` exists, with a licensed portrait and his finale bout against castmate Sincaid. |
| 10 | Portraits | Both champions (Griffin, Sanchez) show monograms | 10 of 16 contestants have no licensed portrait. The coaches do. |
| 11 | Staff | Laimon, Fairtex and Welch shown as "assistant coach" | They were discipline coaches (grappling, Muay Thai, boxing) with no team; `role_basis` says "listed on a team staff", which misstates it. Quarry's post-withdrawal assistant-coach role is absent. |
| 12 | Finale | A single link card: "The card's bouts are not restated here" | Nothing explains that all 16 contestants debuted on this card. The six other cast-vs-cast professional bouts are invisible. The coaches' fight (UFC 52, a week later) isn't linked. |
| 13 | Finals | Griffin vs Bonnar shows "Decision · R3" | The database holds all three 29-28 cards (Shirley, Weeks, Mullen) and round stats; the page shows none. The season JSON copies a `scorecards` string instead of reading the rows. |
| 14 | Overview | Hero is coaches + champions only | No format, dates (premiere 2005-01-17 → finale 2005-04-09), filming period, divisions, cast size, network or venue. |
| 15 | Matrix | TUF 1 PARTIAL with `BRACKET_BOUTS_MISSING` (expects 4 quarter-finals) | The completeness model assumes a modern bracket and punishes the season for its real format. |

## 2. Counts

**Episodes:** 12 (+1 finale broadcast in the network listing).
- With factual content shown now: **0**.
- Empty shells: **12**.
- Facts already in the graph but not attached to episodes: 8 episodes.
- With sourced facts available after research: 12.

**House bouts:** 10.
- Result verified 0, reported 10, unknown 0. Every house result rests on Wikipedia; ESPN carries no TUF 1 house bouts, and no UFC.com recap is captured for the season (not re-crawled).

**Classification:**
- Professional: 2 (the finals, verified against result rows).
- Exhibition with an affirmative source (as recorded): **0**.
- Exhibition based only on absence: **10**, and that absence is argued from the wrong year.
- Unresolved: 0.

**Identities:** 16 contestants.
- Linked 15, unresolved 1 (Nathan Quarry → canonical `Nate Quarry` e8999544).
- Likely canonical row missing: **0**.
- Staff: 3 unlinked, and none were UFC fighters.
- Surprise: **0 of 18** TUF 1 people carry an ESPN athlete id. This is systemic: 1,851 fighter rows have a UFC Stats id and no ESPN id. All 16 ESPN ids are recoverable by the exact finale competitions.

**Finale:** 2 professional finals, 2 linked by exact bout, 2 results verified.

**Timeline events available (sourced):**
- **Trades: 3.** Schoenauer ep 4, Rafferty ep 7 (secondary) vs ep 8 (season file) — conflict, Florian ep 9.
- **Withdrawals: 1.** Quarry, ep 8.
- **Replacements: 1 used** (Leben returns for Quarry, ep 8), plus 1 alternate named and not used (Southworth for Griffin, ep 10).
- **Injuries: 3.** Quarry ankle ep 5, Leben hand ep 5, Griffin cut ep 9.
- **Eliminations: 12.**
  - 2 without a fight (Thacker, Sanford, ep 2).
  - 6 by losing an elimination fight (Sincaid 3, Karalexis 4, Leben 6 (later returned), Southworth 7, Rafferty 8, Schoenauer 9).
  - 4 semi-final losers (Leben 10, Koscheck 11, Hoger and Swick 12).
- **Other:** weight issue 1 (Southworth, ep 3, commission gave 2 hours), matchup ordered by White 1 (ep 5), team draft 1 (ep 1), semi-final matchup announcement 1 (ep 10, content not stated), staff change 1 (Quarry to assistant coach, ep 8).

## 3. Sources found

**Primary / official:**
- Our records: finale event, 9 bouts, results, scorecards and round stats; UFC 52.
- ESPN core API finale event 400254386 (competitor athlete ids, winners).
- ESPN athlete eventlogs (prove the absence of house bouts at ESPN).
- UFC.com "UFC Legends: Griffin vs. Bonnar 1" (2015): "Filming for the show started in late 2004".
- Commission record: **not located**.

**Network:** Paramount+ season 1 listing: 13 items with titles, listing dates and short descriptions.
- Defects: the descriptions for items 11 and 12 are swapped relative to their titles, and the display airdate is +1 day on every item.

**Secondary:**
- ESPN, Rothstein 2020-04-09. It is the only affirmative classification source found: "Fertitta had worked with the Nevada State Athletic Commission to designate any fights before the live finale as exhibitions".
- Wikipedia TUF 1 wikitext (episode bullets: draft evidence).
- Wikipedia TUF main article (format paragraph; its exhibition sentence cites a 2007 salaries article, not Season 1).
- MMA Full Contact (mirrors Wikipedia, **not independent**).
- Not captured: Tapology (403, not bypassed) and IMDb (cited by Wikipedia for airdates).

## 4. Result evidence, bout by bout

| Ep | Bout | Result source today | Network | Proposed result state |
|---|---|---|---|---|
| 3 | Southworth def. Sincaid | Wikipedia | "Two fighters christen the Octagon" (unnamed) | reported |
| 4 | Sanchez def. Karalexis | Wikipedia | "two Middle Weights face off" (unnamed) | reported |
| 6 | Koscheck def. Leben | Wikipedia | ep 7 opens "After the much-anticipated Leben vs Koscheck fight" (pairing named, not the winner) | reported |
| 7 | Bonnar def. Southworth | Wikipedia | "pits two of the strongest fighters" (unnamed) | reported |
| 8 | Sanchez def. Rafferty | Wikipedia | — | reported |
| 9 | Griffin def. Schoenauer | Wikipedia (its own finale prose says "TKO" against the episode list's "submission (strikes)") | LHW "fighter selection" (unnamed) | reported, with a secondary inconsistency noted |
| 10 | Florian def. Leben | Wikipedia | title "Middleweight Semi-Final #1" | reported |
| 11 | Sanchez def. Koscheck | Wikipedia | title "Middleweight Semi-Final #2" | reported |
| 12 | Griffin def. Hoger | Wikipedia | pairing named (under item 11's swapped description) | reported |
| 12 | Bonnar def. Swick | Wikipedia | pairing named (same) | reported |

Under the Phase 2 rule none is verified: the network names pairings and never a winner. What is new is that the evidence quality can now be *shown* per bout rather than implied.

## 5. Bracket / format

**Current conflicts:** 3.
- Light heavyweight quarter-finals.
- Middleweight quarter-finals.
- Assistant coaches without a team (a data fact, not a conflict).

**Actual format:** an elimination phase, not quarter-finals.
- Eight fighters per division.
- Team challenges first eliminated fighters without a fight (Thacker, Sanford, ep 2). They then decided which team picked the next matchup; one fight (Koscheck–Leben) was ordered by White instead.
- The loser of each house fight left. So Southworth and Sanchez fought twice before the semi-finals, while Hoger, Swick, Florian and Quarry reached the last four without a house fight.
- Quarry's injury withdrawal let him choose a returning eliminated fighter (Leben). Griffin named an alternate (Southworth) who wasn't needed.
- Semi-finals (eps 10–12), then finals on the live finale card.

Every bout in the current file fits this, and **no bout is missing**. The "conflicts" disappear when the stage is modelled as an ordered elimination phase (`stage: "elimination"`, which the type already supports) rather than a quarter-final tree.

## 6. Classification

The rule "absent from our professional records ⇒ exhibition" is not the authority, and for TUF 1 it is also argued from 2005 when the fights were in late 2004.

- **Affirmative source found:** ESPN 2020 reports the season-specific arrangement with the Nevada State Athletic Commission designating every fight before the live finale as an exhibition.
  - This is secondary reporting, not a commission record.
  - It is corroborated by commission oversight of the episode 3 weigh-in (secondary).
- **Proposal:** classify the 10 house bouts as exhibition **with that affirmative basis cited**.
  - Keep database absence only as corroboration, recomputed for 2004.
  - If you judge a 2020 ESPN retrospective insufficient, the honest state is **unresolved** for all 10 until a commission record is found.

## 7. Proposed gold-standard repair (generic, not TUF 1-specific)

**Data (additive; season JSON varies, the renderer does not):**
1. `format` block: kind, short description, sources. Replace TUF 1's two quarter-final stages with `elimination` stages ordered by episode. Move the two structural `_conflicts` to `_resolved_conflicts`, citing the format finding.
2. `timeline_events[]` per season: id, episode, type, fighters and fighter ids, from/to team, `bout_ref` (a pointer into the bracket, never a copy), a short factual `fact`, `sources[]` with family/URL/retrieval/quote, an evidence level, and an optional `conflict`.
   - Roster notes become derived from events.
   - Draft pick order goes onto roster entries.
3. Attach episodes to the 3 unplaced bouts (6, 7, 9), each with its source.
4. Per-bout `result_sources[]` (Wikipedia recorded explicitly as draft) and `classification_basis {affirmative[], corroborating[]}`.
5. Episode layer:
   - Record the network metadata defects (11/12 swapped).
   - Render the finale broadcast.
   - **Air dates (needs your decision):** show a date only when the network listing date and an independent source agree. Otherwise label it "network listing date".
6. Staff: add discipline for Laimon, Fairtex and Welch, and correct their `role_basis`. Add Quarry as assistant coach from episode 8, as a timeline event.
7. Remove the copied `scorecards` string from the season JSON (the database holds the cards).

**Identity:**

8. Add a `name_aliases.json` entry Nathan Quarry → Nate Quarry, with the finale-bout proof (satisfies that file's rule).
9. *Separate approval (database write):* backfill ESPN athlete ids for the 16 contestants from the exact finale competitions. It is a systemic gap across 1,851 rows, so scope it deliberately.

**Classification:**

10. Apply the §6 decision. Add 2004 to `record_completeness.json` as corroboration only.

**Rendering (generic components used by all 44 seasons):**

11. **Season overview:** format, premiere → finale, filming period where sourced, divisions, cast size, network.
12. **Season timeline:** grouped by episode, each event with its source family. Empty episodes collapse into one "Episode details not yet sourced" line instead of 12 shells.
13. **Episode card:** the bouts that aired there (read from the bracket, with a result badge, classification badge and evidence), plus roster moves, injuries, eliminations and weight issues, plus sources.
14. **Elimination-phase renderer** (ordered list with episode, no tree), alongside the existing bracket renderer, chosen by `format.kind`.
15. **Result and classification badges** that expose their evidence (source families) on tap/hover.
16. **Clean roster cards:** pick number, original team, a move chip linking to the timeline event.
17. **Finale integration** (read-only joins):
   - finals with judge scorecards and a bout link
   - "All 16 contestants debuted on this card", listing the 6 other cast bouts
   - Rich Franklin vs Ken Shamrock as the main event
   - the coaches' fight (UFC 52) link
   - a plain statement that house bouts are separate from these professional results

**Matrix:**

18. Make expectations format-aware (an elimination season is not "missing quarter-finals"). Add an episode-content measure so empty shells count against depth.

**Tests:** format coherence (every advancing fighter has a sourced path), timeline references resolve to real bracket bouts, no copied result truth in episodes, classification has an affirmative basis or is unresolved, and no episode renders as an empty shell.

**Stays unresolved after the repair, and will be shown as such:**
- the Rafferty trade episode (7 vs 8)
- the content of the episode 10 semi-final announcement
- Griffin–Schoenauer method wording
- all 10 house results remain *reported* (secondary)
- no commission record
