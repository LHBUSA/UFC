/* OpenAI editorial provider for the Cloudflare UFC newsroom.
 *
 * The deterministic PropBetEdge writer remains the source of truth. This desk
 * is an enhancement layer only: it may improve headline, dek, structure and
 * prose from the stored fact block + draft, and it fails closed when a model
 * introduces unsupported numbers, URLs, betting prices, model claims or thin
 * copy. Publication never depends on this provider being available.
 *
 * Raw fetch is used deliberately so this module runs in Cloudflare Workers
 * without adding an SDK dependency. OPENAI_API_KEY is read only from the
 * Worker binding. No key is ever logged.
 */

import {
  automaticEligibility,
  editorialDigest,
  inputEntry,
  modelVisibleSources,
  recordDecision,
  DIGEST_VERSION,
} from '../../../scripts/news/editorial_digest.mjs';

const API = 'https://api.openai.com/v1/responses';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
const DESK_VERSION = 'editorial-desk-openai-v1';
const DEFAULT_CALL_TIMEOUT_MS = 75 * 1000;
const DEFAULT_MAX_POLISH_PER_RUN = 4;
/* One automatic attempt, full stop (owner rule 2026-09-29). The corrective
 * second rewrite doubled the spend of every held article; only an explicit
 * admin re-edit or canary may ask for it. */
const AUTOMATIC_MAX_ATTEMPTS = 1;
const ADMIN_MAX_ATTEMPTS = 2;

/* NOMINAL standard list rates, USD per million tokens, for gpt-5.6-sol on the
 * Responses API. Nominal standard-rate estimate only; not evidence of actual
 * billing. Complimentary shared-token usage may apply subject to eligibility
 * and remaining daily allowance. */
export const NOMINAL_RATES_PER_MTOK = { input: 1.25, cached_input: 0.125, output: 10 };

export function nominalStandardCost(usage) {
  const input = Number(usage?.input_tokens) || 0;
  const cached = Number(usage?.input_tokens_details?.cached_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const usd = (Math.max(0, input - cached) * NOMINAL_RATES_PER_MTOK.input
    + cached * NOMINAL_RATES_PER_MTOK.cached_input
    + output * NOMINAL_RATES_PER_MTOK.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export const isConfigured = (env) => Boolean(env && env.OPENAI_API_KEY);

const SYSTEM = `You are the senior editor of PropBetEdge UFC, a premium bettor-facing combat-sports intelligence newsroom. You receive one complete SOURCE PACKET containing a deterministic draft and its machine-readable fact block. Turn it into publication-grade sports journalism without adding a single unsupported fact.

Editorial standard:
- Write like a top-tier sports/data magazine, not a database template.
- Open with the actual fight/result tension, not housekeeping.
- Translate evidence into fight meaning: range, pace, durability, finishing profile, control, recent form, stance/context and only the market categories already supported by the packet.
- Put Bettor's Edge into the journalism: what the evidence changes, what it does not prove, the counter-case, and what new information would change the read.
- Use short, varied paragraphs and descriptive Markdown H2 sections.
- Preserve useful internal Markdown links naturally.
- Never pad a thin source packet. Concise and exact beats invented depth.

Hard fact rules:
1. Use ONLY facts, names, dates, numbers, methods, records, locations, quotes, market categories and relationships contained in the SOURCE PACKET. No outside knowledge.
2. Never invent injuries, camp news, rankings, odds, prices, sportsbook availability, probabilities, model output, picks or predictions.
3. If odds_status/model_status is unavailable, never imply a price or model edge exists.
4. Preserve every record/sample/confidence caveat.
5. Preserve every existing Markdown link somewhere in body_md. Do not create new URLs.
6. Do not claim an edge unless the packet explicitly supports that wording.
7. Return only the requested structured fields.`;

const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    dek: { type: 'string' },
    body_md: { type: 'string' },
  },
  required: ['headline', 'dek', 'body_md'],
};

function wordCount(value) {
  const text = String(value || '').trim();
  return text ? text.split(/\s+/).length : 0;
}

function numTokens(text) {
  return new Set((String(text || '').match(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?(?![A-Za-z])/g) || [])
    .map((v) => v.replace(/^\+/, '')));
}

function links(text) {
  return new Set(String(text || '').match(/\[[^\]]+\]\((?:https?:\/\/[^)]+|\/[^)]+)\)/g) || []);
}

