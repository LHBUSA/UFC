# UFC Production V3 — Editorial Depth / Bettor's Edge Addendum

This addendum is mandatory alongside:

- `docs/UFC_PRODUCTION_V3_CLAUDE_BRIEF.md`
- `docs/UFC_PRODUCTION_V3_LIVE_WIRE_ADDENDUM.md`

## Editorial mission

The UFC newsroom must not become a recap factory.

PropBetEdge's editorial advantage is translating a sports development into the betting implications that traditional coverage usually stops before. The article should answer not only **what happened / what is scheduled**, but also **what changes, what market types are affected, what data matters, what could invalidate the angle, and what a disciplined bettor should monitor next**.

This is a bettor-facing intelligence newsroom backed by structured UFC data.

The tone should feel like the strongest long-form work on `propbetedge.ai`: premium, sourced, analytical, readable, visual, and useful to someone deciding whether a matchup or market deserves attention.

Do not confuse "bettor angle" with "invent a pick." If a real model price, sportsbook line or verified odds snapshot does not exist, say so and discuss the **market to monitor**, not a fabricated edge.

---

# 1. Core editorial rule: headline -> evidence -> betting implication

Every substantial UFC article should answer these in order:

1. **What is the verified development?**
2. **What does our own fight data say about it?**
3. **Why does it matter stylistically / statistically?**
4. **Which betting markets could be affected?**
5. **What is the strongest evidence for the angle?**
6. **What is the counter-case / risk?**
7. **What should the bettor monitor before acting?**

A reader should leave with more context than they would get from simply reading the source headline or fight card.

---

# 2. Depth targets

Do not pad articles to hit a number, but the current 250–450 word fight-preview target is too shallow for the product bar.

Use these targets as editorial ranges:

- **Main-event / title-fight preview:** 900–1,500 words when source data supports it
- **Standard main-card fight preview:** 650–1,050 words
- **Full event betting preview / card intelligence:** 1,200–2,000 words when enough fights have reliable data
- **Event results / post-fight analysis:** 800–1,400 words
- **Major card change / late replacement / injury / weigh-in development:** 500–900 words
- **Rankings movement / matchup-announcement analysis:** 500–900 words
- **External wire item with limited verified context:** 250–500 words; do not artificially inflate thin sourcing

Quality beats length. If the fact block is thin, publish a concise attributed item instead of manufacturing analysis.

---

# 3. Required article anatomy for fight previews

A premium fight-preview article should normally contain:

## The setup

- event/date/venue
- weight class
- main/co-main/title/main-card/prelim status
- scheduled rounds
- records
- any verified short-notice state

## Tale of the tape

Use structured comparison where available:

- age
- height
- reach
- stance
- listed weight
- record

Explain the implication, not merely the numbers. Example: a 5-inch reach edge matters more when paired with materially higher SLpM / striking defense than when both fighters are low-volume grapplers.

## Recent form

Use the fight archive:

- last 3–5 UFC results
- quality/context of outcomes where the tables support it
- finish/decision pattern
- layoffs if derivable from event dates

Do not use narrative claims such as "looked bad" or "was robbed" unless an attributed source supports them.

## Style and statistical matchup

Where UFC Stats coverage exists, compare:

- SLpM
- significant-strike accuracy
- SApM
- striking defense
- takedowns per 15
- takedown accuracy
- takedown defense
- submission attempts per 15
- available round/bout totals
- knockdowns
- control time

Explain the interaction between profiles. The goal is matchup translation, not dumping a stat table.

## Bettor's Edge

Every substantial preview gets a visually distinct Bettor's Edge block.

Suggested fields:

- **Impact:** 1–5
- **Markets affected:** e.g. moneyline, fight goes distance, total rounds, method of victory, round betting, significant strikes, takedowns — only list markets logically connected to the evidence
- **The angle:** 2–5 sentences summarizing the actionable thesis
- **Why:** strongest supporting data points
- **Risk:** strongest counter-argument / source of variance
- **Watch before betting:** late weigh-in status, replacement, line movement, five-round confirmation, etc.

This block is analysis, not fact. Label it clearly.

