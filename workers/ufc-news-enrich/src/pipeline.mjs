/* The article factory, one item at a time.
 *
 *   claim -> relevance -> primary entity -> source fetch -> UFC packet
 *         -> GPT-5.6 Sol -> deterministic validation -> dedupe -> hero
 *         -> status=review
 *
 * PUBLICATION IS DISABLED IN THIS BUILD. Everything this Worker writes lands at
 * status='review', which the site and the API already treat as private. The
 * pipeline is complete and the last flip is a config change, so the quality of
 * what it produces can be judged on real articles rather than promised.
 *
 * CONCURRENCY. Every stage transition is a conditional single-statement UPDATE
 * against ufc_news_items.state, so a duplicate queue delivery updates zero rows
 * and stops. Underneath that, ufc_articles_news_item_uniq permits at most one
 * article per wire item, which holds even if a consumer misbehaves.
 */
import { buildPacket, buildCachedPacket } from './packet.mjs';
import { writeArticle, isConfigured, DESK_VERSION, redactSecrets } from './editorial.mjs';
import { scoreRelevance } from './relevance.mjs';
import { resolvePrimary } from './entities.mjs';
import { fetchSource } from './source_fetch.mjs';
import { buildContentPlan, loadDna } from './content_plan.mjs';

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

export const WORKER = 'ufc-news-enrich';

/**
 * Ask ufc-video-autopilot which videos belong to this story.
 *
 * That lane owns discovery, classification and the relevance hierarchy; this
 * one asks and attaches what it is given. Duplicating the hierarchy here would
 * give two answers to one question, and the day they disagreed a page would
 * show a video the owner had already rejected.
 *
 * A failure is never fatal: video is one module of eleven, and an article
 * without it is a correct article.
 */
