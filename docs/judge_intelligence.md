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

Two kinds of alias, held in `ufc_judge_aliases.kind`, and they are held to
different standards on purpose.

- **`deduction_annotation` (43)** — the upstream Details line prefixes a point
  deduction onto the judge's name: `"Low Blow by Watson Richard Bertrand"`. The
  card is attributed to Richard Bertrand and the note is preserved as bout
  provenance, shown under the judge's name on the fight page. This is a parsing
  artefact, not a claim about who someone is, so it needs no external source.

- **`spelling_variant` (2)** — a merge of two *names*, which combines two
  people's records and can produce a confident, wrong career total. It requires
  an external judging registry holding a **single** official whose scored bouts
  account for the assignments filed under **both** of our spellings. The
  `ufc_judge_aliases_variant_needs_source` CHECK constraint refuses a
  spelling_variant row with no `source_url`, so the standard is enforced by the
  schema rather than by reviewer memory.

### Merges applied

#### 1. `Mamunah Querido` → `Maimunah Querido`

Source: [MMA Decisions judge 549](https://mmadecisions.com/judge/549/Munah-Querido),
verified 2026-09-08. That registry lists exactly one Querido judge, and that
single record's scored events cover assignments this archive files under both
spellings:

| event | date | spelling in this archive |
| --- | --- | --- |
| UFC on Fox 18 | 2016-01-30 | Maimunah Querido |
| UFC 288 | 2023-05-06 | Maimunah Querido |
| UFC on ESPN 54 | 2024-03-30 | **Mamunah Querido** |
| UFC 302 | 2024-06-01 | Maimunah Querido |
| UFC 316 | 2025-06-07 | Maimunah Querido |

Two officials cannot both be that one record, so the merge is established.
**Limit:** the source renders the name "Munah Querido", which matches neither
stored form. It confirms the merge, not the display spelling, so the canonical
name stays the dominant archive spelling.

#### 2. `Richie Gerrard` → `Ritchie Gerard`

Source: [MMA Decisions judge 606](https://mmadecisions.com/judge/606/Ritchie-Gerard),
verified 2026-09-08. The registry holds a single "Ritchie Gerard" with five
scored decisions, and those five are exactly the union of the assignments this
archive files under its two spellings — three under one, two under the other,
with no sixth decision unaccounted for on either side:

| event | date | bout | spelling in this archive |
| --- | --- | --- | --- |
| UFC Fight Night 110 | 2017-06-10 | Aldrich–Jeon | Ritchie Gerard |
| UFC Fight Night 110 | 2017-06-10 | Volkanovski–Hirota | Ritchie Gerard |
| UFC 243 | 2019-10-05 | Hooker–Iaquinta | **Richie Gerrard** |
| UFC 243 | 2019-10-05 | Potter–Pitolo | **Richie Gerrard** |
| UFC on ESPN+ 26 | 2020-02-22 | Kara-France–Nam | **Richie Gerrard** |

**Canonical is `Ritchie Gerard`, the minority archive spelling** (2 cards
against 3). That direction comes from the source, not from frequency, and the
distinction is not academic: an earlier revision merged this pair the *other*
way on archive resemblance alone — no source, and backwards. It was withdrawn
for lack of evidence and reinstated only once the registry was cross-matched
assignment by assignment. Merging on the archive's own majority would have
shipped a confidently wrong canonical name.

The registry's dates are US local and run a day behind ours for the Auckland
and Melbourne cards. That is the dateline, not a mismatch.

Merging the pair moves the archive from 468 canonical judges to **467** and
gives the combined record 5 cards. Both halves sat far below the 40-card rate
floor before and the union still does, so no published rate changes.

### Under review — evidence held, merge NOT applied

None. `PROVISIONAL_IDENTITY_CANDIDATES` is empty, which is the intended steady
state: a pair sits there only while it is genuinely undecided, and both known
pairs are now resolved. The mechanism stays in place — the review list, the
"this record may be incomplete" notice on affected profiles, and the tests that
keep a listed pair out of both `JUDGE_ALIASES` and the migration seed.

### Names that are not merged

Similar names belonging to different officials are never merged. `Chris Lee`
(701 cards) and `Chris Leben` (24 cards) are two people and stay separate.
`judgeScoring.test.mjs` proves this behaviourally rather than structurally: it
runs Chris Lee, Chris Leben and an unseen third near-name through the same path
the archive uses and asserts three separate records with one card each. Nothing
in the resolver merges on similarity — it merges exactly the alias table, and no
`spelling_variant` row can exist there without a source.

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

## View security

Every one of the seven views is created `with (security_invoker = true)`, and
this is not defensive boilerplate.

A Postgres view runs as its **owner** unless that flag is set. On this project
views are owned by `postgres`, which holds `BYPASSRLS`. So a view over an
RLS-protected table hands its reader the rows the table itself refuses them —
and the default gives you that behaviour.

That is not theoretical here. `scripts/judges/verify-view-security.mjs` probes
the running database with the **anon** key and finds:

| relation | anon gets rows? | |
| --- | --- | --- |
| `ufc_bout_results`, `ufc_bouts`, `ufc_events`, `ufc_fighters` | no | RLS enabled, no policy — correctly denied |
| `ufc_referee_bouts`, `ufc_referee_stats`, `ufc_referee_directory` | **yes** | views from migration 008, no `security_invoker` |

The referee views expose, to any holder of the public anon key, exactly the
archive rows their base tables deny. **That is a live finding in the referee
layer, reported and not changed on this branch** — it is a different layer's
production DDL. It serves here as the control: it is what these judge views
would do without the flag.

Role facts the model rests on, read from `pg_roles`:

| role | `BYPASSRLS` |
| --- | --- |
| `anon` | no |
| `authenticated` | no |
| `service_role` | yes — server reads keep working |
| `postgres` (view owner) | yes — which is the whole problem |

Alongside the flag the migration:

- enables RLS on both judge tables and creates **no policy**, so there is no
  public read path at all;
- **revokes** `insert, update, delete, truncate, references, trigger` from
  `anon` and `authenticated` on both tables *and* all seven views. Supabase
  grants those by default and only RLS was stopping them; revoking means a
  future "allow public read" policy cannot quietly re-open a write path, and a
  simple view cannot be written through;
- grants only `select` to `service_role`;
- contains no `SECURITY DEFINER` routine, so nothing reintroduces the
  escalation the views just closed.

`web/lib/judgeSchema.test.mjs` asserts all of the above statically, so it holds
before anyone applies the migration. Once applied, re-running
`verify-view-security.mjs` additionally probes the real views with the anon key.

## Where the code lives

| | |
| --- | --- |
| `supabase/migrations/20260908000012_ufc_judge_intelligence.sql` | Identity tables, aliases, and the `ufc_bout_scorecards` / `ufc_bout_scorecard_summary` / `ufc_judge_bouts` / `ufc_judge_stats` / `ufc_judge_directory` / `ufc_scorecard_gaps` / `ufc_scorecard_coverage` views, all `security_invoker`. **Not applied.** |
| `web/lib/judgeScoring.ts` | The same rules in TypeScript — pure, no I/O. The runtime twin of the migration. |
| `web/lib/judges.ts` | Reads the base tables and builds the judge layer in process, so `/judges` works before the migration is applied. |
| `web/components/Scorecard.tsx` | The Official Scorecards section, including the explicit-absence state. |
| `web/app/judges/` | Directory, profiles, coverage register, published identity evidence. |
| `web/lib/judgeSchema.test.mjs` | Static access-control tests over the unapplied migration. |
| `scripts/judges/verify-view-security.mjs` | Live read-only RLS probe with the anon key, plus the migration audit. |

## Commands

```bash
# Independent read-only audit; writes docs/judge_scorecard_coverage.json.
# Fails if a finish carries a scorecard, if the buckets do not sum, if an alias
# matches nothing, if a merge is applied with no external evidence, or if a
# provisional pair collapses into one identity.
node --experimental-strip-types scripts/judges/audit-coverage.mjs

# Prove the checked-in (unapplied) migration agrees with the runtime rules by
# running its view bodies read-only through the Management API.
node --experimental-strip-types scripts/judges/verify-migration-sql.mjs

# Prove no view can bypass base-table RLS. Reads only: probes the live database
# with the anon key and statically audits the migration. Writes
# docs/judge_view_security.json.
node scripts/judges/verify-view-security.mjs

# Unit tests for attribution, gap classification, the statistics gates, the
# identity evidence rule, and the schema's access control.
cd web && npm run test:judges
```
