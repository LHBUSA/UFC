# Audit of the remaining relink proposals (2026-09-18, after autopilot v0.2.4)

Read-only. Nothing in this document was applied. Baseline: the full
`--relink --dry-run --explain` plan after the T3G correction — **77 rows + 13 held
article links**, 0 event or bout moves, 1 row blocked by the write guard.

## Classification

| class | rows | what |
|---|---|---|
| 1. genuinely actionable | **1** | `XA0XV_cWvII` |
| 2. safe evidence-only | **68** | language 29 · TUF rule label 15 · `surnames_withheld` evidence 14 · TUF label + withheld 8 · method label 2 |
| 3. ambiguous / hold | **13** (held, not in the 77) | article links that would go to `null` |
| 4. likely false positives **in the plan** | **0** | the plan proposes no false move |
| 5. structural resolver weakness | **1 + 7** | Evloev (1) · evidence-order noise (7, fixed in the comparison, see §5a) |

68 + 1 + 1 + 7 = 77.

### 1. Actionable — `XA0XV_cWvII` (MEDIUM)

*Turcios vs Hiestand | TUF 29 Bantamweight Final | Fight Preview*, UFC, 2021-08-26.

- **stored:** no event, no bout, no fighters, confidence `none`.
- **proposed:** event *UFC Fight Night: Barboza vs. Chikadze* (2021-08-28), its bout, Ricky Turcios
  + Brady Hiestand, confidence `high`.
- **why:** the title pairing rule (v0.2.3): both corners of exactly ONE bout within ±45 days of
  the upload, with a versus marker. Evidence source: **title only**.
- **event identity:** inferred from the bout (exact bout → its event); 2 days from the upload.
  **fighter identity:** surnames, but scoped to that bout's card — the invariant's allowed case.
- **moves:** event, bout, fighters, confidence. Not article, status or type.
- **verdict:** correct (the TUF 29 final was on that card). Additive, so the write guard allows
  it. Apply by `--ids XA0XV_cWvII` whenever convenient; no resolver change needed.

### 2. Evidence-only (68) — leave; they normalise on their next natural write

| rows | differs in | sample |
|---|---|---|
| 27 | `language` was never stored (`null → en/pt/es/ko`) | `NJPZ53NvBNM` *Joshua Van vs Tatsuro Taira, FULL FIGHT* |
| 2 | `language` + new `hosts_ignored: ["michael bisping"]` | `c44IaeD85Fg`, `F_Jg-J5MzuM` (Octagon Interviews) |
| 15 | TUF tag rule label (`"edition name"` → `"edition name without number"`) | `SF9Rva8pikI` *TUF Latin America: Coach Fabricio Werdum* |
| 14 | new `surnames_withheld` evidence | `B-s6Qk-lYcU` *Team McGregor vs Team Chandler* (records the withheld Chelsea Chandler) |
| 8 | TUF label + `surnames_withheld` | `cJo6_JgbPwQ` *TUF Latin America: Yair "Pantera" Rodriguez* |
| 2 | one fighter's `method` label: `full_name_window_card → full_name_unique` | `LmdnDSV66dE`, `bzsopbq0Z28` (Arnold Allen: his next card is outside the upload's window, the name is still unique) |

None moves a fighter, event, bout, article, status, type or confidence. Identity is exact (full
names) or absent on every one. No resolver fix; no write.

### 3. Hold — the 13 article links

All 13 are `article → null`, **not** a swap to a newer article. The resolver links an article
only while the bout has exactly one published article (`articles.length === 1`). Those bouts
now have 2, 4, 7, 2 and 4:

| stored article (all published 2026-09-06) | bout's articles now | videos that would lose the link |
|---|---|---|
| *Salahdine Parnasse stops Dan Hooker in first round at UFC Paris* | 2 | 7 |
| *Five rounds change the betting equation for Joshua Van vs. Alexandre Pantoja* | 4 | 2 |
| *Jean Silva vs. Jose Miguel Delgado: the reach and pace mismatch…* | 7 | 2 |
| *Yousri Belgaroui's finishing rate is the number that matters…* | 2 | 1 |
| *Mauricio Ruffy's finishing rate is the number that matters…* | 4 | 1 |