export async function resolveVideosFor(env, { fighterId, boutId, eventId, articleId, limit = 2 } = {}) {
  const q = new URLSearchParams();
  if (fighterId) q.set('fighter', fighterId);
  if (boutId) q.set('bout', boutId);
  if (eventId) q.set('event', eventId);
  if (articleId) q.set('article', articleId);
  if (![...q.keys()].length) return { videos: [], tier: null, reason: 'no subject to match on' };
  q.set('limit', String(limit));

  /* Service binding first. An HTTP call to the sibling's workers.dev hostname
   * loops back into THIS Worker -- same subdomain -- so it hit our own router
   * and returned our own 404 for every article, while the reason string
   * claimed the resolver had answered. The binding routes in-process and
   * cannot be intercepted by our own routes. */
  const path = `https://video/resolve?${q}`;
  try {
    const res = env.VIDEO
      ? await env.VIDEO.fetch(path)
      : await fetch(`${env.VIDEO_RESOLVER_URL || 'https://ufc-video-autopilot.sales-fd3.workers.dev'}/resolve?${q}`,
        { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { videos: [], tier: null, reason: `resolver http ${res.status}` };
    return await res.json();
  } catch (e) {
    return { videos: [], tier: null, reason: `resolver unavailable: ${String(e?.message || e).slice(0, 120)}` };
  }
}
const LEASE_MS = 6 * 60 * 1000;
const RELEVANCE_GATE = 3;
const ENTITY_CONFIDENCE_GATE = 0.6;
const MAX_ATTEMPTS = 3;

const nowIso = (t) => new Date(t).toISOString();

/** One stage row. This is the SLA instrument and the audit trail. */
async function event(sb, itemId, stage, status, detail, { started, detectedAt, articleId = null } = {}) {
  try {
    await sb.insert('ufc_news_pipeline_events', [{
      news_item_id: itemId,
      article_id: articleId,
      stage,
      status,
      latency_ms: started ? Date.now() - started : null,
      since_detect_ms: detectedAt ? Date.now() - Date.parse(detectedAt) : null,
      worker: WORKER,
      detail,
    }]);
  } catch { /* telemetry must never be the reason an article fails */ }
}

/**
 * Take exclusive ownership of an item.
 *
 * Atomic in Postgres: the WHERE clause carries the expected state, so of two
 * consumers exactly one updates a row and the other sees zero and stops.
 */
export async function claim(sb, itemId, { from = ['new', 'scored'], now = Date.now() } = {}) {
  const token = crypto.randomUUID();
  const rows = await sb.patchReturning('ufc_news_items',
    `id=eq.${itemId}&state=in.(${from.join(',')})`,
    {
      state: 'enriching',
      lease_token: token,
      lease_expires_at: nowIso(now + LEASE_MS),
      last_attempt_at: nowIso(now),
      state_changed_at: nowIso(now),
    });
  if (!rows?.length) return null;

  /* PATCH...returning gives back BASE COLUMNS ONLY - an embedded resource like
   * source:ufc_news_sources(name) does not survive it. pickCandidates selects
   * the join, claim throws it away, and the publisher silently becomes null.
   *
   * That is not cosmetic. The class-B rule requires the source to be named in
   * the same sentence as its number, so a null publisher produced the failure
   * 'class B number "332" comes only from null, so that sentence must name
   * null' - an unsatisfiable instruction that held finished articles. One
   * lookup restores it. */
  const item = { ...rows[0], lease_token: token };
  if (!item.source && item.source_id) {
    const src = await sb.select('ufc_news_sources', `select=name,url&id=eq.${item.source_id}&limit=1`);
    if (src?.[0]) item.source = src[0];
  }
  return item;
}

/** Settle an item, but only if we still hold the lease we claimed it with. */
async function settle(sb, item, state, reason, extra = {}) {
  const rows = await sb.patchReturning('ufc_news_items',
    `id=eq.${item.id}&lease_token=eq.${item.lease_token}`,
    {
      state,
      state_reason: reason ? String(reason).slice(0, 500) : null,
      state_changed_at: nowIso(Date.now()),
      lease_token: null,
      lease_expires_at: null,
      ...extra,
    });
  return Boolean(rows?.length);
}

/** Candidates, freshest first. Cross-sport rows are state='skipped' and unreachable. */
export async function pickCandidates(sb, { limit = 5 } = {}) {
  return sb.select('ufc_news_items',
    `select=id,title,url,summary,published_at,detected_at,taxonomy,fighter_ids,bout_id,event_id,`
    + `state,attempts,relevance_score,primary_fighter_id,source_id,source:ufc_news_sources(name,url)`
    + `&state=in.(new,scored)&attempts=lt.${MAX_ATTEMPTS}`
    /* Newest by PUBLISHER time, not by detection time. The 14-day backfill was
     * all detected in one burst and shares a single detected_at, so ordering by
     * detection puts two hundred historical rows level with live news.
     * published_at is what actually separates them. */
    + `&order=published_at.desc.nullslast,detected_at.desc&limit=${limit}`);
}

/** Items whose consumer died mid-flight. */
export async function reclaimStalled(sb, { now = Date.now() } = {}) {
  const rows = await sb.select('ufc_news_items',
    `select=id,attempts&state=eq.enriching&lease_expires_at=lt.${encodeURIComponent(nowIso(now))}&limit=10`);
  for (const r of rows) {
    const next = (r.attempts ?? 0) >= MAX_ATTEMPTS ? 'failed' : 'new';
    await sb.patch('ufc_news_items', `id=eq.${r.id}&state=eq.enriching`, {
      state: next,
      state_reason: next === 'failed'
        ? `abandoned after ${r.attempts} attempts; lease expired with no result`
        : 'lease expired, returned to the queue',
      lease_token: null, lease_expires_at: null, state_changed_at: nowIso(now),
    });
  }
  return rows.length;
}


/* How old a story may be and still publish itself.
 *
 * The 217-item backlog was ingested in one burst from a 14-day window, so every
 * row in it looks freshly DETECTED. Publisher time is the only field that tells
 * a live development from a fortnight-old one, and going live must not mean
 * dumping a fortnight of archive onto the front page at once. */
const GREEN_MAX_SOURCE_AGE_HOURS = 24;

/**
 * Does this article publish itself?
 *
 * Every condition is ANDed and every failure is named, because "held" without a
 * reason is the failure mode this project exists to remove. A false here is not
 * an error - it is an article that goes to review and waits for a human, which
 * is the correct outcome for anything the pipeline cannot fully vouch for.
 */
/**
 * The pre-Sol governor: everything we can rule out for free.
 *
 * WHY THESE THREE AND NOT MORE
 *
 * A check earns a place here only if it is deterministic, reads a column that
 * already exists at detection time, and mirrors a rule the pipeline enforces
 * anyway. Anything needing the scorer, the roster resolver or the fetched body
 * stays downstream where it belongs. This is a cost gate, not an editorial one,
 * and it must never be the reason a publishable story is dropped.
 *
 * MEASURED WASTE THIS RECOVERS (48h of live traffic, 194 Sol calls, 8 published)
 *   34 calls  stale sources rejected AFTER the article was written
 *   27 calls  items with no roster fighter linked at detection
 *   ~11 calls obvious same-subject duplicates
 */
/* Published GPT-5.6 Sol pricing, per million tokens. Kept here rather than in a
 * config so a price change is a reviewed code change: a silently edited
 * constant would rewrite every historical cost figure in the ledger. */
export const SOL_USD_PER_MTOK = { input: 1.25, output: 10.00 };

export function estimateCostUsd(c = {}) {
  const inTok = (c.sol_input_tokens || 0) + (c.retry_input_tokens || 0);
  const outTok = (c.sol_output_tokens || 0) + (c.retry_output_tokens || 0);
  return Math.round(((inTok / 1e6) * SOL_USD_PER_MTOK.input + (outTok / 1e6) * SOL_USD_PER_MTOK.output) * 1e6) / 1e6;
}

/**
 * One cost record per item, whatever the outcome.
 *
 * Written for HELD items too, and that is the point: spend on articles that
 * never publish is the number worth watching, and a ledger that only records
 * successes would report a perfect cost per article while the waste stayed
 * invisible. Rides on ufc_news_pipeline_events, which already exists, so this
 * needs no migration and no new table to keep in sync.
 */
export async function recordCost(sb, item, { stage, outcome, holdReason = null, cost = null, article = null, detectedAt = null, publishedAt = null, solCalls = null }) {
  const c = cost || {};
  /* ufc_news_pipeline_events constrains stage and status to a fixed vocabulary,
   * and 'cost' is not in it -- these inserts were failing silently, swallowed by
   * the telemetry try/catch that exists so a ledger write can never break an
   * article. So the record wears an ALLOWED stage and status, and carries
   * detail.kind='cost' as its own marker. Widening the CHECK would be tidier
   * and is a migration; this needs none and keeps the constraint meaningful. */
  const ledgerStage = outcome === 'published' ? 'publish' : outcome === 'rejected_before_model' ? 'skip' : 'hold';
  const ledgerStatus = outcome === 'published' ? 'ok' : outcome === 'rejected_before_model' ? 'skipped' : 'held';
  return event(sb, item.id, ledgerStage, ledgerStatus, {
    kind: 'cost',
    outcome,
    stage,
    article_type: article?.story_type || null,
    source_count: item.url ? 1 : 0,
    sol_input_tokens: c.sol_input_tokens || 0,
    sol_output_tokens: c.sol_output_tokens || 0,
    retry_input_tokens: c.retry_input_tokens || 0,
    retry_output_tokens: c.retry_output_tokens || 0,
    model_calls: solCalls != null ? solCalls : (c.model_calls || 0),
    estimated_model_cost_usd: estimateCostUsd(c),
    hold_reason: holdReason ? String(holdReason).slice(0, 240) : null,
    detected_at: detectedAt || item.detected_at || null,
    published_at: publishedAt || null,
  }, {});
}

/**
 * Record that another outlet reported the same development.
 *
 * Stored on the canonical article so the page can say "also reported by", and
 * so a reader can see that a claim rests on more than one newsroom. Capped and
 * deduplicated by URL: this is corroboration, not a link farm, and the same
 * outlet republishing its own story must not count twice.
 *
 * Never throws. A failure to record corroboration must not turn a correctly
 * deduplicated item into an error.
 */
export async function addCorroboration(sb, canonical, item) {
  const fb = canonical.fact_block || {};
  const existing = Array.isArray(fb.corroboration) ? fb.corroboration : [];
  const url = String(item.url || '').trim();
  if (!url) return existing.length + 1;
  const already = existing.some((c) => c.url === url)
    || String(fb.source?.url || '') === url;
  if (already || existing.length >= 6) return existing.length + 1;

  const entry = {
    publisher: item.source?.name || domainOf(url) || 'another outlet',
    url,
    title: String(item.title || '').slice(0, 200),
    published_at: item.published_at || null,
  };
  try {
    await sb.patch('ufc_articles', `id=eq.${canonical.id}`, {
      fact_block: { ...fb, corroboration: [...existing, entry] },
      updated_at: new Date().toISOString(),
    });
  } catch { /* corroboration is additive context, never a reason to fail */ }
  return existing.length + 2;   /* the original report plus what is now stored */
}

export function preflight(item, { now = Date.now() } = {}) {
  /* 1. THE SOURCE-AGE RULE, MOVED IN FRONT OF THE MODEL.
   *
   * greenPath already refuses to auto-publish a story whose source is older
   * than GREEN_MAX_SOURCE_AGE_HOURS -- but it runs AFTER writeArticle, so a
   * 108-hour-old backlog row paid for a full Sol generation and a retry before
   * being told it could never publish. The age is knowable at claim time from
   * a column, and it cannot improve while the item waits. Same rule, same
   * constant, evaluated where it is free.
   *
   * Backlog is not discarded -- it lands in the same reviewed state it reached
   * before, just without the bill. */
  const published = item.published_at ? Date.parse(item.published_at) : NaN;
  if (Number.isFinite(published)) {
    const ageH = (now - published) / 3600000;
    if (ageH > GREEN_MAX_SOURCE_AGE_HOURS) {
      return {
        ok: false, state: 'held', saved: 2,
        reason: `source is ${Math.round(ageH)}h old (> ${GREEN_MAX_SOURCE_AGE_HOURS}h); backlog is reviewed, never auto-published — stopped before any model call`,
      };
    }
  }

  /* 2. NO ROSTER FIGHTER LINKED AT DETECTION.
   *
   * ufc-news-ingest resolves fighter_ids when it inserts the row. An empty
   * array means its resolver found nobody on our roster in the headline or
   * summary, and resolvePrimary reads the same roster from the same index --
   * so it is about to reach the same conclusion after a flagship call.
   *
   * Measured: 27 of 44 entity holds had an empty array, and NONE of the eight
   * published articles did. The signal is one-directional, which is what makes
   * it safe to act on early: an empty array has never produced a publication.
   *
   * This is deliberately not a claim that the story is unimportant. It stays on
   * the external wire, which is exactly what the wire is for. */
  const linked = Array.isArray(item.fighter_ids) ? item.fighter_ids.filter(Boolean) : [];
  if (!linked.length) {
    return {
      ok: false, state: 'held', saved: 1,
      reason: 'no roster fighter linked at detection; not enriched — remains external wire coverage',
      patch: { entity_confidence: 0 },
    };
  }

  return { ok: true };
}

export function greenPath({ env, rel, ent, src, packet, article, hero, item, now = Date.now() }) {
  const blockers = [];

  if (!publishEnabledFor(env)) blockers.push('PUBLISH_ENABLED is false');
  if (!(rel.score >= RELEVANCE_GATE)) blockers.push(`relevance ${rel.score} < ${RELEVANCE_GATE}`);
  if (rel.degraded) blockers.push('relevance scorer was degraded; the score is a default, not a judgement');
  if (!ent.primary_fighter_id) blockers.push('no primary fighter');
  if (!(ent.confidence >= ENTITY_CONFIDENCE_GATE)) blockers.push(`entity confidence ${ent.confidence} < ${ENTITY_CONFIDENCE_GATE}`);

  /* A blocked or thin source is a REVIEW article, always. An article written
   * from first-party data alone can be accurate and still be the wrong thing to
   * publish automatically: the news peg itself is unverified by us. This is the
   * condition most likely to be quietly relaxed to raise volume, so it is
   * stated as its own blocker rather than folded into a score. */
  if (!src.ok) blockers.push(`source not fetched (${src.status_class}${src.status ? ` ${src.status}` : ''})`);
  else if (!src.text || src.text.length < 600) blockers.push(`source body too thin (${src.text?.length || 0} chars)`);

  if (!packet?.primary) blockers.push('packet has no primary profile');
  if (!article?.validation?.ok) blockers.push('deterministic validators did not pass');
  /* A corrective retry is NOT a blocker.
   *
   * It was one briefly, on the reasoning that a gate having something to say
   * deserved a human glance. That was wrong in a way worth naming: the retry
   * exists precisely to fix a gate failure, and attempt two is held to every
   * identical check that attempt one failed - the same validators, the same
   * provenance rules, the same freshness and dedupe and entity thresholds.
   * Holding a clean article because an earlier draft was not clean punishes the
   * mechanism for working. The fact is recorded instead, so the rate stays
   * visible and a rising one can be investigated. */

  /* Hero is valid or deliberately absent. Never wrong: pickHero keys on
   * primary_fighter_id and refuses incomplete credit, so a present hero is
   * correct by construction and a null one is an honest omission. */
  if (hero && !(hero.credit?.author && hero.credit?.license && hero.credit?.source_url)) {
    blockers.push('hero image lacks complete credit');
  }

  const publishedAt = item.published_at ? Date.parse(item.published_at) : null;
  if (!publishedAt) blockers.push('source carries no publication timestamp, so its age cannot be established');
  else {
    const ageH = (now - publishedAt) / 3600e3;
    if (ageH > GREEN_MAX_SOURCE_AGE_HOURS) {
      blockers.push(`source is ${Math.round(ageH)}h old (> ${GREEN_MAX_SOURCE_AGE_HOURS}h); backlog is reviewed, never auto-published`);
    }
  }

  return { publish: blockers.length === 0, blockers, corrective_retry: (article?.attempts || 1) > 1 };
}

const publishEnabledFor = (env) => String(env.PUBLISH_ENABLED || 'false').toLowerCase() === 'true';

/**
 * Run one item end to end.
 *
 * Every early return settles the item with a reason a human can read. An item
 * that stops moving without a reason is the failure mode this whole project
 * exists to remove.
 */
export async function processItem(sb, env, itemId, { now = Date.now(), publish = false } = {}) {
  const t0 = Date.now();
  const item = await claim(sb, itemId, { now });
  if (!item) return { item_id: itemId, status: 'not_claimed', note: 'another consumer owns it, or it is already settled' };

  const detectedAt = item.detected_at;
  const log = (stage, status, detail, started) => event(sb, item.id, stage, status, detail, { started, detectedAt });

  try {
    /* 0. COST GOVERNOR — DECIDE WHAT WE CAN AFFORD TO THINK ABOUT ------- */
    /*
     * Every stage below this one costs money. The relevance scorer runs on
     * GPT-5.6 Sol because no cheaper model exists on this account, so an item
     * that reaches stage 1 has already spent a flagship call -- and measured
     * over 48 hours of live traffic, 92% of Sol calls went to items that never
     * published. That is not a quality problem and must not be fixed by
     * lowering quality: it is a SELECTION problem.
     *
     * So the cheap deterministic facts are consulted first. Every check here
     * uses a column ufc-news-ingest already wrote, needs no model, and asks a
     * question whose answer cannot change later in the pipeline. Nothing here
     * is a new editorial gate -- each one mirrors a rule that already exists
     * downstream, moved to where it costs nothing.
     */
    const pre = preflight(item, { now });
    if (!pre.ok) {
      await log('skip', 'skipped', { gate: 'governor', reason: pre.reason, saved_sol_calls: pre.saved }, Date.now());
      await settle(sb, item, pre.state, pre.reason, pre.patch || {});
      await recordCost(sb, item, { stage: 'governor', outcome: 'rejected_before_model', holdReason: pre.reason, solCalls: 0, detectedAt });
      return { item_id: item.id, status: pre.state, stage: 'governor', reason: pre.reason, sol_calls: 0 };
    }

    /* 1. RELEVANCE ------------------------------------------------------ */
    let t = Date.now();
    const rel = await scoreRelevance(env, item);
    await log('score', rel.score >= RELEVANCE_GATE ? 'ok' : 'skipped', rel, t);
    if (rel.score < RELEVANCE_GATE) {
      await settle(sb, item, 'skipped', `relevance ${rel.score}: ${rel.reason}`,
        { relevance_score: rel.score, relevance_reason: rel.reason, story_kind: rel.story_kind });
      return { item_id: item.id, status: 'skipped', stage: 'relevance', score: rel.score, reason: rel.reason };
    }

    /* 2. PRIMARY ENTITY ------------------------------------------------- */
    t = Date.now();
    const ent = await resolvePrimary(sb, env, item, rel);
    await log('resolve', ent.primary_fighter_id ? 'ok' : 'held', ent, t);
    if (!ent.primary_fighter_id || ent.confidence < ENTITY_CONFIDENCE_GATE) {
      await settle(sb, item, 'held',
        `primary subject uncertain (confidence ${ent.confidence.toFixed(2)}): ${ent.reason}`,
        {
          relevance_score: rel.score, relevance_reason: rel.reason, story_kind: rel.story_kind,
          primary_fighter_id: ent.primary_fighter_id, secondary_fighter_ids: ent.secondary_fighter_ids,
          mentioned_fighter_ids: ent.mentioned_fighter_ids, entity_confidence: ent.confidence,
        });
      return { item_id: item.id, status: 'held', stage: 'entity', reason: ent.reason };
    }

    /* 3. SOURCE FETCH ---------------------------------------------------- */
    t = Date.now();
    const src = await fetchSource(item.url);
    await log('fetch', src.ok ? 'ok' : 'failed', { status: src.status, chars: src.text?.length || 0, error: src.error }, t);

    /* 4. UFC INTELLIGENCE PACKET ----------------------------------------- */
    t = Date.now();
    const enriched = { ...item, primary_fighter_id: ent.primary_fighter_id, relevance_score: rel.score, story_kind: rel.story_kind };
    const { packet, cached: packetCached, age_ms: packetAgeMs } = await buildCachedPacket(sb, env, enriched, {
      now,
      sourceExcerpt: src.ok ? src.text : null,
      sourceMeta: src.ok
        ? {
          /* Never null. An unattributable source excerpt makes every class-B
           * number unusable, so the domain is a worse name than the real one
           * and a far better one than nothing. */
          publisher: item.source?.name || domainOf(item.url) || 'the original report',
          url: item.url, published_at: item.published_at, title: src.title,
        }
        : null,
    });
    const families = ['primary', packet.opponent && 'opponent', packet.bout && 'bout',
      packet.primary?.round_data && 'round_data', packet.primary?.rankings && 'rankings',
      packet.market?.odds_status === 'available' && 'market', packet.source && 'source'].filter(Boolean);
    await log('packet', 'ok', { families, edges: packet.edges.length, odds: packet.market?.odds_status, cached: packetCached, cache_age_ms: packetAgeMs ?? null }, t);

    /* Thin evidence is a reason to stop, not a reason to pad. Without a fetched
     * source AND without round-level data there is nothing here that a database
     * row does not already say. */
    if (!src.ok && !packet.primary?.round_data && !packet.bout) {
      await settle(sb, item, 'held', 'evidence too thin: source unfetchable and no first-party depth to build on',
        { relevance_score: rel.score, primary_fighter_id: ent.primary_fighter_id,
          source_fetch_status: src.status_class, entity_confidence: ent.confidence });
      return { item_id: item.id, status: 'held', stage: 'packet', reason: 'thin evidence' };
    }

    /* 5. DEDUPE ---------------------------------------------------------- */
    t = Date.now();
    const signature = `ufc:${rel.story_kind}:${ent.primary_fighter_id}`;
    const since = nowIso(now - 24 * 3600 * 1000);
    const canon = await sb.select('ufc_articles',
      `select=id,slug,headline,published_at,fact_block&topic_signature=eq.${encodeURIComponent(signature)}`
      + `&created_at=gte.${encodeURIComponent(since)}&limit=1`);
    if (canon.length) {
      /* A SECOND REPORT STRENGTHENS THE STORY RATHER THAN DISAPPEARING.
       *
       * Five outlets covering one development used to produce one article and
       * four rows marked 'duplicate', and the corroboration -- genuinely useful
       * information, since independent reports of the same development is
       * exactly what makes a story solid -- was thrown away.
       *
       * The canonical article now records who else reported it. This costs no
       * model call and creates no near-duplicate article, which is the point:
       * updating what we already published is better than writing it again,
       * and far better than discarding the evidence. The prose is untouched;
       * only the attribution list grows. */
      const corroborated = await addCorroboration(sb, canon[0], item);
      await log('dedupe', 'skipped', { signature, canonical: canon[0].slug, corroborating_sources: corroborated }, t);
      await settle(sb, item, 'duplicate', `corroborates ${canon[0].slug} (now ${corroborated} independent reports)`,
        { topic_signature: signature, canonical_article_id: canon[0].id,
          relevance_score: rel.score, primary_fighter_id: ent.primary_fighter_id });
      await recordCost(sb, item, { stage: 'dedupe', outcome: 'held', holdReason: `corroborates ${canon[0].slug}`, solCalls: 1, detectedAt });
      return { item_id: item.id, status: 'duplicate', canonical: canon[0].slug, corroborating_sources: corroborated };
    }
    await log('dedupe', 'ok', { signature }, t);

    /* 6. EDITORIAL ------------------------------------------------------- */
    if (!isConfigured(env)) {
      await settle(sb, item, 'held', 'OPENAI_API_KEY not configured');
      return { item_id: item.id, status: 'held', stage: 'editorial', reason: 'no api key' };
    }
    t = Date.now();
    let article;
    try {
      article = await writeArticle(env, packet, { minWords: 500 });
    } catch (e) {
      await log('editorial', 'held', { error: redactSecrets(String(e.message)).slice(0, 600), validation: e.validation }, t);
      await settle(sb, item, 'held', redactSecrets(String(e.message)).slice(0, 480),
        { relevance_score: rel.score, primary_fighter_id: ent.primary_fighter_id, topic_signature: signature });
      /* The most expensive failure in the system: a full generation plus a
       * corrective retry, thrown away. Counted deliberately. */
      await recordCost(sb, item, { stage: 'editorial', outcome: 'held', holdReason: e.message, cost: e.cost, detectedAt });
      return { item_id: item.id, status: 'held', stage: 'editorial', reason: redactSecrets(String(e.message)).slice(0, 240) };
    }
    const genMs = Date.now() - t;
    await log('editorial', 'ok', { model: article.model, attempts: article.attempts, words: article.body_md.split(/\s+/).length }, t);
    await log('validate', 'ok', { failures: [] });

    /* 7. HERO ------------------------------------------------------------ */
    t = Date.now();
    const hero = await pickHero(sb, ent.primary_fighter_id);
    await log('media', hero ? 'ok' : 'skipped', hero || { reason: 'no rights-cleared portrait for the primary subject' }, t);

    /* 8. CONTENT PLAN ---------------------------------------------------- */
    /* Deterministic, and deliberately AFTER the narrative. The model wrote
     * prose from the packet and never sees this stage, so no chart series can
     * originate from it. Video is ASKED of ufc-video-autopilot rather than
     * decided here, because that lane owns resolution. */
    t = Date.now();
    const fighterIds = [ent.primary_fighter_id, ...(ent.secondary_fighter_ids || [])].filter(Boolean);
    const dna = await loadDna(sb, fighterIds).catch(() => new Map());
    const videos = await resolveVideosFor(env, {
      fighterId: ent.primary_fighter_id,
      boutId: packet.bout?.bout_id || item.bout_id || null,
      eventId: packet.bout?.event?.id || item.event_id || null,
    });
    const plan = await buildContentPlan(sb, { packet, article, hero, videos, dna });
    await log('media', 'ok', {
      modules: plan.module_ids, charts: plan.chart_count,
      video_tier: plan.video_tier, omitted: plan.omitted.map((x) => x.id),
    }, t);

    /* 8. WRITE, PRIVATE -------------------------------------------------- */
    /* THE GREEN PATH. Publication is decided per article, from what actually
     * happened to it, not from a global switch. The switch is one of the
     * conditions. */
    const green = greenPath({ env, rel, ent, src, packet, article, hero, item, now });
    const publishThis = green.publish;
    await log('validate', green.publish ? 'ok' : 'held',
      { green_path: green.publish, blockers: green.blockers, corrective_retry: green.corrective_retry });

    const slug = slugify(article.headline);
    const row = {
      slug,
      headline: article.headline,
      dek: article.dek,
      body_md: article.body_md,
      story_type: 'external',
      /* The whole point. Publication is a separate, later decision. */
      status: publishThis ? 'published' : 'review',
      needs_human: !publishThis,
      hold_reason: publishThis ? null : green.blockers.join('; ').slice(0, 480),
      fact_block: { ...packet, bettor_angle: article.bettor_angle, content_plan: plan },
      sources: [{ kind: 'news_item', id: item.id, url: item.url },
        { kind: 'packet', version: packet.version, families },
        { kind: 'content_plan', version: plan.version, modules: plan.module_ids }],
      fighter_ids: [ent.primary_fighter_id, ...ent.secondary_fighter_ids].filter(Boolean),
      primary_fighter_id: ent.primary_fighter_id,
      bout_id: packet.bout?.bout_id || item.bout_id || null,
      event_id: packet.bout?.event?.id || item.event_id || null,
      news_item_id: item.id,
      relevance_score: rel.score,
      topic_signature: signature,
      source_body_hash: src.hash || null,
      validation: { ok: true, failures: [], gate: DESK_VERSION, green_path: green.publish, blockers: green.blockers, corrective_retry: green.corrective_retry },
      model_version: `openai:${article.model}/${DESK_VERSION}`,
      hero_image_ref: hero?.id || null,
      hero_credit: hero?.credit || null,
      published_at: publishThis ? nowIso(Date.now()) : null,
      first_published_at: publishThis ? nowIso(Date.now()) : null,
      updated_at: nowIso(Date.now()),
    };

    let saved;
    try {
      saved = (await sb.insert('ufc_articles', [row]))?.[0];
    } catch (e) {
      /* The unique index did its job: another consumer got here first. */
      await settle(sb, item, 'duplicate', `article already exists for this item: ${String(e.message).slice(0, 200)}`);
      return { item_id: item.id, status: 'duplicate', reason: 'unique index rejected a second article' };
    }

    await settle(sb, item, publishThis ? 'published' : 'held',
      publishThis ? null : green.blockers.join('; ').slice(0, 480),
      {
        article_id: saved?.id || null, relevance_score: rel.score, relevance_reason: rel.reason,
        story_kind: rel.story_kind, primary_fighter_id: ent.primary_fighter_id,
        secondary_fighter_ids: ent.secondary_fighter_ids, mentioned_fighter_ids: ent.mentioned_fighter_ids,
        entity_confidence: ent.confidence, topic_signature: signature,
        source_fetch_status: src.status_class, source_body_hash: src.hash || null,
        source_body: src.ok ? src.text.slice(0, 60000) : null,
        source_fetched_at: src.ok ? nowIso(Date.now()) : null,
        first_published_at: publishThis ? nowIso(Date.now()) : null,
      });
    await log('publish', publishThis ? 'ok' : 'held',
      { slug, status: row.status, article_id: saved?.id, blockers: green.blockers,
        detected_to_public_ms: publishThis && detectedAt ? Date.now() - Date.parse(detectedAt) : null,
        total_ms: Date.now() - t0 }, t0);

    await recordCost(sb, item, {
      stage: 'publish', outcome: publishThis ? 'published' : 'held',
      holdReason: publishThis ? null : (green.blockers || []).join('; '),
      cost: article.cost, article, detectedAt,
      publishedAt: publishThis ? nowIso(Date.now()) : null,
    });

    return {
      item_id: item.id, status: publishThis ? 'published' : 'written', slug, article_id: saved?.id,
      cost: article.cost, estimated_model_cost_usd: estimateCostUsd(article.cost),
      green_path: publishThis, blockers: green.blockers,
      detected_to_public_ms: publishThis && detectedAt ? Date.now() - Date.parse(detectedAt) : null,
      headline: article.headline, words: article.body_md.split(/\s+/).length,
      model: article.model, attempts: article.attempts,
      primary: packet.primary?.name, source: item.source?.name,
      generation_ms: genMs, total_ms: Date.now() - t0,
    };
  } catch (e) {
    await log('error', 'failed', { error: redactSecrets(String(e?.message || e)).slice(0, 600) }, t0);
    const attempts = (item.attempts ?? 0);
    await settle(sb, item, attempts >= MAX_ATTEMPTS ? 'failed' : 'new', redactSecrets(String(e?.message || e)).slice(0, 480));
    return { item_id: item.id, status: 'error', error: redactSecrets(String(e?.message || e)).slice(0, 300) };
  }
}

/**
 * Hero image for the PRIMARY subject and nobody else.
 *
 * A comparison fighter's portrait on a story about someone else is the exact
 * failure the entity work exists to prevent, and it is the most visible one.
 * Incomplete credit means no image rather than an uncredited one.
 */
export async function pickHero(sb, fighterId) {
  const rows = await sb.select('ufc_images',
    `select=id,r2_key,license,author,source_url,kind&fighter_id=eq.${fighterId}&order=created_at.desc&limit=5`);
  for (const img of rows) {
    if (img.license && img.author && img.source_url) {
      return { id: img.id, r2_key: img.r2_key, credit: { author: img.author, license: img.license, source_url: img.source_url } };
    }
  }
  return null;
}

export function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
