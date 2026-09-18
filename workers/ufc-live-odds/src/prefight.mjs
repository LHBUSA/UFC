/* Pre-fight market capture — the decision layer. PURE.
 *
 * A separate lane from live capture, with its own switch. The live lane polls
 * per minute during bouts and is gated by LIVE_ODDS_ENABLED; this lane buys a
 * handful of bulk snapshots in the week before a card so PBE Algo's
 * model-vs-market comparison at lock time is made against a current price.
 * Turning this on can never turn the live lane on, and vice versa.
 *
 * One provider call (GET /sports/mma_mixed_martial_arts/odds, regions=us,
 * markets=h2h) prices every listed MMA event at once, so the cadence is set by
 * the single most urgent upcoming UFC card and never multiplied per card.
 *
 * Cadence, relative to the card's PBE Algo lock DEADLINE. The lock window opens
 * at event_date 00:00Z - 8h and the database refuses locks from - 6h; the Algo
 * lock passes run at :41 inside it (16:41Z and 17:41Z for a Saturday card), so
 * capture must continue through the whole window, not stop when it opens:
 *   more than 7 days out        no scheduled capture
 *   7d .. 72h before deadline   every ~12h
 *   72h .. 24h before deadline  every ~6h
 *   final 24h before deadline   hourly, captured in the second half of the hour
 *                               so EVERY :41 pass, including both lock passes,
 *                               sees a snapshot < 60 min old
 *   after the deadline          none (the official comparison is already fixed)
 *
 * Fails closed: disabled, no key, unknown/stale quota, reserve reached, daily
 * cap reached, or a sufficiently fresh snapshot already on file -> no spend.
 */

/* Lock window, lock deadline and the band table are the shared fight-week
 * contract (scripts/odds/fight_week_cadence.mjs), which ufc-algo also reads to
 * decide whether a snapshot is CURRENT. Re-exported so existing imports hold. */
import { FIGHT_WEEK_BANDS, SCHEDULER_TOLERANCE_MINUTES, fightWeekBand, lockDeadlineFor, lockWindowOpensFor, LOCK_WINDOW_OPENS_HOURS, LOCK_WINDOW_CLOSES_HOURS } from '../../../scripts/odds/fight_week_cadence.mjs';
export { FIGHT_WEEK_BANDS, lockDeadlineFor, lockWindowOpensFor, LOCK_WINDOW_OPENS_HOURS, LOCK_WINDOW_CLOSES_HOURS };

/* Which bouts a price may attach to. Read through public.ufc_bouts_effective (migration 031): ufc_bouts.status is
 * never rewritten when a bout leaves a card (029), so filtering the stored word kept a bout the official card had
 * dropped as a match candidate. is_active is false only on CONFIRMED removal; a reported withdrawal while the card
 * still lists the bout leaves it a candidate, because the books still price it. */
const CANDIDATE_SELECT = 'id,event_id,is_active,status:effective_status,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name),event:ufc_events(id,event_date)';
export function boutCandidatesQuery(eventIds) {
  const ids = [...new Set((eventIds || []).filter(Boolean))];
  if (!ids.length) return null;
  return `ufc_bouts_effective?select=${CANDIDATE_SELECT}&event_id=${ids.length === 1 ? `eq.${ids[0]}` : `in.(${ids.join(',')})`}`;
}
/* Defence in depth: the row must say it is active AND not read cancelled/replaced, and have both corners. A row that
 * does not carry is_active at all is NOT a candidate: no price is attached on an unknown card state. */
export function matchableBouts(rows) {
  return (rows || []).filter((b) => b && b.is_active === true && b.status !== 'cancelled' && b.status !== 'replaced' && b.fighter_a && b.fighter_b);
}

export function readPrefightConfig(env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    enabled: String(env.PREFIGHT_ODDS_ENABLED ?? 'false') === 'true',
    hasKey: Boolean(env.ODDS_API_KEY),
    /* The live lane's reserve is the floor for both lanes: pre-fight spend can
     * never eat the allowance a live card needs. */
    minRemaining: num(env.PREFIGHT_ODDS_MIN_REMAINING, num(env.LIVE_ODDS_MIN_REMAINING, 5000)),
    horizonDays: num(env.PREFIGHT_ODDS_HORIZON_DAYS, 7),
    maxCallsPerDay: num(env.PREFIGHT_ODDS_MAX_CALLS_PER_DAY, 30),
    /* A snapshot this much younger than the cadence interval counts as fresh. */
    toleranceMinutes: num(env.PREFIGHT_ODDS_TOLERANCE_MINUTES, SCHEDULER_TOLERANCE_MINUTES),
    finalHourMinute: num(env.PREFIGHT_ODDS_FINAL_HOUR_MINUTE, 25),
    providerTimeoutMs: num(env.LIVE_ODDS_PROVIDER_TIMEOUT_MS, 8000),
  };
}

