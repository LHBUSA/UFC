/* One ingest run: fetch every healthy feed, filter, link entities, insert.
 *
 * WHAT THIS OWNS AND WHAT IT DELIBERATELY DOES NOT
 *
 * Owns: cadence, feed health, conditional fetching, the UFC-focus filter, the
 * initial candidate state, detected_at, and a detect event per accepted item.
 *
 * Does not own: relevance scoring, source-page fetching, the intelligence
 * packet, editorial, validation, publication. Nothing in this Worker calls a
 * model or writes ufc_articles. It is the detection half of the pipeline and
 * ends at a row in ufc_news_items.
 *
 * ON RUNNING ALONGSIDE THE EXISTING NEWSROOM INGEST
 *
 * ufc-newsroom's `ingest` phase writes the same table every 30 minutes and is
 * still running. That is intentional for this phase: the new path is proven
 * against production traffic before anything is switched off. Two writers are
 * safe here because the table's own unique constraints decide the winner -
 * ufc_news_items.url and .fingerprint - and both writers offer identical rows
 * built by the SAME linkEntities and classify functions, imported from
 * scripts/news rather than reimplemented. Whichever writer sees an item first
 * inserts it; the other's insert is ignored.
 *
 * The one difference is state. This Worker sets it deliberately from the focus
 * filter; the newsroom script does not set it at all and takes the column
 * default, 'new'. So an item the newsroom happens to see first is 'new' even if
 * it is boxing. That is harmless while the queue producer is disabled and
 * nothing consumes 'new', and it is one of the reasons the newsroom's ingest
 * phase is retired in Phase 7 rather than left running forever.
 */
import { parseFeed, parseDate, sha256, domainOf, classify, loadFighterIndex } from '../../../scripts/news/lib.mjs';
import { normalize } from '../../../shared/alias_resolver.mjs';
import { linkEntities, loadEventContext } from '../../../scripts/news/ingest_news.mjs';
import { classifyFocus, initialState } from './ufc_focus.mjs';
import {
  loadHealth, saveHealth, isInCooldown, shouldHalfOpen, onSuccess, onFailure,
} from './feed_health.mjs';

export const WORKER = 'ufc-news-ingest';
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_AGE_DAYS = 14;
const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeUFCBot/1.0; +https://ufc.propbetedge.ai)';

const fingerprintOf = (title, url) => sha256(`${normalize(title)}|${domainOf(url)}`);

/**
 * A KV handle that reads normally and refuses to write.
 *
 * Used only for dry runs. Writes are counted and dropped rather than thrown,
 * deliberately: saveHealth swallows its own errors by design (health is an aid,
 * not a gate), so a throw here would be silently absorbed and prove nothing. A
 * counter surfaces in the dry-run result instead, where a human and a test can
 * both see it.
 */
export function countingReadOnlyKV(kv, counter) {
  if (!kv) return kv;
  return {
    get: (...args) => kv.get(...args),
    list: (...args) => kv.list(...args),
    getWithMetadata: (...args) => kv.getWithMetadata?.(...args),
    put: async () => { counter.attempted += 1; },
    delete: async () => { counter.attempted += 1; },
  };
}

/**
 * Fetch one feed, honouring its circuit and its cached validators.
 *
 * Never throws. A feed that cannot be reached is a fact about that feed, and
 * one dead feed must not cost the other fourteen their run.
 */
