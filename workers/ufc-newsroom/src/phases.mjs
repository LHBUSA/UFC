/* The five newsroom phases.
 *
 * The editorial product is NOT reimplemented here. Source verification, ingest,
 * the core article writer, the bettor-first feature writer and the editorial
 * desk are the same modules the CLI runs — scripts/news/*.mjs — imported and
 * called with the Worker's bindings injected. That is deliberate: dedupe,
 * fighter and event linking, qualification, fact-block construction and
 * hashing, create/refresh semantics, editorial gates, review-queue behaviour,
 * source attribution, bettor-angle and market-watch logic and the licensed-
 * media rules stay in one implementation.
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

export { anthropicConfigured };

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
 * Third-party RSS/news items are newsroom inputs, not PropBetEdge publications.
 * They remain available to the live wire, fighter-status machinery and source
 * provenance, but the scheduled article writer may only publish stories that
 * originate in PropBetEdge's verified fight state: previews, results and card
 * changes. Outside reporting can be cited as evidence inside owned reporting;
 * it cannot become a standalone referral article.
 */
function writerOptions(env, now) {
  return {
    llm: anthropicConfigured(env),
    now,
    types: 'preview,results,card_change',
  };
}

/**
 * Write new core articles, then immediately synthesize the higher-order bettor
 * layer from those published first-party fact blocks.
 *
 * Ordering matters. Features must see the freshest preview/result packets from
 * this same invocation. The feature writer is deterministic, idempotent and
 * never reads RSS rows directly.
 */
export async function runWrite(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const opts = writerOptions(env, now);
  const result = await writeArticles(env, opts);
  const features = await writeFeatures(env, { now });
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
    enhancement: result?.llm ? 'anthropic offered' : 'deterministic only',
  };
}

/**
 * Baseline refresh.
 *
 * Refresh core packets first, then refresh any automated guide/reset whose
 * source hashes changed. A manual/editor-written feature wins: the feature
 * writer detects it and does not publish a competing automated story.
 */
export async function runRefresh(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const result = await writeArticles(env, writerOptions(env, now));
  const features = await writeFeatures(env, { now });
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
  };
}

/** Daily editorial sweep — the real desk pass, not a report about one. */
export async function runSweep(env, sb, { now = Date.now(), limit, recentHours, force } = {}) {
  const held = await sb.count('ufc_articles', 'needs_human=is.true');
  const published = await sb.count('ufc_articles', 'status=eq.published');

  if (!anthropicConfigured(env)) {
    return {
      status: 'no_provider',
      review_queue: held ?? 0,
      published: published ?? 0,
      note: 'ANTHROPIC_API_KEY not configured; the desk polished nothing. Publication does not depend on it.',
    };
  }

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
