# UFC Autopilot OS — production ownership

**Frozen 2026-09-10.** This file is the single source of truth for who runs and
who writes what. If another document disagrees with this one, this one is right
and the other is stale.

Two rules govern everything below.

1. **GitHub is source control, not a scheduler.** Every cron-bearing workflow is
   `disabled_manually`, and `history-gap-repair.yml` had its schedule deleted.
   Production scheduling is Cloudflare cron, without exception.
2. **One owner per write responsibility.** Two Workers writing the same thing
   means "who wrote this row" has no answer, and we have been bitten by it
   twice: two writers of `ufc_news_items`, then two writers of
   `ufc_articles` with `story_type='external'`.

---

## Story type → authoritative writer

| story_type | writer | trigger |
|---|---|---|
| `external` | **ufc-news-enrich** | a wire item. Relevance, entity resolution, first-party packet, GPT-5.6 Sol, two-class number gate, green path. |
| `fight_preview` | **ufc-event-editorial** | the schedule. A booked card deserves a preview; nothing on the wire triggers it. |
| `results` | **ufc-event-editorial** | the schedule, after a card completes. |
| `card_change` | **ufc-event-editorial** | the schedule, when a booking moves. |
| `rankings` | **ufc-event-editorial** | the schedule, after a rankings snapshot. |

`ufc-newsroom` writes **no** articles. It did until 2026-09-10, which is how
`external` acquired a second writer.

## Table → sole scheduled writer

| table | sole scheduled writer |
|---|---|
| `ufc_news_items` | ufc-news-ingest |
| `ufc_news_sources` | ufc-newsroom (`sources` phase) — see known exceptions |
| `ufc_news_pipeline_events` | ufc-news-ingest (detect) + ufc-news-enrich (all later stages). Disjoint stages, one appender each. |
| `ufc_articles` | ufc-news-enrich (`external`) + ufc-event-editorial (all other types). Disjoint story types. |
| `ufc_fight_state_ledger` | ufc-fight-state |
| `ufc_rankings`, `ufc_fighter_dna_snapshots`, `ufc_fighter_bout_features`, `ufc_fighter_stance_splits`, `ufc_dna_build_runs` | ufc-intelligence |
| `ufc_videos` | ufc-video-autopilot |
| `ufc_images`, media storage | ufc-media |
| `ufc_events`, `ufc_bouts`, `ufc_bout_results`, `ufc_bout_round_stats`, `ufc_fighters` | ufc-stats-ingest |
| `ufc_ingest_runs` | every Worker appends its own run rows, keyed by `worker`. A run ledger is not shared ownership. |

## Worker → cron, dependencies, health

| Worker | cron | upstream | downstream |
|---|---|---|---|
| ufc-news-ingest | `*/2 * * * *` | RSS feeds | enrich, ticker |
| ufc-news-enrich | `*/5 * * * *` | ingest, stats, DNA, market, video, media | site, API, ticker |
| ufc-event-editorial | `15 */2 * * *`, `20 10 * * *` | stats, events, DNA | site, API |
| ufc-newsroom | `*/30 * * * *`, `15 */2 * * *`, `20 10 * * *` | run ledger | operators |
| ufc-stats-ingest | `*/15 * * * *` | UFCStats, ESPN | DNA, fight-state, enrich |
| ufc-fight-state | `23 * * * *` | events, bouts, results, DNA, rankings | DNA trigger |
| ufc-intelligence | `25 11 * * *` (rankings), `17 7 * * *` (Fight DNA) | stats, results | enrich, site, fight-state |
| ufc-video-autopilot | `13,43 * * * *` | official YouTube channels | enrich |
| ufc-media | `40 9 * * *` | Wikidata, Commons | enrich, site |
| ufc-history-watchdog | `20 7 * * *` | events, bouts | operators |
| propbetedge-ufc-api | none (request-driven) | all tables | site, external consumers |

## Known exceptions — stated, not hidden

**History repair execution is manual.** `ufc-history-watchdog` detects gaps and
**cannot fix one**. Repair is `.github/workflows/history-gap-repair.yml`, manual
dispatch only, running 2,585 lines of validated BeautifulSoup/lxml parsers that
write into the canonical event/bout/result/round tables. A second, unvalidated
JavaScript parser in front of the sport's history is a worse risk than a manual
step, and there is currently nothing to repair: 788 completed UFCStats-linked
events, zero missing bouts. If gaps reappear, porting those parsers becomes its
own validated project. **Do not describe this lane as autonomous repair.**

**`ufc_news_sources` has one scheduled writer and one manual one.**
ufc-newsroom's `sources` phase reconciles the feed registry on its daily slot.
ufc-news-ingest can also write it, but only through `POST /admin/verify?apply`,
which is operator-triggered. One schedule, one owner.

**ufc-event-editorial is dormant until `OPENAI_API_KEY` is set on it.** The
shared writer falls back to a deterministic template when no model is
configured, and for these story types templates *publish* — unlike external
drafts, which are held private. Rather than replace Sol-written previews with
template prose, the lane refuses to write and reports
`status: no_editorial_provider`. Set the secret to activate it.

## Fight-state ledger corrections

The ledger is append-only by trigger. A row that should not stand is invalidated
by a **later** row naming it in `provenance.correction.invalidates_ledger_id`,
never by UPDATE or DELETE.

- **Effective ledger** — excludes invalidated rows. Used by idempotence and by
  every product and API read. This is the default.
- **Raw ledger** — everything ever written. `GET /ledger?event=<id>&audit=true`.

This matters because a checkpoint is captured once per (bout, checkpoint): a bad
row would otherwise suppress the genuine capture permanently. Thirteen rows
written outside their window on 2026-09-10 were neutralised this way, and the
real `t_minus_24h` capture remains eligible.

## Legacy GitHub workflows

| workflow | state |
|---|---|
| newsroom.yml | disabled_manually |
| fight-state-ledger.yml | disabled_manually |
| fight-dna-build.yml | disabled_manually |
| video-autopilot.yml | disabled_manually |
| history-gap-repair.yml | schedule removed; manual dispatch retained as the repair tool |
| fight-dna-history-repair.yml | no schedule; manual dispatch only |

All remaining workflows are push- or dispatch-triggered (deploys, canaries, QA).
None schedules production ingestion or orchestration.