function urls(text) {
  return new Set((String(text || '').match(/https?:\/\/[^\s)\]}>'"]+/g) || [])
    .map((u) => u.replace(/[.,;:!?]+$/, '')));
}

function storyMinimum(article) {
  const cls = String(article.fact_block?.story_class || '');
  const short = Boolean(article.fact_block?.depth?.short);
  if (short) return Math.max(180, Math.floor(wordCount(article.body_md) * 0.8));
  if (article.story_type === 'results') return 800;
  if (article.story_type === 'fight_preview') {
    if (/main_event/.test(cls)) return 900;
    if (/main_card/.test(cls)) return 700;
    return 550;
  }
  if (article.story_type === 'card_change') return 450;
  if (article.story_type === 'external') return 180;
  return Math.max(250, Math.floor(wordCount(article.body_md) * 0.8));
}

function validate(source, out, article) {
  if (!out || typeof out !== 'object') return 'response is not an object';
  const headline = String(out.headline || '').trim();
  const dek = String(out.dek || '').trim();
  const body = String(out.body_md || '').trim();

  if (headline.length < 24 || headline.length > 150) return `headline length ${headline.length}`;
  if (dek.length < 35 || dek.length > 420) return `dek length ${dek.length}`;
  if (!body) return 'empty body';

  const allowedNumbers = numTokens(source);
  for (const n of numTokens(`${headline}\n${dek}\n${body}`)) {
    if (!allowedNumbers.has(n.replace(/^\+/, ''))) return `new number ${n}`;
  }

  const sourceUrls = urls(source);
  for (const u of urls(body)) if (!sourceUrls.has(u)) return `new URL ${u}`;

  const requiredLinks = links(article.body_md);
  const outputLinks = links(body);
  for (const l of requiredLinks) if (!outputLinks.has(l)) return `existing link removed: ${l.slice(0, 100)}`;

  const odds = article.fact_block?.bettor_angle?.odds_status || article.fact_block?.market_watch?.odds_status;
  const model = article.fact_block?.bettor_angle?.model_status || article.fact_block?.market_watch?.model_status;
  if (odds === 'unavailable' && /\b(?:-\d{3}|\+\d{3}|\$\d+(?:\.\d+)?)\b/.test(body)) return 'price-like claim while odds unavailable';
  if (model === 'unavailable' && /\b(?:our model (?:makes|prices|projects|gives)|model probability|fair price|model edge)\b/i.test(body)) return 'model claim while model unavailable';
  if (/\b(lock|guaranteed|sure thing|easy money)\b/i.test(body)) return 'prohibited certainty language';

  const words = wordCount(body);
  const minimum = storyMinimum(article);
  if (words < minimum) return `too short ${words} < ${minimum}`;
  if (words > 2100) return `too long ${words}`;

  const h2 = (body.match(/^##\s+/gm) || []).length;
  if ((article.story_type === 'fight_preview' || article.story_type === 'results') && h2 < 4) {
    return `not enough editorial sections (${h2})`;
  }

  const boiler = [
    'the question this preview works through is simple',
    "the tape's headline number",
    'this is a profile update, not a grade on the market',
  ];
  for (const phrase of boiler) {
    if (body.toLowerCase().includes(phrase)) return `template phrase retained: ${phrase}`;
  }

  return null;
}

function sourcePacket(article) {
  return JSON.stringify({
    article: {
      slug: article.slug,
      story_type: article.story_type,
      current_headline: article.headline,
      current_dek: article.dek,
      current_body_md: article.body_md,
    },
    fact_block: article.fact_block,
    /* Never the digest/decision entries: a hex digest is full of digits and
     * validate() treats every number in the packet as an allowed number. */
    sources: modelVisibleSources(article.sources),
  }, null, 2);
}

function acceptanceInstructions(article) {
  const minimum = storyMinimum(article);
  const requiresSections = article.story_type === 'fight_preview' || article.story_type === 'results';
  return `OUTPUT ACCEPTANCE FOR THIS STORY:\n- body_md must be at least ${minimum} words and no more than 2100 words.\n${requiresSections ? '- body_md must contain at least 4 meaningful Markdown H2 sections.\n' : ''}- Preserve all existing Markdown links exactly.\n- Meet the depth requirement only with evidence already in the SOURCE PACKET.\n- Use descriptive headings and a direct entity-led opening without keyword stuffing.`;
}

function correctionInstructions(problem) {
  return `CORRECTIVE REWRITE REQUIRED:\nThe previous draft was rejected by the deterministic publication gate for exactly this reason: ${problem}.\nRewrite from the SAME SOURCE PACKET and fix that failure without adding any fact, number, URL, relationship, odds, prediction or outside knowledge.`;
}

function extractOutputText(json) {
  const refusals = [];
  const text = [];
  for (const item of json?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'refusal' && part.refusal) refusals.push(String(part.refusal));
      if (part?.type === 'output_text' && part.text) text.push(String(part.text));
    }
  }
  if (refusals.length) throw new Error(`openai: refusal: ${refusals.join(' ').slice(0, 240)}`);
  const joined = text.join('').trim();
  if (!joined) throw new Error('openai: empty response');
  return joined;
}

