/* The five newsroom phases.
 *
 * The editorial product is NOT reimplemented here. Source verification, ingest,
 * the article writer and the editorial desk are the same modules the CLI runs —
 * scripts/news/{seed_sources,ingest_news,write_articles,polish_world_class}.mjs
 * — imported and called with the Worker's bindings injected. That is
 * deliberate: dedupe, fighter and event linking, qualification, fact-block
 * construction and hashing, create/refresh semantics, editorial gates,
 * review-queue behaviour, source attribution, bettor-angle and market-watch
 * logic and the licensed-media rules are thousands of lines of decided
 * editorial policy, and a port that retyped them would be a rewrite wearing a
 * port's clothes. Rewriting them would drift; importing them cannot.
 *
 * What this file owns is orchestration: which phase, with what options,
 * counted how, and failing how.
 *
 * HOW OPTIONS REACH THE SCRIPTS, and why it is not how it was. This file used
 * to set process.argv around each call, because the scripts read their flags
 * from argv. They read them at MODULE SCOPE, into constants, at import time —
 * so assigning process.argv afterwards could not change them. The Worker
 * believed it was enabling the writer's LLM path with `withArgv(['--llm'])`
 * and was not: the writer had already decided, once, when the isolate first
 * loaded it, that LLM was off. Every scheduled article was a template, and
 * nothing said so. The scripts now take an options argument, this file passes
 * one, and no global is mutated by anything here.
 */
import { main as seedSources } from '../../../scripts/news/seed_sources.mjs';
import { main as ingestNews } from '../../../scripts/news/ingest_news.mjs';
import { main as writeArticles } from '../../../scripts/news/write_articles.mjs';
import { main as polishArticles } from '../../../scripts/news/polish_world_class.mjs';
import { isConfigured as anthropicConfigured } from '../../../scripts/news/anthropic.mjs';

export { anthropicConfigured };

/* Counters are read back from the database rather than parsed out of stdout.
 * The workflow scraped `inserted=N` from a log line with grep and defaulted to
 * 0 when the pattern moved, which silently disabled the writer gate. A count
 * that is measured cannot drift from the thing it counts. */
async function newsItemCount(sb) { return (await sb.count('ufc_news_items')) ?? 0; }
async function articleCount(sb) { return (await sb.count('ufc_articles')) ?? 0; }

/**
 * Verify every configured RSS feed and reconcile ufc_news_sources.
 *
 * The GitHub workflow ran seed_sources.mjs before every ingest and the first
 * Worker draft dropped it, which is a quiet loss rather than a loud one:
 * ingest reads `enabled=true` and asks no questions, so a feed that has moved
 * or died stays enabled and contributes nothing. The newsroom then looks like
 * it is having a slow week. Two of the five sources already carry an alternate
 * URL for exactly this reason.
 *
 * One dead source must not stop the healthy ones: verifySources resolves each
 * source independently and records a failure rather than throwing.
 */
export async function runSources(env, sb) {
  const r = await seedSources(env, {});
  return { verified: r.verified, dropped: r.dropped, disabled: r.disabled, enabled_total: r.enabled_total };
}

/**
 * Pull every enabled source into ufc_news_items.
 *
 * One malformed or dead source must not stop the healthy ones: that isolation
 * lives inside ingest_news.mjs, which counts `failed` per source and
 * continues. This phase fails only if the whole pass throws.
 */
export async function runIngest(env, sb, { now = Date.now() } = {}) {
  const before = await newsItemCount(sb);
  const totals = await ingestNews(env, { now });
  const after = await newsItemCount(sb);
  /* Measured against the table, not against what the script offered. */
  const inserted = Math.max(0, after - before);
  return { inserted, news_items_total: after, sources_fetched: totals?.fetched ?? null, sources_failed: totals?.failed ?? null };
}

/**
 * Options the scheduled writer runs with.
 *
 * Third-party RSS/news items are newsroom inputs, not PropBetEdge publications.
 * They remain available to the live wire, fighter-status machinery and source
 * provenance, but the scheduled article writer may only publish stories that
 * originate in PropBetEdge's verified fight state: previews, results and card
 * changes. A sourced outside report can still be cited inside one of those
 * stories when a verified fact packet supports the claim; it must never become
 * a standalone "Publisher X reports... read the original" article merely
 * because it appeared in an RSS feed.
 */
function writerOptions(env, now) {
  return {
    llm: anthropicConfigured(env),
    now,
    types: 'preview,results,card_change',
  };
}

/**
 * Write new articles from whatever is now in the tables.
 *
 * Called only from the single decision point in index.js.
 */
export async function runWrite(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const opts = writerOptions(env, now);
  const result = await writeArticles(env, opts);
  const after = await articleCount(sb);
  return {
    created: Math.max(0, after - before),
    articles_total: after,
    refreshed: result?.refreshed ?? null,
    held_for_review: result?.held_for_review ?? null,
    /* Recorded per run so a reader of the ledger can tell an all-template day
     * from an enhanced one without guessing from model_version. */
    enhancement: result?.llm ? 'anthropic offered' : 'deterministic only',
  };
}

/**
 * Baseline refresh.
 *
 * The same writer, run with nothing new to ingest. It is not a second writer
 * and not a different code path: create/refresh semantics and the fact-block
 * hash decide what actually changes, so an unchanged hash is a no-op and a
 * changed one is an intended refresh. This is why a two-hourly baseline is
 * safe to run even when nothing has happened.
 */
export async function runRefresh(env, sb, { now = Date.now() } = {}) {
  const before = await articleCount(sb);
  const result = await writeArticles(env, writerOptions(env, now));
  const after = await articleCount(sb);
  return { created: Math.max(0, after - before), articles_total: after, refreshed: result?.refreshed ?? null, mode: 'baseline' };
}

/**
 * Daily editorial sweep — the real desk pass, not a report about one.
 *
 * polish_world_class.mjs is now Worker-safe (nothing at import time, options
 * explicit, node:child_process loaded lazily inside the Copilot provider), so
 * this runs the actual editorial code with its actual gates. The Copilot
 * fallback is not offered: a Worker cannot spawn a process, and `allowCopilot`
 * is left false so the desk never tries and never claims a provider it does
 * not have.
 *
 * Deterministic when no model is configured: the desk returns `no_provider`,
 * polishes nothing, and this phase succeeds. Publication does not pass through
 * the desk, so its absence is not an outage — and its failure must never look
 * like one either, which is why `sweep` is last in the phase order and why a
 * throw here is contained by the caller rather than ending the run.
 */
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
    /* The desk fails closed when every candidate is held — a real signal, and
     * it carries its counters. Report it as a phase outcome rather than
     * letting an exception erase what the pass actually did. */
    if (e && e.deskResult) {
      return { status: 'all_held', review_queue: held ?? 0, published: published ?? 0, ...e.deskResult, error: String(e.message).slice(0, 200) };
    }
    throw e;
  }

  return { status: 'ran', review_queue: held ?? 0, published: published ?? 0, ...desk };
}
