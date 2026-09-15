// The fight-week market contract: capture cadence AND market freshness. PURE.
//
// ONE definition, imported by both runtimes that depend on it:
//   workers/ufc-live-odds  decides when to buy a pre-fight snapshot
//   workers/ufc-algo       decides whether that snapshot is CURRENT for PBE Picks
// A snapshot is current exactly as long as the cadence we deliberately operate
// says the next one is not yet due (plus the scheduler tolerance), so the two
// can never disagree about what "current" means.
//
// Every band is relative to the PBE Algo lock DEADLINE for the card: event_date
// 00:00Z - 6h, the same instant the database refuses locks from
// (ufc_model_lock_cutoff). The lock window opens 2h earlier.
//
//   band     time to lock deadline   capture cadence   CURRENT while age <=
//   T-7d     more than 72h           every 720 min     730 min (720 + 10 tolerance)
//   T-72h    72h .. 24h              every 360 min     370 min (360 + 10 tolerance)
//   T-24h    final 24h and after     hourly            60 min  (no tolerance)
//
// The final band is deliberately strict: both lock passes (16:41Z and 17:41Z for
// a Saturday card) sit inside it, so the market recorded on an official lock is
// held to exactly the 60-minute rule it was accepted under.
//
// Age is measured from observed_at, when PropBetEdge last re-checked the market.
// A sportsbook that has not moved its price is still current; source_last_update
// (when a book last repriced) is provenance and never decides freshness.

export const LOCK_WINDOW_OPENS_HOURS = 8;
export const LOCK_WINDOW_CLOSES_HOURS = 6;
export const SCHEDULER_TOLERANCE_MINUTES = 10;

const H = 3_600_000;

export const lockWindowOpensFor = (eventDate) => Date.parse(`${eventDate}T00:00:00Z`) - LOCK_WINDOW_OPENS_HOURS * H;
/** The last moment an official call can lock: captures are scheduled up to here. */
export const lockDeadlineFor = (eventDate) => Date.parse(`${eventDate}T00:00:00Z`) - LOCK_WINDOW_CLOSES_HOURS * H;

/* Ordered by time: each band applies while (deadline - now) > minHoursToLock. */
export const FIGHT_WEEK_BANDS = Object.freeze([
  Object.freeze({ band: 'T-7d', minHoursToLock: 72, intervalMinutes: 720, currentMinutes: 720 + SCHEDULER_TOLERANCE_MINUTES }),
  Object.freeze({ band: 'T-72h', minHoursToLock: 24, intervalMinutes: 360, currentMinutes: 360 + SCHEDULER_TOLERANCE_MINUTES }),
  Object.freeze({ band: 'T-24h', minHoursToLock: -Infinity, intervalMinutes: 60, currentMinutes: 60 }),
]);

/** The band in force for a card at `now` (ms), ignoring any capture horizon. */
export function fightWeekBand(eventDate, now) {
  const lock = lockDeadlineFor(eventDate);
  if (!Number.isFinite(lock) || !Number.isFinite(now)) return null;
  const toLock = lock - now;
  const b = FIGHT_WEEK_BANDS.find((x) => toLock > x.minHoursToLock * H);
  return { ...b, lockDeadline: new Date(lock).toISOString(), toLockMinutes: toLock / 60_000 };
}

/**
 * Is a snapshot observed at `observedAt` the current market at `now`?
 * Unknown card date or timestamps fail closed to the strictest (60-minute) rule.
 *
 * current_until is the first instant it stops being current: the band limit can
 * shrink at a band boundary (730 -> 370 -> 60) before the snapshot's own limit
 * runs out, so a reader rendering later than the cycle can re-check with a plain
 * timestamp comparison instead of a second copy of these rules.
 */
export function marketFreshness(eventDate, observedAt, now) {
  const t = Date.parse(observedAt);
  const band = eventDate ? fightWeekBand(eventDate, now) : null;
  const strict = FIGHT_WEEK_BANDS[FIGHT_WEEK_BANDS.length - 1];
  const limit = band ? band.currentMinutes : strict.currentMinutes;
  if (!Number.isFinite(t) || !Number.isFinite(now)) return { current: false, band: band?.band ?? null, limit_minutes: limit, age_minutes: null, current_until: null };
  const age = Math.max(0, (now - t) / 60_000);
  const current = age <= limit;
  let until = null;
  if (current) {
    if (!band) until = t + limit * 60_000;
    else {
      const lock = lockDeadlineFor(eventDate);
      const i = FIGHT_WEEK_BANDS.findIndex((x) => x.band === band.band);
      for (let k = i; k < FIGHT_WEEK_BANDS.length; k++) {
        const seg = FIGHT_WEEK_BANDS[k];
        const segStart = k === i ? now : lock - FIGHT_WEEK_BANDS[k - 1].minHoursToLock * H;
        const segEnd = Number.isFinite(seg.minHoursToLock) ? lock - seg.minHoursToLock * H : Infinity;
        const expiry = t + seg.currentMinutes * 60_000;
        if (expiry < segStart) { until = segStart; break; }
        if (expiry < segEnd) { until = expiry; break; }
      }
    }
  }
  return { current, band: band?.band ?? null, limit_minutes: limit, age_minutes: age, current_until: until == null ? null : new Date(until).toISOString() };
}
