/* The newsroom's only Anthropic transport.
 *
 * There were three. The article writer had a raw Messages call, the editorial
 * desk had a second one with different limits and retry behaviour, and the
 * Worker shipped a third (workers/ufc-newsroom/src/anthropic.mjs) that nothing
 * ever called — it was imported only for `isConfigured`, while the writer it
 * was supposed to enhance used its own. Three implementations of one HTTP call,
 * two of them believed to be production, is how a fix lands in the copy that is
 * not running.
 *
 * So there is one transport here and the editorial policies stay where they
 * belong. This module knows how to ask Claude for text and how to fail; it
 * knows nothing about fact blocks, gates, prompts or what may be published.
 * The writer and the desk keep their own prompts, their own validators and
 * their own accept/reject rules, because those genuinely differ — a copy edit
 * that must preserve every number is not the same job as a desk rewrite that
 * may restructure. What must not differ is what happens when the API returns
 * 529, or a refusal, or 16,000 tokens of truncated JSON.
 *
 * Everything is passed in. No module-scope key, no module-scope model, no
 * module-scope clock: this file is imported once into a Worker isolate that
 * serves many invocations, and anything captured at import time would be
 * captured for the life of that isolate.
 */

const API = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/* Pinned deliberately. A floating alias would change the newsroom's voice with
 * no commit, and model_version on an article has to mean something. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export const isConfigured = (env) => Boolean(env && env.ANTHROPIC_API_KEY);

/**
 * One Messages call. Returns the assistant text, or throws with a reason.
 *
 * Throwing rather than returning null is deliberate: both callers already have
 * a try/catch whose whole job is deciding what to keep when the model does not
 * deliver, and the reason is logged there. A silent null would rob them of the
 * distinction between "refused", "truncated" and "rate limited", which is the
 * only part of a failure worth reading.
 */
export async function callMessages(apiKey, {
  model = DEFAULT_MODEL,
  system,
  prompt,
  maxTokens = 16000,
  thinking,
  timeoutMs = 120000,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('anthropic: no API key');

  const res = await fetchImpl(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(thinking ? { thinking } : {}),
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    /* A scheduled newsroom would rather publish the deterministic version on
     * time than wait forever on an enhancement. AbortSignal.timeout exists in
     * workerd and in Node 18+; where it does not, no signal is still correct. */
    ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  if (json.stop_reason === 'refusal') {
    const cat = json.stop_details && json.stop_details.category;
    throw new Error(`anthropic: refusal${cat ? ` (${cat})` : ''}`);
  }
  if (json.stop_reason === 'max_tokens') throw new Error('anthropic: output truncated at max_tokens');

  const text = (json.content || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('anthropic: empty response');
  return { text, model: json.model || model };
}
