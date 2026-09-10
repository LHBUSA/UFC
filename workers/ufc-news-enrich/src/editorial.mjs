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
import { factNumbers, numberTokens } from './packet.mjs';

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
        /* Enumerated in the schema, not merely validated afterwards. Given a
         * free-string array the model wrote a full sentence into it -- "No
         * current betting market can be assessed because..." -- which is a
         * reasonable thing to want to say and the wrong field to say it in.
         * Constraining the schema makes that unconstructible; the sentence
         * belongs in `summary`, which is free text. */
        markets: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['moneyline', 'fight_goes_distance', 'total_rounds', 'method_of_victory',
              'round_betting', 'significant_strikes', 'takedowns', 'none'],
          },
        },
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
    for (const tokenText of numberTokens(sent)) {
      const key = String(Number(tokenText));
      /* Small integers, years and round numbers are structural language, not
       * claims: "the third round", "in 2026", "one of two". Treating them as
       * facts needing provenance would fail every real article. */
      const n = Number(key);
      if (Number.isInteger(n) && ((n >= 0 && n <= 5) || (n >= 1990 && n <= 2100) || n === 15 || n === 25)) continue;
      const cls = allowed.get(key);
      if (!cls) {
        /* The sentence travels with the failure. The first version of this
         * message named only the number, and the corrective retry failed the
         * same way twice: the model could not locate a bare "10" in 900 words
         * and guessed. Quoting the sentence turns the retry into an edit. */
        failures.push(`class C number "${tokenText}" is in no part of the packet — remove it or replace it with a packet value. In: "${sent.trim().slice(0, 180)}"`);
        continue;
      }
      if (cls === 'B' && !attributed) {
        failures.push(`class B number "${tokenText}" comes only from ${publisher}, so that sentence must name ${publisher}. In: "${sent.trim().slice(0, 180)}"`);
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

/**
 * Provider error bodies are never stored verbatim.
 *
 * A 401 from OpenAI quotes the key it rejected back at you. Most of it is
 * masked, but on 2026-09-10 a Stripe live key was configured here by mistake
 * and its prefix and last four characters landed in ufc_news_items.state_reason
 * and in the pipeline event detail. A credential fragment does not belong in a
 * table the whole team can read, and the next provider might mask less.
 *
 * So: strip anything key-shaped before the message goes anywhere it persists.
 */
export function redactSecrets(text) {
  return String(text || '')
    .replace(/(sk|pk|rk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9*_-]{8,}/gi, '<redacted-credential>')
    .replace(/Bearer\s+[A-Za-z0-9._\-*]{12,}/gi, 'Bearer <redacted>')
    .replace(/Incorrect API key provided:[^.]*/gi, 'Incorrect API key provided: <redacted>');
}

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

export async function callSol(apiKey, { model, input, timeoutMs = CALL_TIMEOUT_MS, fetchImpl = fetch, schema = SCHEMA, schemaName = 'ufc_article' }) {
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
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(redactSecrets(`openai ${res.status}: ${JSON.stringify(json).slice(0, 300)}`));
    if (json.status === 'incomplete') throw new Error(`openai incomplete: ${json.incomplete_details?.reason || 'unknown'}`);
    if (json.status === 'failed') throw new Error(redactSecrets(`openai failed: ${JSON.stringify(json.error || {}).slice(0, 240)}`));
    /* Usage was being discarded. Without it there is no way to answer "what did
     * this article cost" except by guessing from call counts, and a governor
     * you cannot measure is a governor you cannot tune. */
    return {
      text: extractText(json),
      model: json.model || model,
      usage: {
        input_tokens: Number(json.usage?.input_tokens) || 0,
        output_tokens: Number(json.usage?.output_tokens) || 0,
      },
    };
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`openai timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------- targeted repair */

const REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['repairs'],
  properties: {
    repairs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'replacement'],
        properties: { index: { type: 'integer' }, replacement: { type: 'string' } },
      },
    },
  },
};

/**
 * Failures that name the sentence they are about.
 *
 * Only the two number-gate failures do -- they append: In: "<sentence>". Those
 * are also the failure that actually happens: over 48 hours of live traffic
 * they were 20 of the held articles, more than every structural failure
 * combined. Everything else (word count, missing sections, headline not naming
 * the subject) is a property of the whole document and cannot be repaired by
 * replacing a sentence.
 */
export function sentenceScopedForTest(failures) { return sentenceScoped(failures); }

function sentenceScoped(failures) {
  const out = [];
  for (const f of failures) {
    const m = String(f).match(/In: "([\s\S]+)"\s*$/);
    if (!m) return null;                 /* one document-level failure disqualifies the whole set */
    out.push({ reason: String(f).replace(/\s*In: "[\s\S]+"\s*$/, ''), sentence: m[1].trim() });
  }
  return out.length ? out : null;
}

/**
 * Repair the failing sentences instead of rewriting the article.
 *
 * WHY THIS IS WORTH DOING
 *
 * A corrective retry used to regenerate the entire piece: the full packet went
 * back up, a full article came back down, and a thousand good words were thrown
 * away to fix one bad clause. It also meant every retry risked LOSING prose
 * that had already passed -- the second draft is a different article, and it
 * can be worse in ways the gate does not measure.
 *
 * Repairing in place keeps the draft that was mostly right and sends only the
 * offending sentences. The saving is large because the packet dominates the
 * input tokens and the article dominates the output tokens; neither is resent.
 *
 * WHY IT CANNOT WEAKEN THE GATE
 *
 * The repaired article is re-validated in full by the same validate() call that
 * rejected it -- not just the replaced sentences. A repair that fixes one
 * failure and introduces another is rejected exactly as a fresh draft would be,
 * and falls through to full regeneration.
 */
async function repairSentences(env, packet, article, scoped, { selected, fetchImpl, cost }) {
  const numbered = scoped.map((s, i) => `[${i}] REASON: ${s.reason}
    SENTENCE: ${s.sentence}`).join('\n\n');
  const input = `Some sentences in a published-ready UFC article failed the publication gate.
`
    + `Rewrite ONLY those sentences. Keep every other word of the article untouched.

`
    + `RULES
`
    + `  - Return one replacement per index, in the same order.
`
    + `  - A replacement must carry the same editorial point as the original.
`
    + `  - Do NOT introduce any number, price or claim that is not in the packet below.
`
    + `  - If a number cannot be justified from the packet, remove the number rather than the point.
`
    + `  - Plain prose. No markdown headings. Keep it one sentence unless the original was longer.

`
    + `FAILING SENTENCES
${numbered}

VERIFIED PACKET
${JSON.stringify(packet)}`;

  const envelope = await callSol(env.OPENAI_API_KEY, {
    model: selected, input, fetchImpl, schema: REPAIR_SCHEMA, schemaName: 'ufc_article_repair',
  });
  cost.model_calls += 1;
  cost.retry_input_tokens += envelope.usage?.input_tokens || 0;
  cost.retry_output_tokens += envelope.usage?.output_tokens || 0;

  let parsed;
  try { parsed = JSON.parse(envelope.text); } catch { return null; }
  const repairs = Array.isArray(parsed?.repairs) ? parsed.repairs : [];
  if (repairs.length !== scoped.length) return null;

  let body = article.body_md;
  for (const r of repairs) {
    const target = scoped[r.index];
    const replacement = String(r.replacement || '').trim();
    /* A repair that cannot be located, or that is empty, is not applied -- and
     * an unapplied repair leaves the original failing sentence in place, so the
     * re-validation below will reject the article rather than publish it. */
    if (!target || !replacement || !body.includes(target.sentence)) return null;
    body = body.replace(target.sentence, replacement);
  }
  return { ...article, body_md: body, model: envelope.model };
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
  /* First attempt and corrective retry are counted apart: they are different
   * costs with different fixes. A high first-attempt bill means the packet is
   * large; a high retry bill means the gate and the prompt disagree. */
  const cost = { sol_input_tokens: 0, sol_output_tokens: 0, retry_input_tokens: 0, retry_output_tokens: 0, model_calls: 0 };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const input = `Write the PropBetEdge UFC article for this story.\n\n`
      + `ACCEPTANCE: body_md at least ${minWords} words, at most 2200, with at least 3 descriptive H2 sections. `
      + `Meet the depth with evidence already in the packet — never by padding.\n`
      + (correction ? `\n${correction}\n` : '')
      + `\nSOURCE PACKET:\n${source}`;

    const envelope = await callSol(env.OPENAI_API_KEY, { model: selected, input, fetchImpl });
    cost.model_calls += 1;
    if (attempt === 1) {
      cost.sol_input_tokens += envelope.usage?.input_tokens || 0;
      cost.sol_output_tokens += envelope.usage?.output_tokens || 0;
    } else {
      cost.retry_input_tokens += envelope.usage?.input_tokens || 0;
      cost.retry_output_tokens += envelope.usage?.output_tokens || 0;
    }
    let parsed;
    try { parsed = JSON.parse(envelope.text); }
    catch (e) { last = { failures: [`unparseable output: ${String(e.message).slice(0, 160)}`] }; }

    if (parsed) {
      const verdict = validate(parsed, packet, { minWords });
      last = verdict;
      if (verdict.ok) {
        return { ...parsed, model: envelope.model, attempts: attempt, cost, validation: { ok: true, failures: [] } };
      }

      /* TRY REPAIRING BEFORE REWRITING.
       *
       * When every failure names its own sentence, the draft is not wrong -- a
       * few clauses in it are. Replacing those costs a fraction of a second
       * article and, more importantly, keeps the prose that already passed.
       * Only attempted on the first draft: if a repair has already failed, the
       * disagreement is not local and a genuine rewrite is the right move. */
      const scoped = attempt === 1 ? sentenceScoped(verdict.failures) : null;
      if (scoped) {
        const repaired = await repairSentences(env, packet, parsed, scoped, { selected, fetchImpl, cost })
          .catch(() => null);
        if (repaired) {
          /* Re-validated IN FULL, not just the replaced sentences: a repair that
           * fixes one failure and introduces another must be caught here. */
          const after = validate(repaired, packet, { minWords });
          if (after.ok) {
            return { ...repaired, attempts: attempt, cost, repaired_sentences: scoped.length, validation: { ok: true, failures: [] } };
          }
          last = after;
        }
      }
    }
    correction = `YOUR PREVIOUS DRAFT WAS REJECTED BY THE PUBLICATION GATE for exactly these reasons:\n`
      + last.failures.map((f) => `  - ${f}`).join('\n')
      + `\nRewrite from the SAME packet and fix every one. Do not add any fact, number, price or claim to work around them.`;
  }

  const err = new Error(`held after corrective retry: ${last.failures.join('; ').slice(0, 500)}`);
  err.cost = cost;   /* a failed article still cost money and must still be counted */
  err.validation = { ok: false, failures: last.failures };
  throw err;
}
