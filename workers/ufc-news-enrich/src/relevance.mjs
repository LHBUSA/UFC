/* How much does a UFC bettor care that this happened? 1-5.
 *
 * Ported from propbet-news-enrich, whose scale was tuned on production evidence
 * across four sports. Two things carry over that are easy to get wrong:
 *
 *   THE DEFAULT POSTURE IS GENEROUS. Between 2 and 3, choose 3. This
 *   publication is better off enriching a marginal story than missing a
 *   market-moving one, and 1-2 are strict noise filters rather than a general
 *   quality judgement.
 *
 *   A CHEAP MODEL DOES THIS, NOT THE WRITER. Scoring runs on every candidate;
 *   editorial runs on the survivors. Using GPT-5.6 Sol here would multiply the
 *   cost of the stage that exists to control cost.
 */
import { redactSecrets } from './editorial.mjs';

const API = 'https://api.openai.com/v1/responses';
export const SCORER_MODEL = 'gpt-5.6-sol-mini';

const KINDS = ['fight_announcement', 'withdrawal', 'replacement', 'injury', 'weight_miss',
  'result', 'rankings', 'contract', 'suspension', 'title', 'interview', 'camp', 'other'];

const PROMPT = `You score UFC news for PropBetEdge, a fight-betting intelligence publication. Score by value to someone betting UFC fights.

5 — market-moving or division-changing. Champion injury, title fight cancelled, main-event replacement, title stripped or vacated, major suspension, elite signing, elite fighter changing division.
4 — significant. Ranked fighter injury or withdrawal, opponent replacement, an official new fight involving a ranked fighter, major contract news, a weigh-in miss, a card reshuffle, retirement of an active ranked fighter.
3 — normal publishable UFC intelligence. A meaningful fight announcement, a contender's result, rankings movement, a post-fight tactical development, well-sourced camp or strategy information, an active fighter's return, a performance trend. MOST REAL UFC NEWS IS A 3.
2 — usually skip. Vague rumour, old retrospective, an interview with little competitive information, promotional quotes with no substance.
1 — noise. Social-media drama, lifestyle, podcast promotion, celebrity content, engagement bait, or another combat sport that reached a UFC feed.

DEFAULT POSTURE: between 2 and 3, choose 3.

Also identify the story kind and the single fighter the story is ABOUT — not a fighter merely mentioned or used as a comparison. If the story is about a prospect and compares him to a champion, the PROSPECT is the subject. If no single fighter is the subject, return null.

Return JSON only.`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    score: { type: 'integer' },
    reason: { type: 'string' },
    story_kind: { type: 'string', enum: KINDS },
    primary_fighter_name: { type: ['string', 'null'] },
    other_fighter_names: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'reason', 'story_kind', 'primary_fighter_name', 'other_fighter_names'],
};

export async function scoreRelevance(env, item, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  if (!env.OPENAI_API_KEY) {
    /* Fail OPEN, deliberately. A scorer that is down must not silently bin the
     * day's news; the later gates are the ones that protect quality. */
    return { score: 3, reason: 'scorer unavailable; default posture', story_kind: 'other',
      primary_fighter_name: null, other_fighter_names: [], degraded: true };
  }
  const model = env.UFC_RELEVANCE_MODEL || SCORER_MODEL;
  const input = `Source: ${item.source?.name || 'unknown'}\nHeadline: ${item.title}\nSummary: ${item.summary || '(none)'}\nKeyword labels: ${(item.taxonomy?.labels || []).join(', ') || 'none'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model, store: false, instructions: PROMPT, input, max_output_tokens: 2000,
        text: { format: { type: 'json_schema', name: 'ufc_relevance', strict: true, schema: SCHEMA } },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`relevance ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    const text = (json.output || []).flatMap((o) => (o.content || [])).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    const parsed = JSON.parse(text);
    return {
      score: Math.max(1, Math.min(5, Number(parsed.score) || 1)),
      reason: String(parsed.reason || '').slice(0, 300),
      story_kind: KINDS.includes(parsed.story_kind) ? parsed.story_kind : 'other',
      primary_fighter_name: parsed.primary_fighter_name || null,
      other_fighter_names: Array.isArray(parsed.other_fighter_names) ? parsed.other_fighter_names.slice(0, 8) : [],
      model,
    };
  } catch (e) {
    /* Redacted for the same reason the editorial path is: a provider 401
     * quotes the key it rejected, and this reason string is persisted. */
    return { score: 3, reason: redactSecrets(`scorer error, default posture: ${String(e.message)}`).slice(0, 160),
      story_kind: 'other', primary_fighter_name: null, other_fighter_names: [], degraded: true };
  } finally {
    clearTimeout(timer);
  }
}
