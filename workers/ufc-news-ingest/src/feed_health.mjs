/* Per-feed health, circuit breaker and conditional fetching, in KV.
 *
 * Ported from propbet-news-ingest v7, which has run this design across 18 feeds
 * and four sports since 2026-05 and caught two feeds dying within minutes of a
 * deploy (hoopshype 404, SLAM 403). The shape is kept deliberately close to the
 * original so a fix on either side is obviously portable to the other.
 *
 * WHAT EACH PIECE IS FOR
 *
 *   Circuit breaker. Five consecutive failures opens the circuit for 6 hours; a
 *   failure on the half-open retry extends it to 24. Without this a dead feed is
 *   fetched every two minutes forever, and at a two-minute cadence that is 720
 *   pointless requests a day per corpse - which is both rude to the publisher
 *   and, at eight seconds of timeout each, the thing that makes a run overrun.
 *
 *   Conditional fetching. ETag and Last-Modified are stored per feed and sent
 *   back as If-None-Match / If-Modified-Since. A 304 is a SUCCESS with no body,
 *   no parse and no database write. Most feeds are unchanged most of the time,
 *   and at this cadence that is the difference between polite and abusive.
 *
 *   Latency samples. A rolling window per feed, so "the ingest got slow" can be
 *   answered with which feed rather than a shrug.
 *
 * WHY KV AND NOT THE DATABASE
 *
 * This is operational state about fetching, read and written on every run and
 * interesting for days, not history anyone will query. ufc_news_sources holds
 * the durable facts (name, url, enabled); KV holds the volatile ones. Health
 * records carry a 90-day TTL so a feed we stop using cleans itself up.
 */

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const CIRCUIT_EXTENDED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const HEALTH_TTL_SECONDS = 90 * 24 * 60 * 60;
export const LATENCY_SAMPLES = 20;

const key = (name) => `feed:health:${name}`;

export function emptyHealth() {
  return {
    consecutive_failures: 0,
    total_successes: 0,
    total_failures: 0,
    total_not_modified: 0,
    last_success_ts: null,
    last_failure_ts: null,
    last_failure_reason: null,
    last_etag: null,
    last_modified: null,
    circuit_state: 'closed',
    cooldown_until_ts: null,
    latency_samples: [],
  };
}

export async function loadHealth(kv, name) {
  if (!kv) return emptyHealth();
  try {
    const raw = await kv.get(key(name));
    return raw ? { ...emptyHealth(), ...JSON.parse(raw) } : emptyHealth();
  } catch {
    return emptyHealth();
  }
}

export async function saveHealth(kv, name, health) {
  if (!kv) return;
  try {
    await kv.put(key(name), JSON.stringify(health), { expirationTtl: HEALTH_TTL_SECONDS });
  } catch {
    /* Health is an aid, not a gate. Losing a write costs observability for one
     * run; throwing here would cost the ingest. */
  }
}

export async function resetHealth(kv, name) {
  if (!kv) return false;
  await kv.put(key(name), JSON.stringify(emptyHealth()), { expirationTtl: HEALTH_TTL_SECONDS });
  return true;
}

export function recordLatency(health, ms) {
  if (!Number.isFinite(ms)) return;
  health.latency_samples = [...(health.latency_samples || []), Math.round(ms)].slice(-LATENCY_SAMPLES);
}

export function percentile(samples, p) {
  const arr = (samples || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

/** True when the circuit is open and the cooldown has not expired. */
export function isInCooldown(health, now) {
  return health.circuit_state === 'open'
    && Number.isFinite(health.cooldown_until_ts)
    && now < health.cooldown_until_ts;
}

/** An open circuit past its cooldown gets exactly one probing request. */
export function shouldHalfOpen(health, now) {
  return health.circuit_state === 'open'
    && Number.isFinite(health.cooldown_until_ts)
    && now >= health.cooldown_until_ts;
}

export function onSuccess(health, now, { latencyMs, etag, lastModified, notModified = false } = {}) {
  health.consecutive_failures = 0;
  health.total_successes += 1;
  if (notModified) health.total_not_modified += 1;
  health.last_success_ts = now;
  health.circuit_state = 'closed';
  health.cooldown_until_ts = null;
  /* Only overwrite validators we were actually given: a 304 carries no ETag on
   * some origins, and clearing it would turn every subsequent request back into
   * a full fetch. */
  if (etag) health.last_etag = etag;
  if (lastModified) health.last_modified = lastModified;
  recordLatency(health, latencyMs);
  return health;
}

export function onFailure(health, now, reason, { wasHalfOpen = false } = {}) {
  health.consecutive_failures += 1;
  health.total_failures += 1;
  health.last_failure_ts = now;
  health.last_failure_reason = String(reason || 'unknown').slice(0, 200);

  if (wasHalfOpen) {
    /* It was given a second chance and failed it. Back off hard rather than
     * retrying every six hours forever. */
    health.circuit_state = 'open';
    health.cooldown_until_ts = now + CIRCUIT_EXTENDED_COOLDOWN_MS;
  } else if (health.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD) {
    health.circuit_state = 'open';
    health.cooldown_until_ts = now + CIRCUIT_COOLDOWN_MS;
  }
  return health;
}

/** A compact, human-readable view for /feeds/health. */
export function summarize(name, health, now) {
  const total = health.total_successes + health.total_failures;
  return {
    source: name,
    circuit: health.circuit_state,
    cooling_down: isInCooldown(health, now),
    cooldown_remaining_minutes: isInCooldown(health, now)
      ? Math.round((health.cooldown_until_ts - now) / 60000) : null,
    consecutive_failures: health.consecutive_failures,
    successes: health.total_successes,
    failures: health.total_failures,
    not_modified: health.total_not_modified,
    success_rate: total ? Number((health.total_successes / total).toFixed(3)) : null,
    latency_ms: { p50: percentile(health.latency_samples, 50), p95: percentile(health.latency_samples, 95) },
    last_success_at: health.last_success_ts ? new Date(health.last_success_ts).toISOString() : null,
    last_failure_at: health.last_failure_ts ? new Date(health.last_failure_ts).toISOString() : null,
    last_failure_reason: health.last_failure_reason,
    has_etag: Boolean(health.last_etag),
    has_last_modified: Boolean(health.last_modified),
  };
}