export async function fetchFeed(env, source, { now = Date.now() } = {}) {
  const health = await loadHealth(env.UFC_NEWS_KV, source.name);
  const result = {
    source: source.name, url: source.url, status: null, latency_ms: null,
    items: [], skipped: null, not_modified: false, error: null,
  };

  if (isInCooldown(health, now)) {
    result.skipped = `circuit open, ${Math.round((health.cooldown_until_ts - now) / 60000)}m remaining`;
    return { result, health, changed: false };
  }
  const halfOpen = shouldHalfOpen(health, now);

  const headers = { 'User-Agent': USER_AGENT };
  /* Conditional request. A 304 costs the origin almost nothing and costs us no
   * parse at all, which is what makes a two-minute cadence defensible. */
  if (health.last_etag) headers['If-None-Match'] = health.last_etag;
  if (health.last_modified) headers['If-Modified-Since'] = health.last_modified;

  const started = Date.now();
  try {
    const res = await fetch(source.url, {
      headers, redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    result.latency_ms = Date.now() - started;
    result.status = res.status;

    if (res.status === 304) {
      result.not_modified = true;
      onSuccess(health, now, { latencyMs: result.latency_ms, notModified: true });
      return { result, health, changed: true };
    }
    if (!res.ok) {
      result.error = `http ${res.status}`;
      onFailure(health, now, result.error, { wasHalfOpen: halfOpen });
      return { result, health, changed: true };
    }

    const body = await res.text();
    result.items = parseFeed(body);
    if (!result.items.length) {
      /* A 200 that parses to nothing is a failure of the feed, not a quiet day.
       * Counting it as success is how a feed that started returning an HTML
       * error page stays "healthy" forever. */
      result.error = 'no items parsed';
      onFailure(health, now, result.error, { wasHalfOpen: halfOpen });
      return { result, health, changed: true };
    }
    onSuccess(health, now, {
      latencyMs: result.latency_ms,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    });
    return { result, health, changed: true };
  } catch (e) {
    result.latency_ms = Date.now() - started;
    result.error = e?.name === 'TimeoutError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : `fetch error: ${String(e?.message || e).slice(0, 160)}`;
    onFailure(health, now, result.error, { wasHalfOpen: halfOpen });
    return { result, health, changed: true };
  }
}

/**
 * One run.
 *
 * Feeds are fetched in parallel with a hard per-fetch timeout, so wall clock is
 * the slowest feed rather than the sum. The database work that follows is
 * sequential and small.
 */
export async function runIngest(env, sb, { now = Date.now(), dry = false } = {}) {
  const started = Date.now();
  const sources = await sb.select(
    'ufc_news_sources',
    'select=id,name,url,weight&kind=eq.rss&enabled=is.true&order=name.asc',
  );
  if (!sources.length) {
    return { status: 'no_sources', sources: 0, note: 'no enabled rss source; run /admin/verify first' };
  }

  /* DRY MODE PERSISTS NOTHING.
   *
   * This is not a tidiness rule, it is a bug that already cost us items. Feed
   * health carries the ETag and Last-Modified validators, so persisting it from
   * a dry run makes the NEXT REAL RUN conditional: the origin answers 304, and
   * the items the dry run just looked at are never inserted at all. On
   * 2026-09-09 a ?dry=true probe consumed Combat Press and LowKick MMA that way,
   * and their items reached the database only because a second, unconditional
   * writer happened to still be running. Once this Worker is the sole writer,
   * the same sequence loses them silently with every counter reporting success.
   *
   * The request itself is unchanged - a dry run still sends the stored
   * validators, because a dry run that fetches differently from a real run is
   * not previewing the real run. What changes is that nothing it learns is
   * written back.
   *
   * The counter below is the visible half of the guarantee: any future code
   * that tries to write KV during a dry run shows up in the result rather than
   * being swallowed by saveHealth's catch. */
  const kvWrites = { attempted: 0 };
  const kv = dry ? countingReadOnlyKV(env.UFC_NEWS_KV, kvWrites) : env.UFC_NEWS_KV;
  const fetchEnv = dry ? { ...env, UFC_NEWS_KV: kv } : env;

  const fetched = await Promise.all(sources.map((s) => fetchFeed(fetchEnv, s, { now })));
  await Promise.all(fetched.map(({ result, health, changed }) =>
    (changed && !dry) ? saveHealth(env.UFC_NEWS_KV, result.source, health) : null));

  const totals = {
    sources: sources.length, fetched_ok: 0, not_modified: 0, failed: 0, circuit_skipped: 0,
    parsed: 0, stale: 0, dup_in_run: 0, dup_in_db: 0,
    focus_rejected: 0, focus_by_reason: {}, candidates: 0, inserted: 0, errors: 0,
  };
  const perSource = [];
  const accepted = [];
  const seen = new Set();
  const cutoff = now - MAX_AGE_DAYS * 86400e3;

  /* Entity context is loaded once per run, not once per item: the fighter index
   * is thousands of rows and the event window is a query. */
  const [index, ctx] = await Promise.all([loadFighterIndex(sb), loadEventContext(sb, now)]);

  for (const { result } of fetched) {
    const row = {
      source: result.source, status: result.status, latency_ms: result.latency_ms,
      parsed: result.items.length, fresh: 0, focus_rejected: 0, candidates: 0,
      not_modified: result.not_modified, skipped: result.skipped, error: result.error,
    };
    if (result.skipped) { totals.circuit_skipped += 1; perSource.push(row); continue; }
    if (result.not_modified) { totals.not_modified += 1; perSource.push(row); continue; }
    if (result.error) { totals.failed += 1; perSource.push(row); continue; }
    totals.fetched_ok += 1;
    totals.parsed += result.items.length;

    const src = sources.find((s) => s.name === result.source);
    for (const item of result.items) {
      if (!item.title || !item.link) continue;
      const published = parseDate(item.published);
      if (published && published.getTime() < cutoff) { totals.stale += 1; continue; }

      const fingerprint = fingerprintOf(item.title, item.link);
      if (seen.has(fingerprint) || seen.has(item.link)) { totals.dup_in_run += 1; continue; }
      seen.add(fingerprint); seen.add(item.link);
      row.fresh += 1;

      /* Entity linking comes FIRST, because the focus filter's strongest rule
       * is "names no fighter we have ever recorded". Two boxers in a headline
       * carrying no boxing keyword are invisible to a regex and obvious to the
       * fighter index. */
      const links = linkEntities({ title: item.title, summary: item.summary }, ctx, index, now);
      const taxonomy = classify(item.title, item.summary);
      const focus = classifyFocus(item.title, item.summary, {
        ufcFighterCount: links.fighter_ids.length,
        taxonomyLabels: taxonomy.labels,
      });
      const state = initialState(focus);
      if (!focus.ok) {
        totals.focus_rejected += 1;
        row.focus_rejected += 1;
        const k = `${focus.verdict}:${focus.reason}`;
        totals.focus_by_reason[k] = (totals.focus_by_reason[k] || 0) + 1;
      } else {
        row.candidates += 1;
        totals.candidates += 1;
      }

      accepted.push({
        row: {
          source_id: src ? src.id : null,
          url: item.link,
          title: item.title.slice(0, 500),
          published_at: published ? published.toISOString() : null,
          summary: item.summary || null,
          taxonomy,
          fighter_ids: links.fighter_ids,
          bout_id: links.bout_id,
          event_id: links.event_id,
          fingerprint,
          /* Owned by this Worker, and the reason it exists. */
          state: state.state,
          state_reason: state.state_reason,
          state_changed_at: new Date(now).toISOString(),
          detected_at: new Date(now).toISOString(),
        },
        focus,
        source_name: result.source,
      });
    }
    perSource.push(row);
  }

  if (dry) {
    return {
      status: 'dry_run', duration_ms: Date.now() - started, totals,
      /* Must be 0. Anything else means this dry run mutated operational state
       * and the next real fetch is compromised. */
      kv_writes_attempted: kvWrites.attempted,
      per_source: perSource,
      would_insert: accepted.map((a) => ({
        source: a.source_name, state: a.row.state, reason: a.row.state_reason,
        fighters: a.row.fighter_ids.length, title: a.row.title.slice(0, 90),
      })),
    };
  }

  /* Which rows are NEW is the only number worth reporting, and it can only be
   * learned from the database: a fingerprint we have never seen in this run may
   * still have been inserted by the newsroom's own ingest thirty seconds ago.
   * Asking first also keeps the detect events honest - an event per offered row
   * would report the same story as freshly detected on every single run. */
  const known = new Set();
  for (let i = 0; i < accepted.length; i += 40) {
    const batch = accepted.slice(i, i + 40);
    const fps = batch.map((a) => a.row.fingerprint).join(',');
    const rows = await sb.select('ufc_news_items', `select=fingerprint,url&fingerprint=in.(${fps})`);
    for (const r of rows) { known.add(r.fingerprint); known.add(r.url); }
  }
  const fresh = accepted.filter((a) => !known.has(a.row.fingerprint) && !known.has(a.row.url));
  totals.dup_in_db = accepted.length - fresh.length;

  if (fresh.length) {
    try {
      totals.inserted = await sb.insertIgnoringDuplicates('ufc_news_items', fresh.map((a) => a.row));
    } catch (e) {
      totals.errors += 1;
      totals.insert_error = String(e?.message || e).slice(0, 240);
    }
  }

  /* One detect event per newly detected item. This is the start of the SLA
   * clock, and the only place it is ever written. */
  if (totals.inserted > 0) {
    const inserted = await sb.select(
      'ufc_news_items',
      `select=id,fingerprint,detected_at&fingerprint=in.(${fresh.map((a) => a.row.fingerprint).join(',')})`,
    );
    const byFingerprint = new Map(inserted.map((r) => [r.fingerprint, r]));
    const events = [];
    for (const a of fresh) {
      const item = byFingerprint.get(a.row.fingerprint);
      if (!item) continue;
      events.push({
        news_item_id: item.id,
        stage: 'detect',
        status: a.focus.ok ? 'ok' : 'skipped',
        latency_ms: Date.now() - started,
        since_detect_ms: 0,
        worker: WORKER,
        detail: {
          source: a.source_name,
          feed_published_at: a.row.published_at,
          /* How far behind the publisher we were. The part of the SLA we do not
           * control, measured so it is never confused with the part we do. */
          publisher_lag_ms: a.row.published_at ? now - Date.parse(a.row.published_at) : null,
          focus: a.focus.verdict,
          focus_reason: a.focus.reason,
          foreign_promotions: a.focus.foreign,
          taxonomy: a.row.taxonomy?.labels?.slice(0, 3) || [],
          fighters_linked: a.row.fighter_ids.length,
          bout_linked: Boolean(a.row.bout_id),
          event_linked: Boolean(a.row.event_id),
        },
      });
    }
    if (events.length) {
      try { await sb.insert('ufc_news_pipeline_events', events); }
      catch (e) { totals.errors += 1; totals.event_error = String(e?.message || e).slice(0, 200); }
    }
  }

  return { status: 'ran', duration_ms: Date.now() - started, totals, per_source: perSource };
}
