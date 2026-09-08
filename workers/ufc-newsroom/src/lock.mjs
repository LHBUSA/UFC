/* Single-flight for the newsroom, and an honest account of what it is worth.
 *
 * WHAT THE LEDGER LOCK IS. runlog.mjs reads ufc_ingest_runs for a row still
 * 'running' and, seeing none, inserts one. Read-then-write over PostgREST is
 * two round trips with no transaction, so two invocations that arrive inside
 * that gap both read "nothing running" and both proceed. It is advisory. It
 * reduces wasted work; it does not exclude anything.
 *
 * WHY THAT MATTERED MORE THAN IT LOOKED. The unique indexes on
 * ufc_news_items.fingerprint / .url and ufc_articles.slug do make duplicate
 * ROWS impossible — two writers produce one row and one conflict. They say
 * nothing about what was spent getting there. Both writers still build both
 * drafts and, when a key is configured, both pay Anthropic for the rewrite
 * before the loser's INSERT is rejected. A constraint that deduplicates after
 * the fact cannot deduplicate a bill.
 *
 * WHAT THIS IS. A Durable Object is single-threaded per id: requests to the
 * same object are serialised by the runtime, so read-then-write inside one is
 * atomic without a transaction, a lease table or a schema change. One object,
 * id 'newsroom', holds the lock. That makes concurrent runs genuinely
 * unconstructible rather than unlikely — and the claim is now made only about
 * the path that has this binding.
 *
 * WHAT IT IS STILL NOT. If the binding is absent the Worker falls back to the
 * advisory ledger check and says so in the run row; the guarantee then drops
 * back to "duplicate rows are impossible, duplicate work is merely unlikely".
 * A lock is never a substitute for the constraints, which is why both exist:
 * this stops the second run starting, and the database stops the second row
 * landing if one ever does.
 */

/**
 * Lease length. Past this a holder is presumed dead, because a Worker that is
 * CPU-killed or times out never releases. Matches STALE_RUN_MINUTES in
 * runlog.mjs — one crash must not stop the newsroom forever.
 *
 * What this lease does and does not guarantee, precisely:
 *
 *   ACQUISITION IS ATOMIC. The read of `holder` and the write that replaces it
 *   happen inside one Durable Object request. Requests to a single object are
 *   delivered one at a time and storage input-gate semantics hold concurrent
 *   callers at the await, so no interleaving is possible and exactly one of
 *   two simultaneous callers can win. This is the property no database
 *   constraint provides: it stops the second run STARTING, and so stops it
 *   paying Anthropic for work the first run is already doing.
 *
 *   SCHEDULED RUNS ARE COVERED FOR THEIR WHOLE POSSIBLE LIFETIME. Cloudflare
 *   caps a cron invocation at 15 minutes of wall clock, which is strictly less
 *   than this 20-minute lease, so a scheduled run can never outlive its own
 *   protection.
 *
 *   MANUAL RUNS ARE COVERED BY A DEADLINE, NOT BY THE PLATFORM. An HTTP
 *   invocation has no equivalent wall-clock cap, so index.js gives a manual
 *   run MANUAL_DEADLINE_MS (12 minutes) and abandons any remaining phases past
 *   it. The deadline is checked between phases and never interrupts one, which
 *   is why it sits eight minutes under the lease rather than at it: the margin
 *   is for the phase already in flight. There is no lease renewal, on purpose —
 *   a heartbeat would keep a wedged run alive and invisible for as long as it
 *   kept beating, and bounding the run is the smaller, truthful claim.
 *
 *   DEAD HOLDERS STAY RECOVERABLE. A holder past its lease is stolen rather
 *   than waited on, so a crash costs at most one lease and never the newsroom.
 *
 * Nothing here wraps the run in blockConcurrencyWhile: holding the object's
 * gate across external network I/O would serialise unrelated callers behind
 * the newsroom's own latency, which is a different and worse failure.
 */
