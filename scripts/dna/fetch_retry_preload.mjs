// Preload for the one-time Fight DNA historical repair.
// This file must be loaded through NODE_OPTIONS so the spawned builder inherits it.
// Retries only operations that are safe to replay:
//   - GET/HEAD reads,
//   - PATCH updates,
//   - POST upserts to tables with explicit conflict keys in the builder.
// It intentionally does NOT retry the POST that creates ufc_dna_build_runs,
// because a lost response there could otherwise create duplicate ledger rows.

const nativeFetch = globalThis.fetch.bind(globalThis);
const MAX_ATTEMPTS = 8;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const SAFE_POST_TABLES = [
  '/rest/v1/ufc_fighter_bout_features',
  '/rest/v1/ufc_fighter_dna_snapshots',
  '/rest/v1/ufc_fighter_stance_splits',
];

function methodOf(input, init) {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return String(input.method || 'GET').toUpperCase();
  return 'GET';
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || input);
}

function replaySafe(url, method) {
  if (method === 'GET' || method === 'HEAD' || method === 'PATCH') return true;
  if (method !== 'POST') return false;
  return SAFE_POST_TABLES.some((path) => url.includes(path));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  // 0.75s, 1.5s, 3s, 6s, then 12s, capped with small jitter.
  return Math.min(12_000, 750 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
}

globalThis.fetch = async function repairFetch(input, init) {
  const url = urlOf(input);
  const method = methodOf(input, init);
  const safe = replaySafe(url, method);
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await nativeFetch(input, init);
      if (!safe || !RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        return response;
      }
      // Consume the failed body before replaying so the connection can close.
      try { await response.arrayBuffer(); } catch {}
      const delay = backoff(attempt);
      console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} -> ${response.status}; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (!safe || attempt === MAX_ATTEMPTS) throw error;
      const delay = backoff(attempt);
      console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} network error; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastError || new Error(`fetch failed after ${MAX_ATTEMPTS} attempts`);
};