The stored links are still true (that article is about that bout). Event and fighter identity
are untouched; only `article_id` and `article_candidates` would move. **Keep held.** This is a
policy weakness, not a row problem — §5b.

### 5. Structural weaknesses

**5-Evloev. `7HUYpQ5OyGU` (HIGH, blocked, intentional).** *Volk preparing for Evloev*, ESPN MMA,
2026-09-02. Stored: no event, Movsar Evloev via the retired `surname_unique_window`, confidence
`low`. Proposed: no fighter, `none`. Why: no event key and no pairing in the title (one surname,
and "Volk" is a nickname), and UFC 333 is 52 days out. Event identity: none. Fighter identity:
inferred from a lone surname — exactly what the invariant refuses, and correctly so in general;
this instance happens to be right. Moves: fighter + confidence. **Leave the row; do not change
the resolver.** It is the one blocker that keeps an un-targeted full relink refused.

**5a. Evidence order is not stable (7 rows) — fixed locally.** `linking.fighters` is a set stored
as an array, in the order the fighters table came back. Seven rows differed from their proposal
only in that order (same fighters, methods, aliases). `changed()` and the diff now compare the
evidence sorted (`normLinking`). Effect: plan **77 → 70**, and two consecutive plans are
identical. It also stops the live run rewriting a row for nothing. Not deployed.

**5b. Article links decay.** `article_id` is set only when a bout has exactly one article, so it
goes to `null` as coverage grows. Relink holds it; **live discovery does not** — a row still in a
feed window loses its article link the moment a second article is published. No fix made:
article policy is the owner's separate decision. A conservative option is "keep the stored
article while it is still among the bout's candidates".

