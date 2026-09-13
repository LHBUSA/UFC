/* The paid-call decision. Run: node src/gate.test.mjs
 *
 * Every assertion here is about money. The Worker wakes 1,440 times a day and
 * the provider bills per request, so the rules that say "no" are the product.
 * They are pure precisely so they can be proven without spending a credit.
 */
import { shouldPoll, readConfig, inEventWindow, readQuotaHeaders, isActive, isImminent, roundFromStatus } from './gate.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

const CFG = readConfig({
  LIVE_ODDS_ENABLED: 'true', LIVE_ODDS_MIN_REMAINING: '5000', LIVE_ODDS_MAX_CARD_COST: '250',
  LIVE_ODDS_EVENT_WINDOW_MINUTES: '45', ODDS_API_KEY: 'k',
});
const START = Date.parse('2026-09-19T22:00:00Z');
const LIVE = [{ competitionId: '1', status: 'STATUS_IN_PROGRESS_2' }];
/* Quota now carries WHEN it was measured: a reading with no age, or an old
 * one, cannot authorise spending. */
const QUOTA = { known: true, remaining: 90000, used: 10000, last: 1, measuredAt: '2026-09-19T21:50:00Z' };
const base = { now: START + 60_000, cfg: CFG, cardStartsAt: '2026-09-19T22:00:00Z', boutStatuses: LIVE, quota: QUOTA, cardSpend: 0, lastCallAt: null };

/* ---- the one case that spends ------------------------------------------ */
{
  const r = shouldPoll(base);
  eq(r.poll, true, 'an active bout inside the window with quota should poll');
  eq(r.reason, 'active_bout', 'and say why');
}

/* ---- default is OFF ----------------------------------------------------- */
{
  const off = readConfig({ ODDS_API_KEY: 'k' });
  eq(off.enabled, false, 'LIVE_ODDS_ENABLED must default to false — a Worker that spends on deploy cannot be deployed safely');
  eq(shouldPoll({ ...base, cfg: off }).reason, 'disabled', 'disabled short-circuits before anything else');
}
{
  const noKey = readConfig({ LIVE_ODDS_ENABLED: 'true' });
  eq(shouldPoll({ ...base, cfg: noKey }).reason, 'no_api_key', 'no key means no call, not a failed one');
}

/* ---- the window: a quiet week must cost nothing ------------------------- */
{
  eq(inEventWindow(START - 60 * 60_000, '2026-09-19T22:00:00Z', CFG), false, 'an hour before the window opens');
  eq(inEventWindow(START - 44 * 60_000, '2026-09-19T22:00:00Z', CFG), true, 'inside the 45-minute lead');
  eq(inEventWindow(START + 6 * 3_600_000, '2026-09-19T22:00:00Z', CFG), true, 'still open six hours in');
  eq(inEventWindow(START + 8 * 3_600_000, '2026-09-19T22:00:00Z', CFG), false, 'closed after the card');
  eq(inEventWindow(START, null, CFG), false, 'no known start means no window, never an open one');
  eq(inEventWindow(START, 'not-a-date', CFG), false, 'an unparseable start fails closed');
  eq(shouldPoll({ ...base, now: START - 7 * 3_600_000 }).reason, 'outside_event_window', 'a Tuesday costs nothing');
}

/* ---- inside the window, but nothing is happening ------------------------ */
{
  const between = [{ competitionId: '1', status: 'STATUS_FINAL' }, { competitionId: '2', status: 'STATUS_SCHEDULED' }];
  eq(shouldPoll({ ...base, boutStatuses: between }).reason, 'no_active_or_imminent_bout',
    'the gaps between fights are most of an evening and must not spend');
  eq(shouldPoll({ ...base, boutStatuses: [] }).reason, 'no_active_or_imminent_bout', 'no statuses is not a reason to poll');
}
{
  /* Walkouts count: the pre-fight close has to be captured before the bell. */
  const walking = [{ competitionId: '9', status: 'STATUS_FIGHTERS_WALKING' }];
  const r = shouldPoll({ ...base, boutStatuses: walking });
  eq(r.poll, true, 'a walkout is the last chance at a pre-fight price');
  eq(r.reason, 'imminent_bout', 'and is reported as imminent, not active');
}

