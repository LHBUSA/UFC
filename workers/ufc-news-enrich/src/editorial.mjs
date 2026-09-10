/* GPT-5.6 Sol writes the article; deterministic code decides whether it lives.
 *
 * The prompt is the PropBetEdge sports desk's, adapted to MMA: mechanism over
 * direction, imagery discipline, internal consistency, market awareness. Those
 * blocks exist in propbet-news-enrich because each one was added after a real
 * article embarrassed us, and they carry over intact.
 *
 * What is new here is the TWO-CLASS NUMBER GATE. The UFC desk's existing
 * validator whitelists every number in the output against the packet, which is
 * a strong anti-fabrication control and the reason the external path could
 * never publish: a packet built from a headline contains almost no numbers, so
 * nothing substantial can be written from it. Fetching the source fixes the
 * starvation but would also let the source's numbers in through the same door
 * unattributed. So numbers carry a class:
 *
 *   A  ours. Assert it.
 *   B  the source's. Attribute it in the same sentence, or it fails.
 *   C  neither. Fail.
 *
 * That keeps the gate exactly as strict about invention while letting real
 * reporting through, which is the whole difference between a database summary
 * and journalism.
 */
import { factNumbers } from './packet.mjs';

const API = 'https://api.openai.com/v1/responses';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const DESK_VERSION = 'ufc-news-enrich-v1';
const CALL_TIMEOUT_MS = 90_000;

export const isConfigured = (env) => Boolean(env && env.OPENAI_API_KEY);