export const DEFAULT_TTL_MS = 20 * 60 * 1000;

/**
 * How long a MANUAL run may execute before it abandons the rest of its phases.
 *
 * Lives here rather than in index.js for two reasons. It is meaningless except
 * in relation to DEFAULT_TTL_MS, and the two must be read together to see that
 * the bound is real. And the entry module may only export handlers and Durable
 * Object classes: workerd refuses to start with "Incorrect type for map entry
 * ... not of type 'function or ExportedHandler'" if a number is exported from
 * it. A bundler will not catch that — `wrangler deploy --dry-run` builds it
 * happily — so it surfaces only when the runtime boots.
 */
export const MANUAL_DEADLINE_MS = 12 * 60 * 1000;

export class NewsroomLock {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Number(url.searchParams.get('now')) || Date.now();

    if (url.pathname === '/acquire') {
      const ttlMs = Number(url.searchParams.get('ttl')) || DEFAULT_TTL_MS;
      const held = await this.ctx.storage.get('holder');
      if (held && now - held.at < held.ttlMs) {
        return Response.json({
          acquired: false,
          holder: held.token,
          age_minutes: Math.round((now - held.at) / 60000),
        });
      }
      const token = crypto.randomUUID();
      await this.ctx.storage.put('holder', { token, at: now, ttlMs });
      /* `stole` distinguishes a clean start from recovery after a crash. A run
       * that had to break a dead lock is worth seeing in the ledger. */
      return Response.json({ acquired: true, token, stole: Boolean(held) });
    }

    if (url.pathname === '/release') {
      const token = url.searchParams.get('token');
      const held = await this.ctx.storage.get('holder');
      /* Only the holder may release. Without this a run that overran its TTL
       * would, on finishing, delete the lock its successor legitimately took. */
      if (held && held.token === token) {
        await this.ctx.storage.delete('holder');
        return Response.json({ released: true });
      }
      return Response.json({ released: false, reason: held ? 'held by another run' : 'not held' });
    }

    if (url.pathname === '/state') {
      const held = await this.ctx.storage.get('holder');
      return Response.json({ held: Boolean(held), holder: held?.token ?? null, at: held?.at ?? null });
    }

    return new Response('not found', { status: 404 });
  }
}

/**
 * Take the single-flight lock, or report why not.
 *
 * Returns `{ kind: 'durable' | 'none', acquired, ... }`. `kind: 'none'` means
 * the binding is not configured and the caller must fall back to the advisory
 * ledger check — it never silently reports success it cannot deliver.
 */
export async function acquire(env, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!env?.NEWSROOM_LOCK) return { kind: 'none', acquired: false, reason: 'NEWSROOM_LOCK binding not configured' };
  const stub = env.NEWSROOM_LOCK.get(env.NEWSROOM_LOCK.idFromName('newsroom'));
  const res = await stub.fetch(`https://newsroom.lock/acquire?ttl=${ttlMs}&now=${now}`, { method: 'POST' });
  const body = await res.json();
  return { kind: 'durable', ...body };
}

/** Release a lock this run holds. Never throws: failing to release is bad —
 *  the next run waits out the TTL — but it must not mask the run's own
 *  outcome, which is the thing anyone reading the ledger came for. */
export async function release(env, token, { now = Date.now() } = {}) {
  if (!env?.NEWSROOM_LOCK || !token) return { released: false, reason: 'no lock held' };
  try {
    const stub = env.NEWSROOM_LOCK.get(env.NEWSROOM_LOCK.idFromName('newsroom'));
    const res = await stub.fetch(`https://newsroom.lock/release?token=${encodeURIComponent(token)}&now=${now}`, { method: 'POST' });
    return await res.json();
  } catch (e) {
    console.error(`[ufc-newsroom] lock release failed: ${String(e?.message || e).slice(0, 160)}`);
    return { released: false, reason: 'release failed' };
  }
}
