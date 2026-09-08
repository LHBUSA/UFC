# Judge intelligence & official scorecards

Canonical judge identities, attributed scorecards, and a published register of
everything the archive is missing.

## The problem this layer solves

`ufc_bout_results.scorecards` stores each judge card as a name and a bare score
pair:

```json
[{"judge": "Sal D'amato", "score": "27-30"}, …]
```

Nothing in the row says which number belongs to which fighter. An audit of all
12,004 stored cards shows the upstream convention puts the **bout winner's**
score second in every bout whose orientation can be resolved — but that is a
convention, not a guarantee, and reading position 1 as "fighter A" inverts
roughly 95% of the archive.

So orientation is **derived per bout**, never assumed:

> Count how many cards read higher-second and how many read higher-first. The
> winner won more cards than they lost, by the definition of every decision
> method, so the position holding the majority is the winner's.

Where that test cannot decide, the pair stays **unattributed** and is rendered
as a bare pair with a label saying so. Two cases produce that:

| case | cards | why |
| --- | ---: | --- |
| draws | 180 | no winner exists to anchor the score order to |
| conflicting cards | 3 | the card tally does not favour the recorded winner |

## Absence is a first-class state

A KO/TKO, submission, DQ or no contest never reached the judges, so no official
scorecard exists. That is the correct result, not a coverage gap, and the fight
page says so in words rather than rendering a blank grid, a dash or a zero.
`ufc_bout_scorecard_summary.has_official_scorecard` carries the distinction, and
it is defined for **every** result row.

No score is ever estimated, reconstructed or inferred for a fight that did not
go to a scorecard. The audit asserts this: `finishes_with_unexpected_scorecard`
must read 0.

## Coverage (audited 2026-09-08)

| | |
| --- | ---: |
| decision / draw results | 4,297 |
| with a scorecard | 4,006 (93.2%) |
| missing a scorecard | 291 (6.8%) |
| finishes — no scorecard expected | 5,042 |
| finishes carrying a scorecard | **0** |
| stored cards | 12,004 |
| attributed to a fighter | 11,821 (98.5%) |
| left as an unattributed pair | 183 |
| raw judge strings | 512 |
| canonical judges after aliasing | 467 |

### The 291 missing, classified

Classified from evidence in the row, not from an assumption about the era.

| classification | n | reason |
| --- | ---: | --- |
| Source unavailable | 172 | Event series (DWCS) is not covered by the scorecard source at all — 0 of 465 DWCS bouts carry a UFC Stats id |
| Source unavailable | 56 | Pre-2003 bouts where the source recorded no scorecard text |
| Recoverable | 42 | Scores are **already in the archive** in `finish_detail` ("27 - 30. 27 - 30. 28 - 29."); only the judges' names are missing upstream |
| Identity mismatch | 13 | ESPN-sourced rows at events we did ingest from UFC Stats, whose bout never matched a fight — mostly diacritic/name variants (Syguła, Rębecki, Cháirez) |
| Recoverable | 6 | ESPN-sourced results whose UFC Stats fight page id is already known |
| Non-standard / no score | 2 | 1995 tournament draws recorded only as "Time Expired" — no three-card decision was ever issued |

## Identity

Two kinds of alias, held in `ufc_judge_aliases.kind`:

- **`deduction_annotation` (43)** — the upstream Details line prefixes a point
  deduction onto the judge's name: `"Low Blow by Watson Richard Bertrand"`. The
  card is attributed to Richard Bertrand and the note is preserved as bout
  provenance, shown under the judge's name on the fight page.
- **`spelling_variant` (2)** — `Mamunah Querido` → `Maimunah Querido`
  (spelling confirmed externally; both forms are New Jersey assignments) and
  `Ritchie Gerard` → `Richie Gerrard` (**archive evidence only**: both forms are
  Oceania assignments, never share an event, differ by one letter in each name
  part — not confirmed against an external judging record).

Similar names belonging to different officials are never merged. `Chris Lee`
(701 cards) and `Chris Leben` (24 cards) are two people and stay separate.

## Statistics discipline

Every rate on a judge page carries its denominator, and:

- dissent rate is computed against **orientation-resolved cards only**, never
  the whole sample;
- rates are withheld entirely below **40** resolved cards (`MIN_RATE_SAMPLE`);
- a judge is only described as differing from the archive when the difference
  survives a 95% normal-approximation test against the archive baseline
  (6.7% of 11,821 cards), and a Wilson interval is drawn beside it;
- a dissent means the card differed from the official result. It is **not** a
  claim the card was wrong, and nothing on these pages characterises an official
  as favouring a style, a nationality or a type of fighter — the archive cannot
  support that claim.

## Archive integrity flags

Three bouts have a card shape that disagrees with the recorded method. They are
surfaced on the fight page, not corrected:

| date | bout | stored as | cards read |
| --- | --- | --- | --- |
| 2004-01-31 | Josh Thomson vs Hermes Franca | Majority | 3–0, no level card |
| 2015-05-30 | Francisco Trinaldo vs Norman Parke | Unanimous | 2–1 |
| 2017-04-08 | Patrick Cummins vs Jan Blachowicz | Unanimous | 2–0 with a level card |

Nine bouts hold fewer than three cards. The missing card is not reconstructed
and the displayed totals cover only the cards held.

## Where the code lives

| | |
| --- | --- |
| `supabase/migrations/20260908000012_ufc_judge_intelligence.sql` | Identity tables, aliases, and the `ufc_bout_scorecards` / `ufc_bout_scorecard_summary` / `ufc_judge_bouts` / `ufc_judge_stats` / `ufc_judge_directory` / `ufc_scorecard_gaps` / `ufc_scorecard_coverage` views. **Not applied.** |
| `web/lib/judgeScoring.ts` | The same rules in TypeScript — pure, no I/O. The runtime twin of the migration. |
| `web/lib/judges.ts` | Reads the base tables and builds the judge layer in process, so `/judges` works before the migration is applied. |
| `web/components/Scorecard.tsx` | The Official Scorecards section, including the explicit-absence state. |
| `web/app/judges/` | Directory, profiles, coverage register. |

## Commands

```bash
# Independent read-only audit; writes docs/judge_scorecard_coverage.json.
# Fails if a finish carries a scorecard, if the buckets do not sum, or if an
# alias matches nothing in the archive.
node --experimental-strip-types scripts/judges/audit-coverage.mjs

# Prove the checked-in (unapplied) migration agrees with the runtime rules by
# running its view bodies read-only through the Management API.
node --experimental-strip-types scripts/judges/verify-migration-sql.mjs

# Unit tests for attribution, gap classification and the statistics gates,
# including alias parity between judgeScoring.ts and the migration.
cd web && npm run test:judges
```
