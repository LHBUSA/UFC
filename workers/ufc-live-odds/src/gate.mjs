/* The decision layer for paid live-odds polling — PURE, so every rule that can
 * spend money is testable without spending any.
 *
 * The Worker wakes every minute. Waking is free; calling the provider is not.
 * Everything here answers one question — may this tick make a paid request —
 * and it is separated from the I/O precisely so the answer can be proven
 * rather than observed after the invoice.
 *
 * Fails closed at every branch. An unknown state, a missing configuration, an
 * unreadable quota header and a stale event window all resolve to "do not
 * spend", because the cost of a skipped observation is one missing row and the
 * cost of an uncontrolled loop is the month's allowance.
 */

/** ESPN competition statuses that mean a bout is actually being contested. */
export const ACTIVE_STATUSES = new Set([
  'STATUS_IN_PROGRESS', 'STATUS_IN_PROGRESS_1', 'STATUS_IN_PROGRESS_2', 'STATUS_IN_PROGRESS_3',
  'STATUS_IN_PROGRESS_4', 'STATUS_IN_PROGRESS_5', 'STATUS_END_OF_ROUND', 'STATUS_HALFTIME',
]);

/** Statuses that mean a bout is about to start: walkouts have begun. */
export const IMMINENT_STATUSES = new Set([
  'STATUS_FIGHTERS_WALKING', 'STATUS_FIGHTERS_INTRODUCTION', 'STATUS_PRE_FIGHT',
]);

export const isActive = (status) => ACTIVE_STATUSES.has(String(status || ''));
export const isImminent = (status) => IMMINENT_STATUSES.has(String(status || ''));

/** The round a status encodes, when it encodes one. Never inferred otherwise. */
export function roundFromStatus(status, period) {
  const p = Number(period);
  if (Number.isInteger(p) && p >= 1 && p <= 5) return p;
  return null;
}

export function readConfig(env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    /* OFF unless explicitly enabled. A Worker that starts spending the moment
     * it is deployed is a Worker nobody can deploy safely. */
    enabled: String(env.LIVE_ODDS_ENABLED ?? 'false') === 'true',
    minRemaining: num(env.LIVE_ODDS_MIN_REMAINING, 5000),
    maxCardCost: num(env.LIVE_ODDS_MAX_CARD_COST, 250),
    eventWindowMinutes: num(env.LIVE_ODDS_EVENT_WINDOW_MINUTES, 45),
    closeHoursAfter: num(env.LIVE_ODDS_CLOSE_HOURS_AFTER, 7),
    minSecondsBetweenCalls: num(env.LIVE_ODDS_MIN_SECONDS_BETWEEN_CALLS, 55),
    hasKey: Boolean(env.ODDS_API_KEY),
  };
}

/**
 * Is this instant inside a card's live window?
 *
 * Opens `eventWindowMinutes` before the first scheduled bout and closes
 * `closeHoursAfter` later. Outside it the Worker does not even look at ESPN,
 * which is what makes a quiet week cost nothing at all.
 */
export function inEventWindow(now, startsAtIso, cfg) {
  if (!startsAtIso) return false;
  const start = Date.parse(startsAtIso);
  if (!Number.isFinite(start)) return false;
  const open = start - cfg.eventWindowMinutes * 60_000;
  const close = start + cfg.closeHoursAfter * 3_600_000;
  return now >= open && now <= close;
}

/**
 * May this tick make a paid provider request?
 *
 * Ordered cheapest-first on purpose: configuration, then window, then the
 * state we already fetched, then quota, then spacing. Every `false` names the
 * reason so a run row records why nothing was spent rather than leaving a
 * silent gap that looks identical to an outage.
 */
export function shouldPoll({ now, cfg, cardStartsAt, boutStatuses, quota, cardSpend, lastCallAt }) {
  if (!cfg.enabled) return { poll: false, reason: 'disabled' };
  if (!cfg.hasKey) return { poll: false, reason: 'no_api_key' };
  if (!inEventWindow(now, cardStartsAt, cfg)) return { poll: false, reason: 'outside_event_window' };

  const statuses = Array.isArray(boutStatuses) ? boutStatuses : [];
  const active = statuses.filter((s) => isActive(s.status));
  const imminent = statuses.filter((s) => isImminent(s.status));
  /* A card inside its window with nothing live is the normal state for most of
   * an evening: fights end, the next walkout has not begun. No spend. */
  if (!active.length && !imminent.length) return { poll: false, reason: 'no_active_or_imminent_bout' };

  /* Quota is MEASURED, never estimated. If the provider has not told us what
   * remains, we do not guess our way into spending. */
  if (quota && Number.isFinite(quota.remaining)) {
    if (quota.remaining <= cfg.minRemaining) {
      return { poll: false, reason: 'quota_reserve_reached', remaining: quota.remaining };
    }
  } else if (quota && quota.known === false) {
    return { poll: false, reason: 'quota_unknown' };
  }

  if (Number.isFinite(cardSpend) && cardSpend >= cfg.maxCardCost) {
    return { poll: false, reason: 'card_budget_exhausted', cardSpend };
  }

  /* Do not make a second paid request inside the same minute just because the
   * cron fired. The provider does not reprice that fast and a duplicate
   * request buys a duplicate row that the database will reject anyway. */
  if (lastCallAt) {
    const since = (now - Date.parse(lastCallAt)) / 1000;
    if (Number.isFinite(since) && since < cfg.minSecondsBetweenCalls) {
      return { poll: false, reason: 'too_soon', secondsSinceLastCall: Math.round(since) };
    }
  }

  return {
    poll: true,
    reason: active.length ? 'active_bout' : 'imminent_bout',
    activeBouts: active.map((s) => s.competitionId),
    imminentBouts: imminent.map((s) => s.competitionId),
  };
}

/**
 * Quota as the provider reports it. Headers only — nothing is inferred.
 *
 * The Odds API returns these on every metered response; `x-requests-last` is
 * what the call actually cost, which is the only number worth trusting when
 * predicting future cost.
 */
export function readQuotaHeaders(headers) {
  const get = (k) => {
    const v = headers?.get?.(k);
    /* An absent header is UNKNOWN, not zero. Number(null) is 0, and a 0 that
     * means "we did not read it" is the most dangerous value here: it would
     * present as a measured quota. */
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const used = get('x-requests-used');
  const remaining = get('x-requests-remaining');
  const last = get('x-requests-last');
  return { known: remaining !== null, used, remaining, last };
}
