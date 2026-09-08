/* Optional editorial enhancement, over the raw Anthropic Messages API.
 *
 * This replaces the GitHub Copilot CLI path entirely. That path could not
 * survive here for a reason worth recording rather than rediscovering: it
 * shelled out with spawnSync to a globally npm-installed binary and
 * authenticated with the short-lived Actions GITHUB_TOKEN. A Worker has no
 * subprocesses and no Actions token, and a production newsroom should not
 * depend on a CLI being installable at run time in the first place.
 *
 * THE GUARANTEE, which the rest of this file only serves:
 *
 *   The deterministic article is the product. Anthropic can improve one and
 *   can never prevent one. No missing key, timeout, HTTP error, malformed
 *   response, refusal or failed editorial gate may stop a verified article
 *   being published, because the template draft is already written before
 *   this module is called and is what gets stored if anything here disappoints.
 *
 * Everything below therefore returns null on any doubt. There is no throw path
 * a caller has to remember to catch, because a forgotten catch here would take
 * down publication - exactly the coupling this design exists to prevent.
 */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
/* Pinned deliberately: a floating alias would change the newsroom's voice
 * without a commit, and model_version on every article must mean something. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export const isConfigured = (env) => Boolean(env?.ANTHROPIC_API_KEY);

/**
 * Ask Claude to rewrite a draft. Returns null rather than throwing, ever.
 *
 * `timeoutMs` is short on purpose. A scheduled newsroom would rather publish
 * the deterministic version on time than wait on a slow enhancement.
 */
export async function enhance(env, { system, prompt, maxTokens = 2000, timeoutMs = 25000, model = DEFAULT_MODEL } = {}) {
  if (!isConfigured(env)) return null;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      /* The body can echo request content back. Status and model only. */
      console.warn(`[newsroom] anthropic http ${res.status}; keeping deterministic draft`);
      return null;
    }
    const body = await res.json();
    const text = (body?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return null;
    return { text, model: body?.model || model, provider: 'anthropic' };
  } catch (e) {
    /* Timeout, DNS, abort, malformed JSON - all the same decision. */
    console.warn(`[newsroom] anthropic unavailable (${e?.name || 'Error'}); keeping deterministic draft`);
    return null;
  }
}

/**
 * Parse a JSON envelope out of a model reply.
 *
 * Models wrap JSON in prose or fences often enough that being strict here
 * would discard usable work, and being loose costs nothing: the result still
 * has to pass the editorial gates before it can replace anything.
 */
export function parseEnvelope(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/**
 * The complete enhancement decision for one article.
 *
 * Takes the deterministic draft and returns what should be stored. It returns
 * the draft unchanged unless every step succeeded AND the caller's gate
 * accepted the result, so the only way to publish an enhanced version is for
 * it to be strictly better by the same rules the template had to satisfy.
 */
export async function enhanceOrKeep(env, draft, { system, prompt, gate, model = DEFAULT_MODEL } = {}) {
  const kept = { ...draft, model_version: draft.model_version || 'template' };
  const reply = await enhance(env, { system, prompt, model });
  if (!reply) return { article: kept, enhanced: false, reason: 'provider unavailable or not configured' };

  const parsed = parseEnvelope(reply.text);
  if (!parsed) return { article: kept, enhanced: false, reason: 'unparseable model output' };

  const candidate = { ...draft, ...parsed, model_version: `anthropic:${reply.model}` };
  const verdict = gate ? gate(candidate, draft) : { ok: true };
  if (!verdict.ok) {
    console.warn(`[newsroom] enhancement rejected by gate: ${verdict.reason}`);
    return { article: kept, enhanced: false, reason: `gate: ${verdict.reason}` };
  }
  return { article: candidate, enhanced: true, reason: 'accepted' };
}
