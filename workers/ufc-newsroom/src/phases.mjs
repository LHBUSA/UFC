/* The five newsroom phases.
 *
 * The editorial product is NOT reimplemented here. Source verification, ingest,
 * the core article writer, the bettor-first feature writer and the established
 * Anthropic editorial desk are the same modules the CLI runs — scripts/news/*.mjs
 * — imported and called with the Worker's bindings injected. The OpenAI desk is
 * Worker-native because the Cloudflare scheduler is the production owner and
 * OpenAI is its primary editorial provider.
 *
 * What this file owns is orchestration: which phase, with what options,
 * counted how, and failing how.
 */
import { main as seedSources } from '../../../scripts/news/seed_sources.mjs';
import { main as writeArticles } from '../../../scripts/news/write_articles.mjs';
import { main as writeFeatures } from '../../../scripts/news/write_features.mjs';
import { main as polishArticles } from '../../../scripts/news/polish_world_class.mjs';
import { isConfigured as anthropicConfigured } from '../../../scripts/news/anthropic.mjs';
import {
  runOpenAIEditorial,
  isConfigured as openaiConfigured,
  DEFAULT_MODEL as DEFAULT_OPENAI_MODEL,
} from './openai_editorial.mjs';

export { anthropicConfigured, openaiConfigured, DEFAULT_OPENAI_MODEL };

export function editorialConfigured(env) {
  return openaiConfigured(env) || anthropicConfigured(env);
}

export function editorialProvider(env) {
  if (openaiConfigured(env)) {
    return `openai:${env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL}`;
  }
  if (anthropicConfigured(env)) return 'anthropic';
  return 'deterministic';
}

/* Counters are read back from the database rather than parsed out of stdout. */
async function newsItemCount(sb) { return (await sb.count('ufc_news_items')) ?? 0; }
async function articleCount(sb) { return (await sb.count('ufc_articles')) ?? 0; }

/** Verify every configured RSS feed and reconcile ufc_news_sources. */
export async function runSources(env, sb) {
  const r = await seedSources(env, {});
  return { verified: r.verified, dropped: r.dropped, disabled: r.disabled, enabled_total: r.enabled_total };
}

/** Pull every enabled source into ufc_news_items. */
export async function runIngest(env, sb, { now = Date.now() } = {}) {
  /* RETIRED AS A WRITER 2026-09-09. This phase now OBSERVES the wire; it does
   * not fill it. ufc-news-ingest is the sole writer to ufc_news_items.
   *
   * WHY THE WRITER HAD TO GO, and it is not tidiness. Two writers were filling
   * one table with different semantics:
   *
   *   ufc-news-ingest   applies the UFC-focus filter, so a boxing item lands
   *                     state='skipped' and can never be scored; stamps one
   *                     detected_at per poll; writes a detect event.
   *   this path         applied no focus filter, so every row it wrote was
   *                     state='new' - the column default - and therefore
   *                     ENRICHMENT-ELIGIBLE regardless of what sport it was
   *                     about; took the per-row now() default; wrote no event.
   *
   * On 2026-09-09 that produced 22 unfiltered rows in one six-second burst at
   * 23:01Z against 214 filtered ones. Harmless while nothing consumed them, and
   * a direct route to GPT-5.6 Sol spend on boxing the moment ufc-news-enrich
   * starts reading state='new'.
   *
   * The control plane still wants to KNOW about the wire - freshness is a
   * health signal and this phase is where the ledger records it - so it reports
   * what the sole writer has done rather than doing it again. */
  const total = await newsItemCount(sb);
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const recent = await sb.count('ufc_news_items', `detected_at=gte.${encodeURIComponent(since)}`);
  const scoreable = await sb.count('ufc_news_items', 'state=eq.new');
  return {
    writer: 'ufc-news-ingest',
    retired_here: true,
    inserted: 0,
    news_items_total: total,
    detected_last_hour: recent ?? null,
    scoreable_backlog: scoreable ?? null,
  };
}

/**
 * Options the scheduled core writer runs with.
 *
 * The legacy writer's optional inline rewrite is still Anthropic-specific.
 * When only OPENAI_API_KEY is configured the core writer stays deterministic,
 * then the OpenAI desk below polishes the published fact-block article through
 * the same fail-closed publication posture. That keeps the writer authoritative
 * and avoids passing an OpenAI credential into an Anthropic transport.
 */
function writerOptions(env, now) {
  return {
    llm: anthropicConfigured(env),
    now,
    /* NO `external`. ONE OWNER PER WRITE RESPONSIBILITY.
     *
     * ufc-news-enrich owns news articles written from wire items: relevance,
     * entity resolution, a first-party packet, GPT-5.6 Sol, the two-class
     * number gate and the green path. This Worker was still producing its own
     * `external` articles beside them -- 21 in three days, none of them
     * published, all of them the deterministic template, because the writer
     * falls back to the template whenever the rewrite provider is unavailable
     * and ANTHROPIC_API_KEY is not set here.
     *
     * Two writers of one story type is the condition the architecture forbids,
     * and template externals are the thin articles that are not to be
     * published at all. Removing the type costs nothing: not one of them ever
     * reached a reader.
     *
     * preview, results and card_change stay. Those are event-level coverage
     * that enrich does not write, so they are this Worker's own responsibility
     * rather than a second copy of somebody else's. */
    types: 'preview,results,card_change',
  };
}

async function openAIEnhancement(env, sb, {
  now = Date.now(),
  limit = 12,
  recentHours = 72,
  force = false,
  maxPolish = 1,
} = {}) {
  if (!openaiConfigured(env)) {
    return { status: 'not_configured', provider: null, candidates: 0, passed: 0, skipped: 0, held: 0 };
  }

  try {
    return await runOpenAIEditorial(env, sb, { now, limit, recentHours, force, maxPolish });
  } catch (e) {
    if (e && e.deskResult) {
      return { status: 'all_held', ...e.deskResult, error: String(e.message).slice(0, 200) };
    }
    throw e;
  }
}

/**
 * Write new core articles, then immediately synthesize the higher-order bettor
 * layer, then offer the freshest published packets to OpenAI when configured.
 *
 * OpenAI is idempotent: articles already stamped by the OpenAI desk are skipped,
 * so a no-change 30-minute run does not repeatedly spend model tokens.
 */
/* ARTICLE GENERATION MOVED TO ufc-event-editorial ON 2026-09-10.
 *
 * runWrite, runRefresh and runSweep lived here and produced fight_preview,
 * results, card_change and rankings articles, the automated feature layer and
 * the editorial polish pass. A Worker documented as the control plane was the
 * second writer of ufc_articles, and for story_type='external' it was a
 * duplicate of ufc-news-enrich outright.
 *
 * The writers themselves did not change and were not copied: scripts/news/*
 * is still the single implementation, now called by ufc-event-editorial, which
 * holds the schedule for it.
 *
 * This Worker writes no articles. If that ever needs to change, it should be a
 * deliberate decision recorded here rather than a phase quietly reappearing.
 */