export async function callOpenAI(apiKey, {
  model = DEFAULT_MODEL,
  instructions = SYSTEM,
  input,
  maxOutputTokens = 18000,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('openai: no API key');

  const safeTimeout = Math.min(120000, Math.max(5000, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
  let meta = { response_id: null, usage: null, model };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeout);

  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: 'medium' },
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: 'json_schema',
            name: 'ufc_editorial_article',
            strict: true,
            schema: ARTICLE_SCHEMA,
          },
        },
      }),
    });

    const json = await res.json().catch(() => ({}));
    /* Usage and response id travel with success AND failure: an incomplete or
     * refused response still spent tokens, and telemetry must see them. */
    meta = { response_id: json?.id || null, usage: json?.usage || null, model: json?.model || model };
    if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (json.status === 'incomplete') {
      const why = json.incomplete_details?.reason || 'unknown';
      throw new Error(`openai: incomplete response (${why})`);
    }
    if (json.status === 'failed') throw new Error(`openai: failed response: ${JSON.stringify(json.error || {}).slice(0, 240)}`);

    return { text: extractOutputText(json), ...meta };
  } catch (error) {
    const out = controller.signal.aborted ? new Error(`openai: timeout after ${safeTimeout}ms`) : error;
    if (out && typeof out === 'object') out.openaiMeta = meta;
    throw out;
  } finally {
    clearTimeout(timer);
  }
}

const TRIGGERS = new Set(['new_story', 'admin_reedit', 'canary']);

/**
 * One telemetry record per OpenAI request, in the network contract's field
 * names. Written by the caller-supplied sink IMMEDIATELY after the request
 * returns (or fails), never batched at the end of a pass: a pass that dies
 * half-way must still have recorded what it spent.
 */