/** The cadence band for one card at `now`, or null when no capture is scheduled. */
export function cadenceFor(eventDate, now, cfg) {
  const lock = lockDeadlineFor(eventDate);
  if (!Number.isFinite(lock)) return null;
  const toLock = lock - now;
  if (toLock <= 0) return null;
  if (toLock > cfg.horizonDays * 86_400_000) return null;
  const b = fightWeekBand(eventDate, now);
  return { band: b.band, intervalMinutes: b.intervalMinutes, lockDeadline: b.lockDeadline };
}

/**
 * May this tick buy a pre-fight snapshot?
 *
 *   events         upcoming UFC cards [{ id, name, event_date }] (Algo scope)
 *   lastSnapshotAt newest successful bulk snapshot of ANY lane (a live or
 *                  descriptive call prices the same events and counts)
 *   callsToday     pre-fight paid calls already made in the current UTC day
 *   quota          { known, remaining, measuredAt } from the free /sports preflight
 */
export function shouldCapturePrefight({ now, cfg, events, lastSnapshotAt, callsToday, quota }) {
  if (!cfg.enabled) return { capture: false, reason: 'disabled' };
  if (!cfg.hasKey) return { capture: false, reason: 'no_api_key' };

  const bands = (events || [])
    .map((e) => ({ event: e, cadence: cadenceFor(e.event_date, now, cfg) }))
    .filter((x) => x.cadence)
    .sort((a, b) => a.cadence.intervalMinutes - b.cadence.intervalMinutes || Date.parse(a.cadence.lockDeadline) - Date.parse(b.cadence.lockDeadline));
  if (!bands.length) return { capture: false, reason: 'no_card_in_cadence_window' };
  const urgent = bands[0];
  const ctx = { band: urgent.cadence.band, interval_minutes: urgent.cadence.intervalMinutes, event: urgent.event.name, lock_deadline: urgent.cadence.lockDeadline };

  const ageMin = lastSnapshotAt ? (now - Date.parse(lastSnapshotAt)) / 60000 : Infinity;
  if (urgent.cadence.intervalMinutes === 60) {
    /* Final 24h: one snapshot per clock hour, taken in its second half, so the
     * lock pass at :41 always has one under an hour old. */
    const minute = new Date(now).getUTCMinutes();
    if (minute < cfg.finalHourMinute) return { capture: false, reason: 'waiting_for_capture_minute', ...ctx };
    const hourStart = now - (minute * 60_000 + new Date(now).getUTCSeconds() * 1000 + new Date(now).getUTCMilliseconds());
    const thisHour = lastSnapshotAt && Date.parse(lastSnapshotAt) >= hourStart + cfg.finalHourMinute * 60_000 - 60_000;
    if (thisHour) return { capture: false, reason: 'fresh_snapshot_on_file', snapshot_age_minutes: Math.round(ageMin), ...ctx };
  } else if (ageMin < urgent.cadence.intervalMinutes - cfg.toleranceMinutes) {
    return { capture: false, reason: 'fresh_snapshot_on_file', snapshot_age_minutes: Math.round(ageMin), ...ctx };
  }

  if (!Number.isFinite(callsToday)) return { capture: false, reason: 'daily_calls_unknown', ...ctx };
  if (callsToday >= cfg.maxCallsPerDay) return { capture: false, reason: 'daily_call_cap_reached', calls_today: callsToday, ...ctx };

  if (!quota || quota.known !== true || !Number.isFinite(quota.remaining)) return { capture: false, reason: 'quota_unknown', ...ctx };
  if (!quota.measuredAt || now - Date.parse(quota.measuredAt) > 10 * 60_000) return { capture: false, reason: 'quota_stale', ...ctx };
  if (quota.remaining <= cfg.minRemaining) return { capture: false, reason: 'quota_reserve_reached', remaining: quota.remaining, ...ctx };

  return { capture: true, reason: 'cadence_due', snapshot_age_minutes: Number.isFinite(ageMin) ? Math.round(ageMin) : null, ...ctx };
}
