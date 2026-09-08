// Preload for the one-time Fight DNA historical repair.
// This file must be loaded through NODE_OPTIONS so the spawned builder inherits it.
// Retries only operations that are safe to replay:
//   - GET/HEAD reads,
//   - PATCH updates,
//   - POST upserts to tables with explicit conflict keys in the builder.
// It intentionally does NOT retry the POST that creates ufc_dna_build_runs,
// because a lost response there could otherwise create duplicate ledger rows.
//
// Large JSON upsert batches can trip transient Supabase/Cloudflare 52x errors.
// For the three conflict-key upsert tables only, a repeatedly failing JSON
// array is bisected and replayed as smaller idempotent upserts. This avoids
// hammering the same 100/150-row payload until the workflow timeout.

const nativeFetch = globalThis.fetch.bind(globalThis);
const MAX_ATTEMPTS = 8;
const SPLIT_AFTER_ATTEMPT = 2;
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

function splitCandidate(url, method, init) {
  if (method !== 'POST' || !SAFE_POST_TABLES.some((path) => url.includes(path))) return null;
  if (typeof init?.body !== 'string') return null;
  try {
    const rows = JSON.parse(init.body);
    return Array.isArray(rows) && rows.length > 1 ? rows : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  return Math.min(12_000, 750 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
}

async function splitAndReplay(input, init, rows, url) {
  const mid = Math.ceil(rows.length / 2);
  const halves = [rows.slice(0, mid), rows.slice(mid)];
  console.warn(`[repair-fetch] splitting POST ${new URL(url).pathname} batch ${rows.length} -> ${halves[0].length}+${halves[1].length}`);
  for (const half of halves) {
    const response = await resilientFetch(input, { ...init, body: JSON.stringify(half) }, true);
    if (!response.ok) return response;
    try { await response.arrayBuffer(); } catch {}
  }
  return new Response(null, { status: 204 });
}

async function resilientFetch(input, init, allowSplit) {
  const url = urlOf(input);
  const method = methodOf(input, init);
  const safe = replaySafe(url, method);
  const rows = allowSplit ? splitCandidate(url, method, init) : null;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await nativeFetch(input, init);
      if (!safe || !RETRYABLE_STATUS.has(response.status)) return response;

      if (rows && attempt >= SPLIT_AFTER_ATTEMPT) {
        const status = response.status;
        try { await response.arrayBuffer(); } catch {}
        console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} -> ${status}; switching to smaller idempotent batches`);
        return splitAndReplay(input, init, rows, url);
      }

      if (attempt === MAX_ATTEMPTS) return response;
      try { await response.arrayBuffer(); } catch {}
      const delay = backoff(attempt);
      console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} -> ${response.status}; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (!safe) throw error;
      if (rows && attempt >= SPLIT_AFTER_ATTEMPT) {
        console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} network error; switching to smaller idempotent batches`);
        return splitAndReplay(input, init, rows, url);
      }
      if (attempt === MAX_ATTEMPTS) throw error;
      const delay = backoff(attempt);
      console.warn(`[repair-fetch] ${method} ${new URL(url).pathname} network error; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastError || new Error(`fetch failed after ${MAX_ATTEMPTS} attempts`);
}

globalThis.fetch = async function repairFetch(input, init) {
  return resilientFetch(input, init, true);
};