export function modelCallRecord({ worker, article, digest, trigger, routingReason, attempt, meta, requestedModel, latencyMs, status, now = Date.now() }) {
  const usage = meta?.usage || null;
  return {
    kind: 'model_call',
    sport: 'ufc',
    worker,
    story_id: article.id,
    article_id: article.id,
    slug: article.slug,
    story_class: article.story_type,
    story_subclass: article.fact_block?.story_class || null,
    routing_lane: 'STANDARD_EDITORIAL',
    routing_reason: routingReason,
    model: meta?.model || requestedModel,
    pool: 'premium',
    trigger,
    attempt,
    editorial_digest: digest,
    digest_version: DIGEST_VERSION,
    response_id: meta?.response_id || null,
    input_tokens: usage ? Number(usage.input_tokens) || 0 : null,
    cached_input_tokens: usage ? Number(usage.input_tokens_details?.cached_tokens) || 0 : null,
    output_tokens: usage ? Number(usage.output_tokens) || 0 : null,
    reasoning_tokens: usage ? Number(usage.output_tokens_details?.reasoning_tokens) || 0 : null,
    latency_ms: latencyMs,
    status,
    nominal_standard_cost_usd: usage ? nominalStandardCost(usage) : null,
    cost_basis: 'Nominal standard-rate estimate only (1.25 / 0.125 cached / 10 per MTok); not evidence of actual billing. Complimentary shared-token usage may apply subject to eligibility and remaining daily allowance.',
    timestamp: new Date(now).toISOString(),
  };
}

/** Default sink: ufc_news_pipeline_events, the table ufc-news-enrich's cost
 * records already use. stage/status stay inside the CHECK vocabulary
 * (editorial; ok|held|failed) and detail.kind='model_call' marks the row, so
 * enrich's /cost report (detail.kind=cost) never counts it. */
