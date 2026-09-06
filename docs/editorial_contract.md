# Editorial contract — bettor-angle fact block (V3)

Shared by `scripts/news/write_articles.mjs` (producer), `web/app/news/[slug]`
(renderer) and `workers/ufc-api` (`/v1/ufc/articles/{slug}`). Implements
`docs/UFC_PRODUCTION_V3_EDITORIAL_ADDENDUM.md` §7. Everything lives inside the
existing `ufc_articles.fact_block` jsonb; no migration.

```jsonc
{
  "version": 2,
  "story_class": "main_event_preview | main_card_preview | prelim_preview | event_preview | results | card_change | rankings | external",
  "generated_at": "ISO",
  "sources": { "families": ["espn", "ufcstats", "newsroom"], "news_item_ids": [] },
  "event": { "id": "uuid", "name": "...", "event_date": "YYYY-MM-DD", "venue": null, "city": null, "region": null, "country": null },
  "bout":  { "id": "uuid", "weight_class": "FEATHERWEIGHT", "is_womens": false, "is_title": false, "scheduled_rounds": 5, "card_position": "main", "bout_order": 13 },
  "matchup": {
    "a": { /* FighterFacts */ }, "b": { /* FighterFacts */ },
    "edges": [ { "key": "reach", "favors": "b", "delta": 4, "unit": "in", "note": "..." } ]
  },
  "bettor_angle": {
    "impact_score": 3,                       // 1–5, integer
    "markets": ["moneyline", "fight_goes_distance", "total_rounds", "method_of_victory", "round_betting", "significant_strikes", "takedowns"],
    "summary": "2–5 sentences. Analysis, labelled as such.",
    "supporting_facts": ["every fact traceable to matchup/archive fields"],
    "risks": ["at least one counter-case"],
    "watch_items": ["weigh-in status", "five-round confirmation", "line movement once priced"],
    "odds_status": "unavailable",            // unavailable | snapshot | live
    "model_status": "unavailable"            // unavailable | priced
  },
  "market_watch": { "status": "unavailable", "markets": ["fight_goes_distance", "total_rounds"], "note": "Current market price not yet available in PropBetEdge data." },
  "results": { /* results stories: bouts[], main_event totals, post_mortem facts */ }
}
```

`FighterFacts`:

```jsonc
{ "fighter_id": "uuid", "name": "...", "nickname": null, "slug": "manel-kape-3155416",
  "record": { "w": 17, "l": 3, "d": 0, "nc": 0 }, "age": 29, "height_in": 67, "reach_in": 69, "stance": "ORTHODOX", "weight_lbs": 146,
  "career": { "slpm": 6.04, "str_acc": 42, "sapm": 4.57, "str_def": 60, "td_avg": 0.71, "td_acc": 64, "td_def": 76, "sub_avg": 0.2 },   // null fields when absent; percentages as printed (42 = 42%)
  "archive": { "fights": 4, "w": 3, "l": 1, "d": 0, "nc": 0, "ko": 1, "sub": 1, "dec": 1, "finish_rate": 67, "rounds_with_stats": 3,
               "totals": { "sig_l": 110, "sig_a": 241, "td_l": 0, "td_a": 0, "kd": 1, "ctrl_sec": 18 } ,
               "last": [ { "date": "2026-01-24", "opponent": "Arnold Allen", "opponent_slug": "...", "result": "W", "method": "DEC_U", "round": 3, "event": "UFC 324" } ],
               "days_since_last": 231 } }
```

Markdown body (`body_md`) for previews uses these H2s, in order, omitting any
section the fact block cannot support: `## The setup`, `## Tale of the tape`,
`## Recent form`, `## Style and statistical matchup`, `## What could break the
angle`, `## Final read`. The Bettor's Edge block and Market watch box are NOT
written into the markdown — the page and the API render them from
`fact_block.bettor_angle` / `fact_block.market_watch`, so they are never
duplicated. Results stories add `## What the fight changed` after `## Full results`.

Rules: no fabricated odds, picks, probabilities, injuries or model output.
`odds_status` and `model_status` stay `unavailable` until verified structured
data exists. Every number in prose must appear in the fact block or an
attributed source item. Impact score is analysis, not fact.