**5c. Promo hashtags in descriptions create false EVENT links — the broader pattern behind T3G.**
UFC channels stamp the weekend's tag into every description (`#NocheUFC ESTELARES 5pm ET …`),
including videos about something else. T3G was one of **five** `#GarciaBenn` UFC Espanol boxing
uploads attached to *Noche UFC: Silva vs. Delgado*: `T1GbGeTGWfc`, `2y1K-s24zjo`, `k4uINVxeSJE`,
`YcV2ZKI8nDM`, `T3G-YgpFjlQ`. The fighter was the visible symptom; the event link is the same
mistake and is consumer-visible (they sit in that event's video inventory). Survey of all 729
rows: 476 have an event; **41** rest on description-only evidence (12 series, 5 city, the rest
name/headliner keys); 15 of those have no fighter and no bout, i.e. the description is the only
thing holding the event.

Proposed rule, implemented **opt-in and OFF by default** (`--title-tag-guard`,
`linkVideo(..., { titleTagGuard })`): a matchup-shaped hashtag in the TITLE (two or more
capitalised words joined: `#GarciaBenn`, `#ZuffaBoxing`) that is not a key of the event overrules
an event found ONLY in the description; tags the expander understands (`#UFC331`, `#NocheUFC`,
`#UFCParis`, `#DWCS`) and sponsor tags (`#CryptoCom`) are not competitors. Dry-run with the flag
across all 729 rows: **exactly those 5 rows lose the event; nothing else changes.** All five
would be `event_lost`, so the write guard blocks them from any sweep: they go by `--ids` if the
owner accepts the policy. Production behaviour is unchanged while the flag is off.

**5d. Live discovery has no destructive guard.** The relink guard, the article hold and the status
hold exist only on the relink path. A scheduled run re-scores every row still in a feed window
with whatever rules are deployed and writes the result. That is how a rule change reaches recent
rows without review (it is also why each Worker deploy here was preceded by a dry discovery
run). Not changed.

## T3G pattern — the five questions

| | finding |
|---|---|
| `surname_unique_event_card` | 40 stored rows; 39 have the event key in the title; 1 (T3G) did not — closed by v0.2.4 |
| description-only event evidence | 41 rows; the false ones are the 5 `#GarciaBenn` rows (§5c) |
| title-key vs description-key | a title key is trusted for surnames; a description key links the event but lends no card. Whether a description key should link an event against a competing title tag is §5c, awaiting a decision |
| fighter removal without event destruction | proven on T3G and the 11 Garcia rows: `fighter_ids` + `linking` only; event, bout, article, status, type identical |
| evidence ownership on removal | the removed fighter leaves `linking.fighters` and is recorded in `linking.surnames_withheld` with a reason, so the row keeps the evidence of what was withheld and why |

## Description-only event links, read one by one (41 rows)

| verdict | rows | |
|---|---|---|
| correct | 32 | UFC 331 fight-week features (12), UFC Vegas 35 / Barboza–Chikadze (8), Noche UFC fighter features and the event's own weigh-in / preview streams (7), TUF finales (4), a DWCS clip |
| ambiguous | 2 | `AmOFdZaI9ug` *Moreno vs Figueiredo 2 — The Walk* → Noche UFC; `SjFuXM1WkyQ` *UFC Unfiltered* with Kai Kara-France |
| false | 7 | the five `#GarciaBenn` rows; `ysRi2-0iy3Q` (a UFC Brasil voting promo, attached to Noche UFC by the promo tag; no title hashtag, so the opt-in guard would NOT catch it); `gs5HepE_DRs` (*Inside the Octagon – Edgar vs. Mendes* attached to the *Namajunas vs VanZant* card of the same weekend) |

## Natural-run canary — first scheduled run on v0.2.4

`ufc_ingest_runs` a47cea48, invoked `cron` `13,43 * * * *`, 2026-09-18T17:13:35Z → 17:13:47Z,
`success`, assertion failures `[]`, failed channels 0. Deployed version `1cdcbcd9` (created
16:52:12Z), `/health` v0.2.4, `last_error: null`.

Against a full-table snapshot taken at 17:04Z:

| check | result |
|---|---|
| rows | 729 → 733: **4 inserted, 0 deleted, 2 existing rows rewritten** |
| duplicate provider ids | 0 |
| fighters / events / bouts / articles tables | 3285 / 924 / 9549 / 212 — unchanged (the Worker writes only `ufc_videos`) |
| the 4 new uploads | all UFC 331 weigh-in day: title `#ufc331` → event by TITLE; one carries a surname on that title-trusted card (*Arman and Ruffy make weight! #ufc331* → Ruffy); one *UFC Connected* has a description-only event and FULL-NAME fighters only; none has a surname on a description-only event |
| the 2 rewrites | `-aWT-0qmwmc`, `jTOp7srvO6U`: `linking.article_candidates 3 → 4` + `feed_updated`; no column changed. Explained: a fourth Tsarukyan–Ruffy article was published at 16:50Z. Predicted by the pre-deploy dry run |
| **T3G-YgpFjlQ** | `updated_at` unchanged since the correction (16:52:21Z); fighters 0; event intact; status `published`; `surnames_withheld` still records `garcia / event_scope_not_title_trusted` |
| rows with a surname fighter on a description-only event | **0** in the whole table |
| rows written by the run carrying `surname_unique_window` | 0 |
| Hangul titles stored `en` | 0 of 37 |
| UFC 331 | 145 → 149 linked rows; 0 existing rows moved |
| Evloev `7HUYpQ5OyGU` | untouched |
| relink plan, before vs after the run | 70 vs 70, identical ids; non-low still only Evloev (high, blocked) and `XA0XV_cWvII` (medium) |
| `/fight-week` 1440 + 390 | 9 English stage cards, 0 Korean in the default view, 26 Korean labelled KOREAN under All, no overflow, no console errors |

Production rows changed after the T3G correction: **only what that scheduled run wrote** — 4 new
uploads and 2 `article_candidates` bumps. No row was written by hand or by a relink.
