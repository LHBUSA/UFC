/* The four newsroom phases.
 *
 * The editorial product is NOT reimplemented here. Ingest and the article
 * writer are the same modules the CLI runs — scripts/news/ingest_news.mjs and
 * scripts/news/write_articles.mjs — imported and called with the Worker's
 * bindings injected. That is deliberate: source verification, dedupe, fighter
 * and event linking, qualification, fact-block construction and hashing,
 * create/refresh semantics, editorial gates, review-queue behaviour, source
 * attribution, bettor-angle and market-watch logic and the licensed-media
 * rules are thousands of lines of decided editorial policy, and a port that
 * retyped them would be a rewrite wearing a port's clothes. Rewriting them
 * would drift; importing them cannot.
 *
 * What this file owns is orchestration: which phase, with what arguments,
 * counted how, and failing how.
 *
 * The one piece genuinely replaced is the editorial enhancement provider. The
 * old path shelled out to a globally installed GitHub Copilot CLI with
 * spawnSync and the Actions GITHUB_TOKEN; a Worker has neither, and a
 * production newsroom should not depend on an npm binary being installable at
 * run time. anthropic.mjs speaks the raw Messages API over fetch instead, and
 * is optional in the strongest sense: the deterministic article is written and
 * stored regardless, so no model outage, timeout, refusal or gate rejection
 * can stop a verified article being published.
 */
import { main as ingestNews } from '../../../scripts/news/ingest_news.mjs';
import { main as writeArticles } from '../../../scripts/news/write_articles.mjs';
import { isConfigured as anthropicConfigured } from './anthropic.mjs';

/* The CLI reads its flags from process.argv at module scope. Under
 * nodejs_compat that array exists but is empty, which yields exactly the
 * defaults the scheduled workflow used: not a dry run, every story type, the
 * default limit. Where a phase needs a different shape it says so below and
 * sets argv before the call rather than forking the module's option handling,
 * because two divergent flag parsers is how behaviour drifts apart. */
function withArgv(flags, fn) {
  const had = typeof process !== 'undefined' && Array.isArray(process.argv);
  if (!had) return fn();
  const saved = process.argv;
  process.argv = [saved[0] || 'workerd', 'worker-phase', ...flags];
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.argv = saved; });
}

/* Counters are read back from the database rather than parsed out of stdout.
 * The workflow scraped `inserted=N` from a log line with grep and defaulted to
 * 0 when the pattern moved, which silently disabled the writer gate. A count
 * that is measured cannot drift from the thing it counts. */
async function newsItemCount(sb) { return (await sb.count('ufc_news_items')) ?? 0; }
async function articleCount(sb) { return (await sb.count('ufc_articles')) ?? 0; }

/**
 * Pull every enabled source into ufc_news_items.
 *
 * One malformed or dead source must not stop the healthy ones: that isolation
 * lives inside ingest_news.mjs, which already counts `failed` per source and
 * continues. This phase fails only if the whole pass throws.
 */
export async function runIngest(env, sb) {
  const before = await newsItemCount(sb);
  await withArgv([], () => ingestNews(env));
  const after = await newsItemCount(sb);
  const inserted = Math.max(0, after - before);
  return { inserted, news_items_total: after };
}

/**
 * Write new articles from whatever is now in the tables.
 *
 * Called only from the single decision point in index.js, never on its own
 * schedule, so two writers cannot overlap by construction.
 */
export async function runWrite(env, sb) {
  const before = await articleCount(sb);
  const flags = anthropicConfigured(env) ? ['--llm'] : [];
  await withArgv(flags, () => writeArticles(env));
  const after = await articleCount(sb);
  return {
    created: Math.max(0, after - before),
    articles_total: after,
    /* Recorded per run so a reader of the ledger can tell an all-template day
     * from an enhanced one without guessing from model_version. */
    enhancement: anthropicConfigured(env) ? 'anthropic offered' : 'deterministic only',
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
export async function runRefresh(env, sb) {
  const before = await articleCount(sb);
  const flags = anthropicConfigured(env) ? ['--llm'] : [];
  await withArgv(flags, () => writeArticles(env));
  const after = await articleCount(sb);
  return { created: Math.max(0, after - before), articles_total: after, mode: 'baseline' };
}

/**
 * Daily editorial sweep.
 *
 * Deliberately NOT a port of polish_world_class.mjs. That module's provider
 * layer is Copilot CLI over spawnSync, which cannot exist in a Worker, and its
 * Anthropic path is entangled with that fallback. Rather than half-port it and
 * claim a fidelity this does not have, the sweep currently reports what the
 * quality pass would cover and performs no model calls.
 *
 * This is the one place where behaviour is knowingly not yet at parity, and it
 * is reported rather than disguised: the sweep is the polish layer, not the
 * publication layer, so the newsroom is fully functional without it while it
 * is finished against the real editorial gates.
 */
export async function runSweep(env, sb) {
  const held = await sb.count('ufc_articles', 'needs_human=is.true');
  const published = await sb.count('ufc_articles', 'status=eq.published');
  return {
    status: 'reporting_only',
    review_queue: held ?? 0,
    published: published ?? 0,
    anthropic_configured: anthropicConfigured(env),
    note: 'Editorial polish pass not yet ported from polish_world_class.mjs; its provider layer is Copilot CLI over spawnSync and has no Worker equivalent. Publication does not depend on it.',
  };
}