## What could break the angle

World-class betting analysis includes the reason it might be wrong.

Examples:

- incomplete UFC Stats sample
- opponent-quality uncertainty not represented by current data
- short-notice replacement
- fighter moving weight class
- very small archive history
- grappling metrics missing despite a grappling-heavy style
- no current odds snapshot

Do not hide uncertainty.

## Market watch

When no verified odds feed exists:

- say `Current market price not yet available in PropBetEdge data.`
- identify the market type worth watching
- explain what price/line movement would matter conceptually without inventing a number

Once a real odds pipeline exists, this section may include:

- book/provider
- snapshot timestamp
- opener/current price
- implied probability
- line movement
- best available price where redistribution/licensing permits

Never quote stale odds as current.

## Final read

End with a concise synthesis: what the matchup data says, where uncertainty remains, and what the bettor should monitor next.

Do not force a pick if there is no model/market edge.

---

# 4. Results articles need a bettor post-mortem

Results coverage should not stop at who won.

After the factual result section, add a **What the fight changed** / **Bettor post-mortem** section when the data supports it:

- what the result validated or challenged in the pre-fight profile
- striking/takedown/control differences from round stats
- whether the fight finished / went distance and why that matters to future market expectations
- whether a fighter's recent archive pattern materially changed
- likely market categories to reassess next time

Do not claim closing-line value, bad beats or market mispricing unless real pre-fight odds snapshots exist.

---

# 5. Card-change / injury / late-replacement stories

These should answer the question bettors actually care about: **what changed because the matchup changed?**

Required analysis where data exists:

- days of notice
- replacement fighter record / archive depth
- age / reach / stance differences
- style change relative to original opponent
- scheduled rounds / card position effects
- which market types become more volatile
- whether existing article/model analysis should be marked stale

If odds exist later, preserve both pre-change and post-change snapshots rather than overwriting history.

---

# 6. Rankings stories

Rankings articles should add betting context without pretending ranking number alone predicts fights.

Use rankings as one signal among:

- recent results
- opponent history
- activity / layoff dates
- career stats
- booked matchup

Good framing:

`The ranking move changes likely matchmaking and future market perception.`

Bad framing:

`Ranked #3 therefore should be a -200 favorite.`

Never infer odds from rank.

---

# 7. The bettor-angle data model

Evolve `ufc_articles.fact_block` / article-generation logic so bettor analysis is explicit and machine-readable rather than buried in prose.

Suggested additive structure:

```json
{
  "bettor_angle": {
    "impact_score": 4,
    "markets": ["moneyline", "fight_goes_distance", "total_rounds"],
    "summary": "...",
    "supporting_facts": ["..."],
    "risks": ["..."],
    "watch_items": ["..."],
    "odds_status": "unavailable|snapshot|live",
    "model_status": "unavailable|priced"
  }
}
```

If the database schema does not yet have a dedicated `take` column, keep this safely inside the existing `fact_block` / structured article metadata until a migration is justified.

The API article contract should eventually expose the bettor-angle shape directly.

---

# 8. Article writer changes

Primary generator: `scripts/news/write_articles.mjs`.

The writer currently protects factual integrity by creating a fact block first and allowing the LLM to rewrite only from verified facts. Preserve that architecture.

Change the philosophy from:

`No odds, no picks, no probabilities, no predictions.`

To:

`No FABRICATED odds, picks, probabilities or predictions. Betting-impact analysis is required when supported by the verified fact block. Actual prices/model outputs may appear only when those fields exist in verified structured data.`

The LLM may:

- explain stylistic interaction from provided stats
- synthesize recent-form patterns that are directly calculable from the archive
- identify relevant betting market categories
- explain uncertainty
- write a bettor-angle summary from the supplied evidence

The LLM may NOT:

- invent current odds
- invent sportsbook availability
- invent injury/news facts
- invent opponent-quality narratives
- invent model probabilities
- invent a pick
- imply a guaranteed edge

Every number in prose must trace to the fact block or an attributed source.

---

# 9. Visual article experience

Primary page: `web/app/news/[slug]/page.tsx`.

