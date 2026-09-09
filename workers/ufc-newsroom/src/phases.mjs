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
import { main as ingestNews } from '../../../scripts/news/ingest_news.mjs';
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
  const before = await newsItemCount(sb);
  const totals = await ingestNews(env, { now });
  const after = await newsItemCount(sb);
  const inserted = Math.max(0, after - before);
  return { inserted, news_items_total: after, sources_fetched: totals?.fetched ?? null, sources_failed: totals?.failed ?? null };
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
    types: 'preview,results,card_change',
  };
}

async function openAIEnhancement(env, sb, {
  now = Date.now(),
  limit = 12,
  recentHours = 72,
  force = false,
} = {}) {
  if (!openaiConfigured(env)) {
    return { status: 'not_configured', provider: null, candidates: 0, passed: 0, skipped: 0, held: 0 };
  }

  try {
    return await runOpenAIEditorial(env, sb, { now, limit, recentHours, force });
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
export async function runWrite(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const opts = writerOptions(env, now);
  const result = await writeArticles(env, opts);
  const features = await writeFeatures(env, { now });
  const openai = await openAIEnhancement(env, sb, { now, limit: 12, recentHours: 72 });
  const after = await articleCount(sb);

  return {
    created: Math.max(0, after - before),
    articles_total: after,
    refreshed: result?.refreshed ?? null,
    held_for_review: result?.held_for_review ?? null,
    features: {
      candidates: features?.candidates ?? 0,
      created: features?.created ?? 0,
      refreshed: features?.refreshed ?? 0,
      unchanged: features?.unchanged ?? 0,
      held: features?.held ?? 0,
    },
    enhancement: openaiConfigured(env)
      ? `openai:${env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL}`
      : (result?.llm ? 'anthropic offered' : 'deterministic only'),
    openai,
  };
}

/**
 * Baseline refresh.
 *
 * Refresh core packets first, refresh automated guides/resets, then run the
 * idempotent OpenAI enhancement over recently changed published packets.
 */
export async function runRefresh(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const result = await writeArticles(env, writerOptions(env, now));
  const features = await writeFeatures(env, { now });
  const openai = await openAIEnhancement(env, sb, { now, limit: 12, recentHours: 72 });
  const after = await articleCount(sb);

  return {
    created: Math.max(0, after - before),
    articles_total: after,
    refreshed: result?.refreshed ?? null,
    mode: 'baseline',
    features: {
      candidates: features?.candidates ?? 0,
      created: features?.created ?? 0,
      refreshed: features?.refreshed ?? 0,
      unchanged: features?.unchanged ?? 0,
      held: features?.held ?? 0,
    },
    openai,
  };
}

/** Daily editorial sweep — OpenAI primary, Anthropic fallback if configured. */
export async function runSweep(env, sb, { now = Date.now(), limit, recentHours, force } = {}) {
  const held = await sb.count('ufc_articles', 'needs_human=is.true');
  const published = await sb.count('ufc_articles', 'status=eq.published');

  if (openaiConfigured(env)) {
    try {
      const desk = await runOpenAIEditorial(env, sb, { now, limit, recentHours, force });
      return { status: 'ran', review_queue: held ?? 0, published: published ?? 0, ...desk };
    } catch (e) {
      if (!anthropicConfigured(env)) {
        if (e && e.deskResult) {
          return { status: 'all_held', review_queue: held ?? 0, published: published ?? 0, ...e.deskResult, error: String(e.message).slice(0, 200) };
        }
        throw e;
      }
      console.warn(`[ufc-newsroom] OpenAI sweep unavailable/held; falling back to Anthropic: ${String(e?.message || e).slice(0, 180)}`);
    }
  }

  if (anthropicConfigured(env)) {
    let desk;
    try {
      desk = await polishArticles(env, { now, limit, recentHours, force, allowCopilot: false });
    } catch (e) {
      if (e && e.deskResult) {
        return { status: 'all_held', review_queue: held ?? 0, published: published ?? 0, ...e.deskResult, error: String(e.message).slice(0, 200) };
      }
      throw e;
    }
    return { status: 'ran', review_queue: held ?? 0, published: published ?? 0, ...desk };
  }

  return {
    status: 'no_provider',
    review_queue: held ?? 0,
    published: published ?? 0,
    note: 'No OPENAI_API_KEY or ANTHROPIC_API_KEY configured; the desk polished nothing. Deterministic publication is unaffected.',
  };
}
