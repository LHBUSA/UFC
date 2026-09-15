/* Pre-fight capture decision. Run: node src/prefight.test.mjs
 * Every assertion is about money or about lock-time freshness. */
import { readPrefightConfig, cadenceFor, shouldCapturePrefight, lockAtFor } from './prefight.mjs';
import { readConfig } from './gate.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

const CFG = readPrefightConfig({ PREFIGHT_ODDS_ENABLED: 'true', ODDS_API_KEY: 'k', LIVE_ODDS_MIN_REMAINING: '5000' });
const CARD = { id: 'e331', name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19' };
const LOCK = lockAtFor('2026-09-19');
const H = 3_600_000;
const quotaAt = (now) => ({ known: true, remaining: 90000, used: 10000, measuredAt: new Date(now).toISOString() });
const decide = (over) => shouldCapturePrefight({ cfg: CFG, events: [CARD], lastSnapshotAt: null, callsToday: 0, quota: null, ...over });

eq(new Date(LOCK).toISOString(), '2026-09-18T16:00:00.000Z', 'lock is event day 00:00Z minus 8h');

/* ---- switches are independent ------------------------------------------ */
{
  eq(readPrefightConfig({ ODDS_API_KEY: 'k' }).enabled, false, 'PREFIGHT_ODDS_ENABLED defaults to false');
  eq(readConfig({ PREFIGHT_ODDS_ENABLED: 'true', ODDS_API_KEY: 'k' }).enabled, false, 'enabling pre-fight does NOT enable the live lane');
  eq(readPrefightConfig({ LIVE_ODDS_ENABLED: 'true', ODDS_API_KEY: 'k' }).enabled, false, 'enabling live does NOT enable pre-fight');
  const now = LOCK - 30 * H;
  eq(shouldCapturePrefight({ now, cfg: readPrefightConfig({ ODDS_API_KEY: 'k' }), events: [CARD], lastSnapshotAt: null, callsToday: 0, quota: quotaAt(now) }).reason, 'disabled', 'disabled lane never spends');
  eq(shouldCapturePrefight({ now, cfg: readPrefightConfig({ PREFIGHT_ODDS_ENABLED: 'true' }), events: [CARD], lastSnapshotAt: null, callsToday: 0, quota: quotaAt(now) }).reason, 'no_api_key', 'no key, no call');
}

/* ---- cadence bands ------------------------------------------------------ */
{
  eq(cadenceFor('2026-09-19', LOCK - 8 * 24 * H, CFG), null, 'outside 7 days: nothing scheduled');
  eq(cadenceFor('2026-09-19', LOCK - 6 * 24 * H, CFG).intervalMinutes, 720, 'T-7d..72h: 12h');
  eq(cadenceFor('2026-09-19', LOCK - 48 * H, CFG).intervalMinutes, 360, 'T-72h..24h: 6h');
  eq(cadenceFor('2026-09-19', LOCK - 5 * H, CFG).intervalMinutes, 60, 'final 24h: hourly');
  eq(cadenceFor('2026-09-19', LOCK + 60_000, CFG), null, 'after the lock: nothing');
}

/* ---- no duplicate paid call while a fresh snapshot exists -------------- */
{
  const now = LOCK - 48 * H;
  eq(decide({ now, lastSnapshotAt: new Date(now - 2 * H).toISOString(), quota: quotaAt(now) }).reason, 'fresh_snapshot_on_file', '6h band, 2h-old snapshot: no call');
  eq(decide({ now, lastSnapshotAt: new Date(now - 6 * H).toISOString(), quota: quotaAt(now) }).capture, true, '6h band, 6h-old snapshot: capture');
  eq(decide({ now: LOCK - 5 * 24 * H, lastSnapshotAt: new Date(LOCK - 5 * 24 * H - 8 * H).toISOString(), quota: quotaAt(LOCK) }).reason, 'fresh_snapshot_on_file', '12h band, 8h-old snapshot: no call');
}

/* ---- final 24h: one capture per hour, before the :41 lock pass --------- */
{
  const hour = Date.parse('2026-09-18T15:00:00Z');
  eq(decide({ now: hour + 10 * 60_000, quota: quotaAt(hour + 10 * 60_000) }).reason, 'waiting_for_capture_minute', 'not in the first half of the hour');
  const at = hour + 26 * 60_000;
  eq(decide({ now: at, lastSnapshotAt: new Date(hour - 34 * 60_000).toISOString(), quota: quotaAt(at) }).capture, true, 'second half of the hour with last hour\'s snapshot: capture');
  eq(decide({ now: hour + 50 * 60_000, lastSnapshotAt: new Date(at).toISOString(), quota: quotaAt(hour + 50 * 60_000) }).reason, 'fresh_snapshot_on_file', 'already captured this hour: no second call');
  /* A capture at :26 is 15 minutes old at the :41 lock pass. */
  eq((Date.parse('2026-09-18T15:41:00Z') - at) / 60000 <= 60, true, 'lock pass sees a snapshot under 60 minutes old');
}

/* ---- money guards ------------------------------------------------------- */
{
  const now = LOCK - 30 * H;
  eq(decide({ now, quota: null }).reason, 'quota_unknown', 'unknown quota refuses (caller then takes the free reading)');
  eq(decide({ now, quota: { known: true, remaining: 90000, measuredAt: new Date(now - 30 * 60_000).toISOString() } }).reason, 'quota_stale', 'a stale quota reading cannot authorise spend');
  eq(decide({ now, quota: { ...quotaAt(now), remaining: 4000 } }).reason, 'quota_reserve_reached', 'live reserve protects the live lane');
  eq(decide({ now, callsToday: 30, quota: quotaAt(now) }).reason, 'daily_call_cap_reached', 'daily cap');
  eq(decide({ now, callsToday: NaN, quota: quotaAt(now) }).reason, 'daily_calls_unknown', 'unreadable ledger refuses');
  eq(decide({ now, events: [{ ...CARD, name: "Dana White's Contender Series" , event_date: '2026-09-19' }].filter(() => false), quota: quotaAt(now) }).reason, 'no_card_in_cadence_window', 'no in-scope card, no call');
}

/* ---- one call covers every card: the most urgent card sets the cadence -- */
{
  const now = LOCK - 30 * H;
  const later = { id: 'e2', name: 'UFC Fight Night: Later', event_date: '2026-09-26' };
  const d = shouldCapturePrefight({ now, cfg: CFG, events: [later, CARD], lastSnapshotAt: new Date(now - 3 * H).toISOString(), callsToday: 0, quota: quotaAt(now) });
  eq(d.band, 'T-72h', 'nearest lock sets the band');
  eq(d.reason, 'fresh_snapshot_on_file', '3h-old snapshot is fresh for the 6h band');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('prefight: all assertions passed');