/* ---- quota: measured, never estimated ----------------------------------- */
{
  eq(shouldPoll({ ...base, quota: { known: true, remaining: 5000, measuredAt: '2026-09-19T21:50:00Z' } }).reason, 'quota_reserve_reached',
    'at the reserve exactly, stop');
  eq(shouldPoll({ ...base, quota: { known: true, remaining: 4999, measuredAt: '2026-09-19T21:50:00Z' } }).reason, 'quota_reserve_reached', 'below it, stop');
  eq(shouldPoll({ ...base, quota: { known: true, remaining: 5001, measuredAt: '2026-09-19T21:50:00Z' } }).poll, true, 'above it, proceed');
  eq(shouldPoll({ ...base, quota: { known: false } }).reason, 'quota_unknown',
    'an unreadable quota is not permission to spend');
  /* A figure from a previous card describes an allowance something else has
   * since spent. Age is part of whether a measurement is usable. */
  eq(shouldPoll({ ...base, quota: { ...QUOTA, measuredAt: '2026-09-08T12:25:00Z' } }).reason, 'quota_stale',
    'an eleven-day-old quota cannot authorise a paid call');
  eq(shouldPoll({ ...base, quota: { ...QUOTA, measuredAt: null } }).reason, 'quota_age_unknown',
    'a quota with no measurement time is unverified, not fresh');
}

/* ---- card budget -------------------------------------------------------- */
{
  eq(shouldPoll({ ...base, cardSpend: null }).reason, 'card_spend_unknown',
    'an unreadable card budget is not an empty one');
  eq(shouldPoll({ ...base, cardSpend: 250 }).reason, 'card_budget_exhausted', 'one card cannot run away with the month');
  eq(shouldPoll({ ...base, cardSpend: 249 }).poll, true, 'under budget still polls');
}

/* ---- spacing ------------------------------------------------------------ */
{
  const justCalled = new Date(base.now - 10_000).toISOString();
  eq(shouldPoll({ ...base, lastCallAt: justCalled }).reason, 'too_soon',
    'the cron firing is not a reason to buy the same snapshot twice');
  const aMinuteAgo = new Date(base.now - 61_000).toISOString();
  eq(shouldPoll({ ...base, lastCallAt: aMinuteAgo }).poll, true, 'a minute later is a new reading');
}

/* ---- status vocabulary -------------------------------------------------- */
{
  for (const s of ['STATUS_IN_PROGRESS', 'STATUS_IN_PROGRESS_3', 'STATUS_END_OF_ROUND']) eq(isActive(s), true, `${s} is active`);
  for (const s of ['STATUS_SCHEDULED', 'STATUS_FINAL', 'STATUS_CANCELED', '']) eq(isActive(s), false, `${s} is not active`);
  eq(isImminent('STATUS_FIGHTERS_WALKING'), true, 'walkouts are imminent');
  eq(isImminent('STATUS_FINAL'), false, 'a finished fight is not imminent');
  /* The round number comes from the source or not at all. */
  eq(roundFromStatus('STATUS_END_OF_ROUND', 2), 2, 'the period ESPN reports is the round');
  eq(roundFromStatus('STATUS_END_OF_ROUND', 0), null, 'period 0 is not a round');
  eq(roundFromStatus('STATUS_END_OF_ROUND', undefined), null, 'no period means no round, never a guess');
  eq(roundFromStatus('STATUS_IN_PROGRESS_2', null), null, 'the status suffix is NOT read as a round number');
}

/* ---- quota headers ------------------------------------------------------ */
{
  const h = new Map([['x-requests-used', '1291'], ['x-requests-remaining', '98709'], ['x-requests-last', '1']]);
  const q = readQuotaHeaders({ get: (k) => h.get(k) });
  eq(q.known, true, 'headers present means known');
  eq(q.used, 1291, 'used is read verbatim');
  eq(q.remaining, 98709, 'remaining is read verbatim');
  eq(q.last, 1, 'last cost is read verbatim — this is what a call actually cost');
  const missing = readQuotaHeaders({ get: () => null });
  eq(missing.known, false, 'absent headers are reported as unknown, not as zero');
  eq(missing.remaining, null, 'and never defaulted to a number that would permit spending');
}

console.log(failures === 0 ? 'gate.mjs: OK' : `gate.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