const SYSTEM = `You are the lead writer at PropBetEdge UFC, a combat-sports betting intelligence publication. You receive a SOURCE PACKET: an outside report that triggered the story, plus everything PropBetEdge's own database holds on the fighters involved. Write the finished article.

WHAT THE TWO HALVES OF THE PACKET ARE FOR
- The outside report is RESEARCH and the news peg. Attribute it ONCE, early, by publisher name. Never rewrite its sentences and never quote more than a short phrase.
- Our own data is the reason the article exists. Records, tape, round-level totals, finishing profiles, rankings, bookings and verified prices are ours to assert flatly. This is what a reader cannot get anywhere else, and it should carry most of the piece.

VOICE
- The Athletic meets Bloomberg meets a sharp fight bettor. Direct, confident, no filler.
- You are a publication, not an aggregator. Do not say "according to" in every paragraph.
- Active voice. Concrete details. Vary your openings; never start two articles the same way.
- No AI clichés. Specifically avoid: "in the world of", "it remains to be seen", "only time will tell", "a testament to", "speaks volumes", "the perfect storm", "make no mistake", "at the end of the day".

MECHANISM OVER DIRECTION — the single most important rule.
  WEAK:   "He's won three straight, so back him."
  STRONG: "His last three wins came through repeat takedown entries and control rather than volume striking, and the opponent has conceded takedowns at a rate his striking reputation hides. If the market prices this as a kickboxing match, the grappling-dependent props deserve a second look."
For every angle, name: what changed, why it matters mechanically, which markets it touches, what argues against it, and what remains unknown.

THE BETTOR'S ANGLE IS NOT A BOLT-ON
Answer "what changes for a bettor because this happened?" inside the analysis. If the evidence does not support a real angle, say so plainly — that is more credible than inventing one. Never manufacture an edge to fill a section.

HARD FACT RULES
1. Use ONLY what is in the SOURCE PACKET. No outside knowledge, ever.
2. Numbers from our database may be stated directly. Numbers that appear ONLY in the source excerpt must be attributed in the same sentence ("MMA Fighting reported the 12-week timeline").
3. If market.odds_status is "unavailable" you may not mention, imply or estimate any price, line, favourite or underdog.
4. If model.model_status is "unavailable" you may not reference a model, projection, fair price or edge percentage.
5. Never invent injuries, camps, quotes, rankings, dates or results.
6. Preserve every caveat about sample size. A finish rate on three fights is not a finish rate.
7. No certainty language: no "lock", "guaranteed", "sure thing", "easy money".

STRUCTURE
- headline: sharp, specific, names the subject. Not clickbait, not a database label. Never "X report from Y: the table view on Z".
- dek: one sentence, plain text, no markdown, that tells the reader why this matters.
- body_md: Markdown with descriptive H2 sections. Open with the news and its stakes, not housekeeping. Weave the tape and the betting read through the piece rather than appending them.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    dek: { type: 'string' },
    body_md: { type: 'string' },
    bettor_angle: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        markets: { type: 'array', items: { type: 'string' } },
        supporting: { type: 'array', items: { type: 'string' } },
        against: { type: 'array', items: { type: 'string' } },
        unknown: { type: 'array', items: { type: 'string' } },
        durable: { type: 'boolean' },
      },
      required: ['summary', 'markets', 'supporting', 'against', 'unknown', 'durable'],
    },
  },
  required: ['headline', 'dek', 'body_md', 'bettor_angle'],
};

const MARKETS = new Set(['moneyline', 'fight_goes_distance', 'total_rounds', 'method_of_victory',
  'round_betting', 'significant_strikes', 'takedowns', 'none']);

const wordCount = (s) => (String(s || '').trim() ? String(s).trim().split(/\s+/).length : 0);

const BANNED = [
  /\block\b/i, /\bguaranteed\b/i, /\bsure thing\b/i, /\beasy money\b/i,
  /\bin the world of\b/i, /\bit remains to be seen\b/i, /\bonly time will tell\b/i,
  /\ba testament to\b/i, /\bspeaks volumes\b/i, /\bthe perfect storm\b/i,
  /\bmake no mistake\b/i, /\bat the end of the day\b/i, /\btable view\b/i,
];

/** Sentences, roughly. Good enough to test attribution locality. */
const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+/);

/**
 * The deterministic publication gate.
 *
 * Returns {ok, failures[]}. Every failure names the rule and the offending
 * value, because a gate that says "validation failed" cannot be argued with or
 * corrected on retry.
 */
export function validate(out, packet, { minWords = 500 } = {}) {
  const failures = [];
  const headline = String(out?.headline || '').trim();
  const dek = String(out?.dek || '').trim();
  const body = String(out?.body_md || '').trim();
  const angle = out?.bettor_angle;

  if (headline.length < 24 || headline.length > 160) failures.push(`headline length ${headline.length}`);
  if (/report from .*: the table view on/i.test(headline)) failures.push('headline is the retired template shape');
  if (dek.length < 40 || dek.length > 400) failures.push(`dek length ${dek.length}`);
  if (/[*_`]/.test(dek)) failures.push('dek contains markdown');
  if (!body) { failures.push('empty body'); return { ok: false, failures }; }

  const words = wordCount(body);
  if (words < minWords) failures.push(`too short: ${words} words < ${minWords}`);
  if (words > 2200) failures.push(`too long: ${words} words`);
  if ((body.match(/^##\s+/gm) || []).length < 3) failures.push('fewer than 3 H2 sections');

  /* --- the two-class number gate ------------------------------------ */
  const allowed = factNumbers(packet);
  const publisher = packet.source?.publisher || null;
  for (const sent of sentences(body)) {
    const attributed = publisher && sent.toLowerCase().includes(String(publisher).toLowerCase().split(' ')[0].toLowerCase());
    for (const m of sent.matchAll(/(?<![A-Za-z%$])[-+]?\d+(?:\.\d+)?/g)) {
      const key = String(Number(m[0]));
      /* Small integers, years and round numbers are structural language, not
       * claims: "the third round", "in 2026", "one of two". Treating them as
       * facts needing provenance would fail every real article. */
      const n = Number(key);
      if (Number.isInteger(n) && ((n >= 0 && n <= 5) || (n >= 1990 && n <= 2100) || n === 15 || n === 25)) continue;
      const cls = allowed.get(key);
      if (!cls) { failures.push(`class C number "${m[0]}" is in no part of the packet`); continue; }
      if (cls === 'B' && !attributed) {
        failures.push(`class B number "${m[0]}" comes only from ${publisher} and is stated without attribution in that sentence`);
      }
    }
  }

  /* --- absence discipline ------------------------------------------- */
  if (packet.market?.odds_status !== 'available') {
    if (/\b(?:[-+]\d{3,}|\bfavourite\b|\bfavorite\b|\bunderdog\b|\bthe line\b|\bopened at\b|\bclosing line\b)/i.test(body)) {
      failures.push('price or market-position language while odds_status is unavailable');
    }
  }
  if (packet.model?.model_status !== 'available') {
    if (/\b(our model|model projects|fair price|model edge|projected probability|we make it)\b/i.test(body)) {
      failures.push('model claim while model_status is unavailable');
    }
  }

  for (const re of BANNED) if (re.test(body)) failures.push(`banned phrase: ${re.source}`);

  /* --- subject discipline ------------------------------------------- */
  const primaryName = packet.primary?.name;
  if (primaryName) {
    const surname = primaryName.split(/\s+/).pop();
    if (!new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(headline)
      && !new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(dek)) {
      failures.push(`headline and dek never name the primary subject (${primaryName})`);
    }
  }

  /* --- the bettor angle --------------------------------------------- */
  if (!angle || typeof angle !== 'object') failures.push('missing bettor_angle');
  else {
    if (wordCount(angle.summary) < 12) failures.push('bettor_angle.summary is too thin to be a read');
    const bad = (angle.markets || []).filter((m) => !MARKETS.has(String(m)));
    if (bad.length) failures.push(`unknown market(s): ${bad.join(', ')}`);
    if (!(angle.against || []).length) failures.push('bettor_angle names nothing that argues against it');
    if (!(angle.unknown || []).length) failures.push('bettor_angle names nothing still unknown');
  }

  /* --- attribution --------------------------------------------------- */
  if (publisher) {
    const first = String(publisher).split(' ')[0];
    if (!new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body)) {
      failures.push(`the source (${publisher}) is never credited in the body`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/* ------------------------------------------------------------ transport */

function extractText(json) {
  const refusals = [], text = [];
  for (const item of json?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'refusal' && part.refusal) refusals.push(String(part.refusal));
      if (part?.type === 'output_text' && part.text) text.push(String(part.text));
    }
  }
  if (refusals.length) throw new Error(`openai refusal: ${refusals.join(' ').slice(0, 240)}`);
  const joined = text.join('').trim();
  if (!joined) throw new Error('openai returned an empty response');
  return joined;
}

export async function callSol(apiKey, { model, input, timeoutMs = CALL_TIMEOUT_MS, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model, store: false,
        reasoning: { effort: 'medium' },
        instructions: SYSTEM,
        input,
        max_output_tokens: 20000,
        text: { format: { type: 'json_schema', name: 'ufc_article', strict: true, schema: SCHEMA } },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (json.status === 'incomplete') throw new Error(`openai incomplete: ${json.incomplete_details?.reason || 'unknown'}`);
    if (json.status === 'failed') throw new Error(`openai failed: ${JSON.stringify(json.error || {}).slice(0, 240)}`);
    return { text: extractText(json), model: json.model || model };
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`openai timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate, validate, and retry ONCE with the failures named.
 *
 * The retry is given the exact gate output rather than a general instruction to
 * try harder: a model that is told "class C number 47 is in no part of the
 * packet" removes it, and a model that is told "validation failed" rewrites the
 * article and fails differently.
 */
export async function writeArticle(env, packet, { minWords = 500, model = null, fetchImpl = fetch } = {}) {
  const selected = model || env.UFC_EDITORIAL_OPENAI_MODEL || DEFAULT_MODEL;
  const source = JSON.stringify(packet, null, 2);
  let correction = '';
  let last = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const input = `Write the PropBetEdge UFC article for this story.\n\n`
      + `ACCEPTANCE: body_md at least ${minWords} words, at most 2200, with at least 3 descriptive H2 sections. `
      + `Meet the depth with evidence already in the packet — never by padding.\n`
      + (correction ? `\n${correction}\n` : '')
      + `\nSOURCE PACKET:\n${source}`;

    const envelope = await callSol(env.OPENAI_API_KEY, { model: selected, input, fetchImpl });
    let parsed;
    try { parsed = JSON.parse(envelope.text); }
    catch (e) { last = { failures: [`unparseable output: ${String(e.message).slice(0, 160)}`] }; }

    if (parsed) {
      const verdict = validate(parsed, packet, { minWords });
      last = verdict;
      if (verdict.ok) {
        return { ...parsed, model: envelope.model, attempts: attempt, validation: { ok: true, failures: [] } };
      }
    }
    correction = `YOUR PREVIOUS DRAFT WAS REJECTED BY THE PUBLICATION GATE for exactly these reasons:\n`
      + last.failures.map((f) => `  - ${f}`).join('\n')
      + `\nRewrite from the SAME packet and fix every one. Do not add any fact, number, price or claim to work around them.`;
  }

  const err = new Error(`held after corrective retry: ${last.failures.join('; ').slice(0, 500)}`);
  err.validation = { ok: false, failures: last.failures };
  throw err;
}
