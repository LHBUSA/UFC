/**
 * The recovery rules, as pure functions.
 *
 * The database enforces these — store_claim_slug, store_expire_stale_claims,
 * store_record_absent and store_settle_absent all refuse work that breaks
 * them, so a buggy client is rejected rather than believed. This module
 * exists so the same rules can be reasoned about and tested without a
 * database, and so the script asks for the right transition instead of
 * discovering the refusal.
 *
 * If these two ever disagree, SQL wins. It is the one a second process
 * cannot bypass.
 */

/** Only these two states may be claimed for a create attempt. */
export const CLAIMABLE = new Set(["unclaimed", "failed"]);

export const DEFAULTS = {
  /* How long a claim may go unreported before we assume its holder died. */
  staleMs: 10 * 60_000,
  /* How long an unobserved outcome must sit before absence can be concluded. */
  quarantineMs: 15 * 60_000,
  /* Two lookups a second apart observe the same instant, not two instants. */
  recheckMs: 2 * 60_000,
  /* How many independent absent observations before absence is credible. */
  minAbsentChecks: 3,
};

export function isClaimable(state) {
  return CLAIMABLE.has(state);
}

/**
 * Classify a provider response.
 *
 * The distinction that matters is not success versus failure, it is OBSERVED
 * versus UNOBSERVED. A 422 is an observed refusal: the provider processed the
 * request and declined it, so nothing was created. A timeout, an aborted
 * socket, a 502 or a 200 we cannot parse are all unobserved: the write may
 * have landed and we simply never heard.
 */
export function classifyOutcome({ transportError = null, status = null, parseError = false } = {}) {
  if (transportError) return "uncertain";
  if (status === null) return "uncertain";
  if (status === 429 || status >= 500) return "uncertain";
  if (status >= 400) return "failed";
  if (parseError) return "uncertain";
  return "ok";
}

/**
 * What to do with an abandoned claim.
 *
 * Never "reclaim". An old claim is not a failed one — the request it was
 * holding may have succeeded — so age converts it to uncertainty, not to
 * permission.
 */
export function decideStaleClaim(row, now = Date.now(), o = DEFAULTS) {
  if (row.state !== "in_flight") return { action: "leave", reason: `state is ${row.state}` };
  const claimedAt = Date.parse(row.claimed_at ?? 0) || 0;
  if (now - claimedAt < o.staleMs) return { action: "leave", reason: "claim is still live" };
  return { action: "expire-to-uncertain", uncertainSince: claimedAt };
}

/**
 * What to do with an uncertain row, given what the provider currently shows.
 *
 * `hits` is every product carrying our external_id, plural on purpose: the
 * provider is not assumed to enforce uniqueness on it, so a duplicate must be
 * detectable rather than hidden behind "take the first".
 */
export function decideReconcile(row, hits, now = Date.now(), o = DEFAULTS) {
  if (row.state === "created") return { action: "none", reason: "already created" };

  if (hits.length > 1) {
    /* Two products carry our external_id. Which one to keep is a judgement
     * about a real listing in a real store, and deleting the wrong one is not
     * a decision a script gets to make. */
    return { action: "escalate", reason: `${hits.length} products carry this external_id`, ids: hits.map((h) => h.id) };
  }

  if (hits.length === 1) {
    /* Positive evidence. It exists; no waiting period applies to a fact. */
    return { action: "adopt", productId: hits[0].id };
  }

  /* Zero matches. This is the case that must NOT immediately hand the slug
   * back for another create. The provider's listing is not guaranteed to be
   * read-your-writes, so "not there yet" and "never created" look identical
   * at this moment and are only distinguishable by waiting. */
  const uncertainSince = Date.parse(row.uncertain_since ?? 0) || 0;
  const lastCheck = row.last_absent_check_at ? Date.parse(row.last_absent_check_at) : null;
  const checks = row.absent_checks ?? 0;

  const quarantineElapsed = now - uncertainSince >= o.quarantineMs;
  const enoughChecks = checks >= o.minAbsentChecks;

  if (quarantineElapsed && enoughChecks) {
    return { action: "settle-absent", checks, waitedMs: now - uncertainSince };
  }

  /* Record another observation, but only if enough time has passed since the
   * last one for it to be independent evidence. */
  if (lastCheck === null || now - lastCheck >= o.recheckMs) {
    return {
      action: "record-absent",
      willBe: checks + 1,
      stillNeeds: {
        checks: Math.max(0, o.minAbsentChecks - (checks + 1)),
        ms: Math.max(0, o.quarantineMs - (now - uncertainSince)),
      },
    };
  }

  return {
    action: "wait",
    reason: !quarantineElapsed
      ? `quarantine has ${Math.ceil((o.quarantineMs - (now - uncertainSince)) / 1000)}s left`
      : `last check was too recent to count as independent evidence`,
  };
}