export function pipelineEventSink(sb, worker) {
  return async (rec) => {
    if (!sb || typeof sb.insert !== 'function') return;
    try {
      await sb.insert('ufc_news_pipeline_events', [{
        news_item_id: null,
        article_id: rec.article_id || null,
        stage: 'editorial',
        status: rec.status === 'ok' ? 'ok' : rec.status === 'held' ? 'held' : 'failed',
        latency_ms: rec.latency_ms,
        worker,
        detail: rec,
      }]);
    } catch (e) {
      /* Telemetry must never be the reason an article fails -- but it must
       * never vanish silently either. */
      console.warn(`  telemetry write failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  };
}

async function polishOne(env, article, source, {
  model, fetchImpl, timeoutMs, maxAttempts = AUTOMATIC_MAX_ATTEMPTS,
  onModelCall = null, worker = 'ufc-editorial-desk', digest = null, trigger = 'new_story', routingReason = null,
} = {}) {
  let correction = '';
  let lastProblem = '';
  let lastModel = model || env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL;
  const responseIds = [];
  const record = async (attempt, meta, started, status) => {
    if (!onModelCall) return;
    await onModelCall(modelCallRecord({
      worker, article, digest, trigger, routingReason, attempt, meta,
      requestedModel: lastModel, latencyMs: Date.now() - started, status,
    }));
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = `${acceptanceInstructions(article)}${correction ? `\n\n${correction}` : ''}\n\nSOURCE PACKET:\n${source}`;
    const started = Date.now();
    let envelope;
    try {
      envelope = await callOpenAI(env.OPENAI_API_KEY, {
        model: lastModel,
        input: prompt,
        fetchImpl,
        timeoutMs,
      });
    } catch (error) {
      await record(attempt, error?.openaiMeta || null, started, 'failed');
      if (error?.openaiMeta?.response_id) responseIds.push(error.openaiMeta.response_id);
      error.attempts = attempt;
      error.responseIds = responseIds;
      throw error;
    }
    lastModel = envelope.model || lastModel;
    if (envelope.response_id) responseIds.push(envelope.response_id);

    let problem = null;
    let out = null;
    try {
      out = JSON.parse(envelope.text);
      problem = validate(source, out, article);
    } catch (error) {
      problem = `invalid output serialization: ${String(error?.message || error).slice(0, 260)}`;
    }
    await record(attempt, envelope, started, problem ? 'held' : 'ok');
    if (!problem) {
      return {
        headline: String(out.headline).trim(),
        dek: String(out.dek).trim(),
        body_md: String(out.body_md).trim(),
        provider: 'openai',
        model: lastModel,
        attempts: attempt,
        responseIds,
      };
    }
    lastProblem = problem;

    if (attempt < maxAttempts) {
      console.log(`  RETRY ${article.slug}: OpenAI held — ${lastProblem}`);
      correction = correctionInstructions(lastProblem);
    }
  }

  const error = new Error(`validation after ${maxAttempts} attempt(s) via ${lastModel}: ${lastProblem}`);
  error.attempts = maxAttempts;
  error.responseIds = responseIds;
  error.gateHeld = true;
  throw error;
}

/**
 * The editorial desk pass.
 *
 * AUTOMATIC (force=false): an article is eligible only through
 * automaticEligibility() -- a writer-stamped editorial digest that the desk has
 * never decided. One attempt. Every outcome, pass or hold or provider failure,
 * is recorded against the digest in the row's sources, so the same input is
 * never bought twice and a held input is never retried automatically.
 *
 * ADMIN (force=true): the deliberate re-edit. Eligibility is bypassed, up to
 * ADMIN_MAX_ATTEMPTS, trigger 'admin_reedit' (or 'canary').
 */
export async function runOpenAIEditorial(env, sb, {
  now = Date.now(),
  limit = 30,
  recentHours = 720,
  force = false,
  model = null,
  maxPolish = DEFAULT_MAX_POLISH_PER_RUN,
  storyTypes = null,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  fetchImpl = fetch,
  trigger = null,
  maxAttempts = null,
  onModelCall = undefined,
  worker = 'ufc-editorial-desk',
  slugs = null,
} = {}) {
  if (!isConfigured(env)) {
    return { status: 'no_provider', candidates: 0, passed: 0, skipped: 0, held: 0, deferred: 0, provider: null };
  }

  const safeLimit = Math.min(60, Math.max(1, Number(limit) || 30));
  const safeHours = Math.min(24 * 60, Math.max(1, Number(recentHours) || 720));
  const safeMaxPolish = Math.min(8, Math.max(1, Number(maxPolish) || DEFAULT_MAX_POLISH_PER_RUN));
  const selectedModel = model || env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL;
  const since = new Date(now - safeHours * 3600 * 1000).toISOString();
  const effectiveTrigger = force
    ? (TRIGGERS.has(trigger) && trigger !== 'new_story' ? trigger : 'admin_reedit')
    : 'new_story';
  /* Automatic runs are pinned to one attempt whatever the caller asks for. */
  const attemptsAllowed = force
    ? Math.min(ADMIN_MAX_ATTEMPTS, Math.max(1, Number(maxAttempts) || ADMIN_MAX_ATTEMPTS))
    : AUTOMATIC_MAX_ATTEMPTS;
  const sink = onModelCall === undefined ? pipelineEventSink(sb, worker) : onModelCall;

  /* THE DESK MAY ONLY EDIT WHAT ITS CALLER OWNS.
   *
   * This query had no story_type filter, so it selected every published
   * article -- and when the event-editorial lane ran it, the desk rewrote a
   * story_type=external piece belonging to ufc-news-enrich: new prose, new
   * headline, and its model_version stamped over. Good prose, wrong owner, and
   * edited outside the two-class number gate that protects external articles
   * specifically because their numbers come from somebody else's reporting.
   *
   * storyTypes is therefore not optional in practice: a caller states what it
   * owns, and the desk cannot reach past it. */
  const typeFilter = Array.isArray(storyTypes) && storyTypes.length
    ? `&story_type=in.(${storyTypes.map((t) => encodeURIComponent(t)).join(',')})`
    : '';
  /* Exact-slug targeting is an ADMIN tool (one named article at a time): it
   * replaces the updated_at window and is refused on automatic runs. */
  const targeted = Array.isArray(slugs) && slugs.length > 0;
  if (targeted && !force) throw new Error('slug targeting requires force (explicit admin re-edit)');
  const slugFilter = targeted
    ? `&slug=in.(${slugs.map((x) => encodeURIComponent(String(x))).join(',')})`
    : `&updated_at=gte.${encodeURIComponent(since)}`;
  const rows = await sb.select(
    'ufc_articles',
    `select=id,slug,headline,dek,body_md,story_type,status,fact_block,sources,model_version,updated_at&status=eq.published${typeFilter}${slugFilter}&order=updated_at.desc&limit=${safeLimit}`,
  );

  let passed = 0;
  let skipped = 0;
  let held = 0;
  let deferred = 0;
  let attempted = 0;
  let modelCalls = 0;
  const skipReasons = {};
  const countingSink = sink ? async (rec) => { modelCalls += 1; await sink(rec); } : async () => { modelCalls += 1; };
  console.log(`openai editorial desk: candidates=${rows.length} limit=${safeLimit} max_polish=${safeMaxPolish} hours=${safeHours} force=${Boolean(force)} trigger=${effectiveTrigger} attempts=${attemptsAllowed} model=${selectedModel}`);

  for (const article of rows) {
    if (!article.fact_block || !article.body_md) {
      skipped += 1;
      skipReasons.no_packet = (skipReasons.no_packet || 0) + 1;
      continue;
    }
    let digest;
    let routingReason;
    if (force) {
      digest = inputEntry(article.sources)?.digest || editorialDigest(article);
      routingReason = effectiveTrigger === 'canary' ? 'canary' : 'admin_force';
    } else {
      const e = automaticEligibility(article);
      if (!e.eligible) {
        skipped += 1;
        skipReasons[e.reason] = (skipReasons[e.reason] || 0) + 1;
        continue;
      }
      digest = e.digest;
      routingReason = e.reason;
    }
    if (attempted >= safeMaxPolish) {
      deferred += 1;
      continue;
    }

    attempted += 1;
    const source = sourcePacket(article);
    const decidedAt = new Date(now).toISOString();
    try {
      const out = await polishOne(env, article, source, {
        model: selectedModel,
        fetchImpl,
        timeoutMs: callTimeoutMs,
        maxAttempts: attemptsAllowed,
        onModelCall: countingSink,
        worker,
        digest,
        trigger: effectiveTrigger,
        routingReason,
      });
      console.log(`  PASS ${article.slug} via ${out.provider}:${out.model} attempts=${out.attempts}`);
      passed += 1;
      await sb.patch('ufc_articles', `id=eq.${article.id}`, {
        headline: out.headline,
        dek: out.dek,
        body_md: out.body_md,
        model_version: `${out.provider}:${out.model}/${DESK_VERSION}`,
        sources: recordDecision(article.sources, {
          digest, outcome: 'passed', trigger: effectiveTrigger, attempts: out.attempts, model: out.model, at: decidedAt,
        }),
        updated_at: new Date(now).toISOString(),
      });
    } catch (error) {
      held += 1;
      console.log(`  HOLD ${article.slug}: ${String(error?.message || error).slice(0, 700)}`);
      /* The held/failed decision is durable: this digest is spent. Prose and
       * updated_at are untouched -- only the bookkeeping entry changes. */
      try {
        await sb.patch('ufc_articles', `id=eq.${article.id}`, {
          sources: recordDecision(article.sources, {
            digest,
            outcome: error?.gateHeld ? 'held' : 'failed',
            trigger: effectiveTrigger,
            attempts: Number(error?.attempts) || 1,
            model: selectedModel,
            at: decidedAt,
          }),
        });
      } catch (e) {
        console.warn(`  decision write failed for ${article.slug}: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  }

  const result = {
    status: 'ran',
    candidates: rows.length,
    attempted,
    passed,
    skipped,
    skip_reasons: skipReasons,
    held,
    deferred,
    model_calls: modelCalls,
    trigger: effectiveTrigger,
    max_attempts: attemptsAllowed,
    digest_version: DIGEST_VERSION,
    provider: `openai:${selectedModel}`,
    model: selectedModel,
  };

  if (attempted > 0 && passed === 0 && held === attempted) {
    const error = new Error(`openai editorial desk: every attempted candidate was held (${held}/${attempted}); failing closed`);
    error.deskResult = result;
    throw error;
  }

  return result;
}
