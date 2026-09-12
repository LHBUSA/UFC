/* When the broadcast pass is worth running, and what it costs when it is not.
 *
 * The Cron Trigger fires every 30 minutes. That is the WAKE rate, not the
 * FETCH rate: most of the year the right answer is "the schedule was verified
 * nine hours ago, nothing is close, go back to sleep", and that answer must
 * cost one indexed query and zero upstream fetches.
 *
 * Cadence, from the brief:
 *   normal weeks      refresh every 6-12 hours
 *   inside ~24 hours  refresh more aggressively
 *   event day         every 30-60 minutes
 *
 * Expressed against the MAIN CARD INSTANT, not the calendar date, because that
 * is the thing readers are counting down to and the only field precise enough
 * to schedule against. A card at 01:00 UTC Sunday is an event-day card all
 * through Saturday evening US time, which a date comparison gets wrong.
 */

export const CADENCE = {
  live: 30,    // minutes — inside the broadcast window; every wake
  day: 30,     // minutes — under 6 hours out
  near: 60,    // minutes — under 24 hours out
  week: 360,   // minutes — 6 hours; fight week
  idle: 720,   // minutes — 12 hours; nothing close
};

export const WINDOW = {
  /* Hours before the main card at which each tier begins. */
  dayHours: 6,
  nearHours: 24,
  weekHours: 8 * 24,
  /* A card is "live" from its first published segment until this long after
   * the main card starts. Five hours covers a fourteen-bout numbered card with
   * a long walkout; it is a POLLING window, not a claim about the broadcast. */
  liveTailHours: 5,
};

/**
 * What this invocation should do.
 *
 * `nextStartIso` is the earliest published segment start of the soonest card
 * that has not finished; `mainCardIso` its main card. Both may be null, which
 * is itself a valid state (no schedule stored yet, or no card has a time).
 *
 * Returns `{ mode, reason, minEveryMinutes, skip, hoursOut }`.
 */
export function planWindow({ nextStartIso = null, mainCardIso = null, now = Date.now(), lastRunAt = null } = {}) {
  const anchor = Date.parse(mainCardIso ?? nextStartIso ?? '');
  const first = Date.parse(nextStartIso ?? mainCardIso ?? '');

  let mode;
  let reason;
  let hoursOut = null;

  if (!Number.isFinite(anchor)) {
    mode = 'idle';
    reason = nextStartIso || mainCardIso
      ? 'stored schedule has no parseable start time'
      : 'no upcoming card with a published start time';
  } else {
    hoursOut = (anchor - now) / 3600e3;
    const liveFrom = Number.isFinite(first) ? first : anchor;
    const liveUntil = anchor + WINDOW.liveTailHours * 3600e3;

    if (now >= liveFrom && now <= liveUntil) {
      mode = 'live';
      reason = `card is inside its broadcast window (main card ${hoursOut >= 0 ? `in ${hoursOut.toFixed(1)}h` : `${(-hoursOut).toFixed(1)}h ago`})`;
    } else if (now > liveUntil) {
      /* The soonest card we know about is already over and nothing newer has
       * been stored. Back off: the fix is a fresh listing parse, not a fast
       * one. */
      mode = 'idle';
      reason = `newest stored card finished ${((now - liveUntil) / 3600e3).toFixed(1)}h ago`;
    } else if (hoursOut <= WINDOW.dayHours) {
      mode = 'day';
      reason = `${hoursOut.toFixed(1)}h to the main card`;
    } else if (hoursOut <= WINDOW.nearHours) {
      mode = 'near';
      reason = `${hoursOut.toFixed(1)}h to the main card`;
    } else if (hoursOut <= WINDOW.weekHours) {
      mode = 'week';
      reason = `fight week: ${(hoursOut / 24).toFixed(1)} day(s) out`;
    } else {
      mode = 'idle';
      reason = `${Math.round(hoursOut / 24)} day(s) until the next card`;
    }
  }

  const minEveryMinutes = CADENCE[mode];
  const plan = {
    mode,
    reason,
    minEveryMinutes,
    hoursOut: hoursOut == null ? null : Number(hoursOut.toFixed(2)),
  };

  if (lastRunAt) {
    const sinceMin = (now - Date.parse(lastRunAt)) / 60000;
    if (Number.isFinite(sinceMin)) {
      if (sinceMin < 0) {
        /* Clock skew, or a ledger row written by a run still in flight. Treat
         * it as "just ran" rather than as "overdue by a negative amount". */
        return { ...plan, skip: true, reason: `${plan.reason}; last pass timestamp is in the future` };
      }
      if (sinceMin < minEveryMinutes) {
        /* The cheap exit: no fetch, no parse, no write. */
        return { ...plan, skip: true, reason: `${plan.reason}; last pass ${Math.round(sinceMin)}m ago, minimum ${minEveryMinutes}m` };
      }
    }
  }
  return { ...plan, skip: false };
}
