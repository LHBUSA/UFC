/* When the weigh-in desk is live, and what it costs when it is not.
 *
 * A 2-5 minute cadence is right for the two hours either side of a scale and
 * absurd for the other 166 hours of the week. Cloudflare's smallest cron is a
 * minute, so the trigger fires far more often than the work is worth doing;
 * the saving has to come from the pass deciding, cheaply, that there is
 * nothing to do.
 *
 * "Cheaply" is the whole design. The out-of-window decision costs ONE indexed
 * query for the next event date and no source fetches at all — the expensive
 * part of a pass is fetching and parsing publisher pages, and that is exactly
 * what a no-op skips.
 */

/* UFC weigh-ins run the morning before the card: official weigh-ins around
 * 09:00 local with the ceremonial event later. Local time varies by venue and
 * we do not store venue timezone, so the window is deliberately generous in
 * UTC rather than clever and occasionally closed at the wrong moment. Being
 * awake for a few extra hours costs a handful of fetches; being asleep when
 * the scale runs costs the entire feature. */
export const WINDOW = {
  /* Live polling from this many hours before the event date's midnight UTC. */
  opensHoursBefore: 40,
  /* ...until this many hours before. Weigh-ins are always the previous day. */
  closesHoursBefore: 2,
  /* A slower watch either side, so a late correction or a rescheduled scale is
   * still picked up without running the fast loop for two days. */
  watchHoursBefore: 96,
};

export const CADENCE = {
  live: 3,      // minutes, inside the weigh-in window
  watch: 30,    // minutes, fight week but not weigh-in morning
  idle: 720,    // minutes, otherwise — twice a day, purely to notice a new card
};

/**
 * What this invocation should do, given the next event and the clock.
 *
 * Returns `{ mode, reason, minEveryMinutes, eventId }`. `mode` is 'live',
 * 'watch' or 'idle'; the caller compares `minEveryMinutes` against when it
 * last ran and skips without fetching anything if it is too soon.
 */
export function planWindow({ nextEvent = null, now = Date.now(), lastRunAt = null } = {}) {
  if (!nextEvent || !nextEvent.event_date) {
    return { mode: 'idle', reason: 'no upcoming event on file', minEveryMinutes: CADENCE.idle, eventId: null };
  }

  /* The card's own day, at midnight UTC. Weigh-ins are the morning before, so
   * the window is expressed as hours before that instant. */
  const cardAt = Date.parse(`${nextEvent.event_date}T00:00:00Z`);
  if (!Number.isFinite(cardAt)) {
    return { mode: 'idle', reason: 'unparseable event date', minEveryMinutes: CADENCE.idle, eventId: nextEvent.id };
  }
  const hoursOut = (cardAt - now) / 3600e3;

  let mode; let reason;
  if (hoursOut < -24) {
    mode = 'idle';
    reason = `the next event on file is ${Math.round(-hoursOut / 24)} day(s) in the past`;
  } else if (hoursOut <= WINDOW.opensHoursBefore && hoursOut >= WINDOW.closesHoursBefore) {
    mode = 'live';
    reason = `weigh-in window: ${hoursOut.toFixed(1)}h before ${nextEvent.event_date}`;
  } else if (hoursOut <= WINDOW.watchHoursBefore) {
    mode = 'watch';
    reason = `fight week but outside the scale window: ${hoursOut.toFixed(1)}h out`;
  } else {
    mode = 'idle';
    reason = `${Math.round(hoursOut / 24)} day(s) until the next card`;
  }

  const minEveryMinutes = CADENCE[mode];
  const plan = { mode, reason, minEveryMinutes, eventId: nextEvent.id, hoursOut: Number(hoursOut.toFixed(2)) };

  if (lastRunAt) {
    const sinceMin = (now - Date.parse(lastRunAt)) / 60000;
    /* Not "due yet" is the cheap exit. No fetches, no parsing, no writes. */
    if (Number.isFinite(sinceMin) && sinceMin < minEveryMinutes) {
      return { ...plan, skip: true, reason: `${plan.reason}; last pass ${Math.round(sinceMin)}m ago, minimum ${minEveryMinutes}m` };
    }
  }
  return { ...plan, skip: false };
}