The page already has a strong base: hero media, byline, long-form prose, fighter/event side rail, related stories and NewsArticle schema. Keep it and raise it to the main PropBetEdge newsroom bar.

Add/upgrade:

## Bettor's Edge callout

Near the top of the article, after the dek/hero:

- PBE bolt / gold label
- `BETTOR'S EDGE`
- Impact x/5
- concise angle
- affected market chips
- risk/counter-case
- verified/model/odds availability state

It should visually resemble the premium `Bettor's Edge · AI Analysis` treatment on the main PropBetEdge newsroom, but use the UFC product's design language.

## Inline matchup module

For preview stories, embed a compact A-vs-B data module inside the article:

- portraits where licensed
- record
- age / reach / stance
- SLpM / SApM
- TD avg / TD defense
- finish rate / archive sample where supported
- link to full matchup

Do not make readers leave the article to understand the underlying thesis.

## Recent-form strip

Show last 3–5 UFC results for both fighters with W/L/NC, opponent and method.

## Market-watch box

Display one of:

- `MARKET DATA NOT YET CONNECTED — watch: Fight Goes Distance / Total Rounds`
- or a real timestamped odds snapshot once the odds product exists

Never show fake sportsbook lines as decoration.

## Source / methodology panel

At the end of the analysis, show:

- generated from PropBetEdge UFC database
- source families used (ESPN / UFC Stats / attributed newsroom sources as applicable)
- data freshness timestamp where practical
- article/editorial policy link

## Related intelligence

The right rail / below-article content should prioritize:

- matchup page
- event page
- related fighters
- relevant Live Wire headlines
- more newsroom coverage
- UFC Pro CTA where truthful

---

# 10. Headlines and deks

Headlines must communicate the analysis value, not simply mirror an event listing.

Avoid endless templates like:

`Fighter A vs Fighter B: Lightweight fight preview at UFC X`

Prefer specific evidence-led framing when the facts support it, e.g.:

- `Fighter A vs. Fighter B: the reach and pace mismatch bettors should watch`
- `Why Fighter A's takedown defense is the key variable against Fighter B`
- `Five rounds change the betting equation for Fighter A vs. Fighter B`

Do not manufacture a hook when the data is inconclusive. In that case use a clean matchup headline and let the article say the edge is unclear.

Deks should tell the reader what analytical question the article answers.

---

# 11. Editorial quality gates

Before an automatically generated substantial article is published, validate:

- enough verified facts exist for the claimed depth
- no numeric claim is outside the fact block / source material
- no current odds claim without a timestamped odds record
- no model claim without `model_version` and actual output
- bettor angle contains at least one supporting fact and one risk/counter-case
- duplicate/near-duplicate article check passes
- headline is not misleading
- licensed media attribution is present
- internal links resolve
- NewsArticle schema remains valid
- article meets minimum readable depth for its story class unless marked as a short wire item

If the LLM rewrite fails validation, fall back to the fact-safe template or hold for review — never publish invented depth.

---

# 12. PropBetEdge editorial principles to preserve

Carry forward the main newsroom's established standards:

- source verification before analysis
- prop-bet relevance as a reason to publish
- fact first, opinion/analysis clearly labeled second
- source attribution
- transparent AI assistance
- corrections when material facts change
- responsible-betting language where appropriate

The bettor angle is the differentiator, but credibility is the moat.

---

# 13. Future odds/model integration

Design the article experience now so future structured odds/model data drops into existing surfaces rather than requiring another redesign.

Future `Bettor's Edge` can evolve from:

- affected markets
- matchup thesis
- risks
- watch items

into:

- current line
- model fair price
- implied probability
- model probability
- edge percentage
- line movement
- best price
- confidence / sample caveat
- closing-line / grade history

Those fields remain hidden/unavailable until real data exists.

## Product bar

A great UFC article should feel like a fight analyst, data desk and disciplined bettor collaborated on it.

It should be useful before the fight, useful again when the market moves, and useful after the fight when evaluating what the data got right or wrong.

The goal is not more content. The goal is **better betting intelligence expressed as world-class sports journalism**.
