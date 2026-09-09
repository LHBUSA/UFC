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

const API = 'https://api.openai.com/v1/responses';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
const DESK_VERSION = 'editorial-desk-openai-v1';

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
    sources: article.sources,
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
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('openai: no API key');

  const res = await fetchImpl(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
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
  if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  if (json.status === 'incomplete') {
    const why = json.incomplete_details?.reason || 'unknown';
    throw new Error(`openai: incomplete response (${why})`);
  }
  if (json.status === 'failed') throw new Error(`openai: failed response: ${JSON.stringify(json.error || {}).slice(0, 240)}`);

  return { text: extractOutputText(json), model: json.model || model };
}

async function polishOne(env, article, source, { model, fetchImpl } = {}) {
  let correction = '';
  let lastProblem = '';
  let lastModel = model || env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = `${acceptanceInstructions(article)}${correction ? `\n\n${correction}` : ''}\n\nSOURCE PACKET:\n${source}`;
    const envelope = await callOpenAI(env.OPENAI_API_KEY, {
      model: lastModel,
      input: prompt,
      fetchImpl,
    });
    lastModel = envelope.model || lastModel;

    try {
      const out = JSON.parse(envelope.text);
      const problem = validate(source, out, article);
      if (!problem) {
        return {
          headline: String(out.headline).trim(),
          dek: String(out.dek).trim(),
          body_md: String(out.body_md).trim(),
          provider: 'openai',
          model: lastModel,
          attempts: attempt,
        };
      }
      lastProblem = problem;
    } catch (error) {
      lastProblem = `invalid output serialization: ${String(error?.message || error).slice(0, 260)}`;
    }

    if (attempt === 1) {
      console.log(`  RETRY ${article.slug}: OpenAI held — ${lastProblem}`);
      correction = correctionInstructions(lastProblem);
    }
  }

  throw new Error(`validation after corrective retry via ${lastModel}: ${lastProblem}`);
}

export async function runOpenAIEditorial(env, sb, {
  now = Date.now(),
  limit = 30,
  recentHours = 720,
  force = false,
  model = null,
  fetchImpl = fetch,
} = {}) {
  if (!isConfigured(env)) {
    return { status: 'no_provider', candidates: 0, passed: 0, skipped: 0, held: 0, provider: null };
  }

  const safeLimit = Math.min(60, Math.max(1, Number(limit) || 30));
  const safeHours = Math.min(24 * 60, Math.max(1, Number(recentHours) || 720));
  const selectedModel = model || env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL;
  const since = new Date(now - safeHours * 3600 * 1000).toISOString();

  const rows = await sb.select(
    'ufc_articles',
    `select=id,slug,headline,dek,body_md,story_type,status,fact_block,sources,model_version,updated_at&status=eq.published&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=${safeLimit}`,
  );

  let passed = 0;
  let skipped = 0;
  let held = 0;
  console.log(`openai editorial desk: candidates=${rows.length} limit=${safeLimit} hours=${safeHours} force=${Boolean(force)} model=${selectedModel}`);

  for (const article of rows) {
    if (!force && String(article.model_version || '').includes(`/${DESK_VERSION}`)) {
      skipped += 1;
      continue;
    }
    if (!article.fact_block || !article.body_md) {
      skipped += 1;
      continue;
    }

    const source = sourcePacket(article);
    try {
      const out = await polishOne(env, article, source, { model: selectedModel, fetchImpl });
      console.log(`  PASS ${article.slug} via ${out.provider}:${out.model} attempts=${out.attempts}`);
      passed += 1;
      await sb.patch('ufc_articles', `id=eq.${article.id}`, {
        headline: out.headline,
        dek: out.dek,
        body_md: out.body_md,
        model_version: `${out.provider}:${out.model}/${DESK_VERSION}`,
        updated_at: new Date(now).toISOString(),
      });
    } catch (error) {
      held += 1;
      console.log(`  HOLD ${article.slug}: ${String(error?.message || error).slice(0, 700)}`);
    }
  }

  const result = {
    status: 'ran',
    candidates: rows.length,
    passed,
    skipped,
    held,
    provider: `openai:${selectedModel}`,
    model: selectedModel,
  };

  if (rows.length > 0 && passed === 0 && skipped === 0 && held > 0) {
    const error = new Error(`openai editorial desk: every candidate was held (${held}/${rows.length}); failing closed`);
    error.deskResult = result;
    throw error;
  }

  return result;
}
