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
import { buildPacket } from './packet.mjs';
import { writeArticle, isConfigured, DESK_VERSION, redactSecrets } from './editorial.mjs';
import { scoreRelevance } from './relevance.mjs';
import { resolvePrimary } from './entities.mjs';
import { fetchSource } from './source_fetch.mjs';

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

export const WORKER = 'ufc-news-enrich';
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
    + `&state=in.(new,scored)&attempts=lt.${MAX_ATTEMPTS}&order=detected_at.desc&limit=${limit}`);
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
    const packet = await buildPacket(sb, enriched, {
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
    await log('packet', 'ok', { families, edges: packet.edges.length, odds: packet.market?.odds_status }, t);

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
      `select=id,slug,headline,published_at&topic_signature=eq.${encodeURIComponent(signature)}`
      + `&created_at=gte.${encodeURIComponent(since)}&limit=1`);
    if (canon.length) {
      await log('dedupe', 'skipped', { signature, canonical: canon[0].slug }, t);
      await settle(sb, item, 'duplicate', `same topic as ${canon[0].slug} within 24h`,
        { topic_signature: signature, canonical_article_id: canon[0].id,
          relevance_score: rel.score, primary_fighter_id: ent.primary_fighter_id });
      return { item_id: item.id, status: 'duplicate', canonical: canon[0].slug };
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
      return { item_id: item.id, status: 'held', stage: 'editorial', reason: redactSecrets(String(e.message)).slice(0, 240) };
    }
    const genMs = Date.now() - t;
    await log('editorial', 'ok', { model: article.model, attempts: article.attempts, words: article.body_md.split(/\s+/).length }, t);
    await log('validate', 'ok', { failures: [] });

    /* 7. HERO ------------------------------------------------------------ */
    t = Date.now();
    const hero = await pickHero(sb, ent.primary_fighter_id);
    await log('media', hero ? 'ok' : 'skipped', hero || { reason: 'no rights-cleared portrait for the primary subject' }, t);

    /* 8. WRITE, PRIVATE -------------------------------------------------- */
    const slug = slugify(article.headline);
    const row = {
      slug,
      headline: article.headline,
      dek: article.dek,
      body_md: article.body_md,
      story_type: 'external',
      /* The whole point. Publication is a separate, later decision. */
      status: publish ? 'published' : 'review',
      needs_human: !publish,
      hold_reason: publish ? null : 'publication disabled in this build; awaiting quality sign-off',
      fact_block: { ...packet, bettor_angle: article.bettor_angle },
      sources: [{ kind: 'news_item', id: item.id, url: item.url },
        { kind: 'packet', version: packet.version, families }],
      fighter_ids: [ent.primary_fighter_id, ...ent.secondary_fighter_ids].filter(Boolean),
      primary_fighter_id: ent.primary_fighter_id,
      bout_id: packet.bout?.bout_id || item.bout_id || null,
      event_id: packet.bout?.event?.id || item.event_id || null,
      news_item_id: item.id,
      relevance_score: rel.score,
      topic_signature: signature,
      source_body_hash: src.hash || null,
      validation: { ok: true, failures: [], gate: DESK_VERSION },
      model_version: `openai:${article.model}/${DESK_VERSION}`,
      hero_image_ref: hero?.id || null,
      hero_credit: hero?.credit || null,
      published_at: publish ? nowIso(Date.now()) : null,
      first_published_at: publish ? nowIso(Date.now()) : null,
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

    await settle(sb, item, publish ? 'published' : 'held',
      publish ? null : 'article written and privately staged for review',
      {
        article_id: saved?.id || null, relevance_score: rel.score, relevance_reason: rel.reason,
        story_kind: rel.story_kind, primary_fighter_id: ent.primary_fighter_id,
        secondary_fighter_ids: ent.secondary_fighter_ids, mentioned_fighter_ids: ent.mentioned_fighter_ids,
        entity_confidence: ent.confidence, topic_signature: signature,
        source_fetch_status: src.status_class, source_body_hash: src.hash || null,
        source_body: src.ok ? src.text.slice(0, 60000) : null,
        source_fetched_at: src.ok ? nowIso(Date.now()) : null,
        first_published_at: publish ? nowIso(Date.now()) : null,
      });
    await log('publish', publish ? 'ok' : 'held',
      { slug, status: row.status, article_id: saved?.id, total_ms: Date.now() - t0 }, t0);

    return {
      item_id: item.id, status: 'written', slug, article_id: saved?.id,
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
