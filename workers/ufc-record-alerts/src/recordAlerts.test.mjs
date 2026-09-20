// PBE record alerts: dedupe, cooldown, recovery, persistence, privacy and the
// guarantee that a broken Discord or a broken health read cannot touch grading.
// Run: npm test (workers/ufc-record-alerts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as RA from './recordAlerts.js';

const EVENT = '221ca353-f623-4b66-98aa-3a504a418236';
const T0 = Date.parse('2026-09-22T06:00:00Z');
const MIN = 60e3, HOUR = 3600e3;

const healthy = () => ({ service: 'ufc-pbe-record', ok: true, state: 'PASS', read_error: null, integrity: { locked: 21, graded: 21, pending: 0, unresolved_event_picks: 0, orphan_grade_predictions: 0, duplicate_predictions: 0, duplicate_grades: 0 }, overdue: [], oldest_pending_hours: null, events: 2 });
const overdue = (pending = 2, age = 49) => ({ ...healthy(), ok: false, state: 'FAIL', integrity: { ...healthy().integrity, graded: 21 - pending, pending }, overdue: [{ event_id: EVENT, event_name: 'UFC Fight Night', event_date: '2026-09-19', pending, days_overdue: 1, pending_age_hours: age }], oldest_pending_hours: age });

/* An R2 bucket that survives "restarts": the object outlives every env built on it. */
function bucket() {
  const objects = new Map();
  return { objects, async get(k) { return objects.has(k) ? { json: async () => JSON.parse(objects.get(k)) } : null; }, async put(k, v) { objects.set(k, String(v)); } };
}
/* fetch for both the health URL and the webhook. */
function net({ health, discordOk = true, discordThrows = false }) {
  const posts = [];
  const state = { health, discordOk, discordThrows };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('discord.test')) {
      if (state.discordThrows) throw new Error('socket hang up');
      posts.push(JSON.parse(init.body).content);
      return { ok: state.discordOk, status: state.discordOk ? 204 : 500 };
    }
    if (state.health === 'DOWN') throw new Error('connect ETIMEDOUT');
    if (state.health === 'HTML') return { status: 200, json: async () => { throw new Error('not json'); } };
    return { status: state.health.ok ? 200 : 503, json: async () => state.health };
  };
  return { posts, state, fetchImpl };
}
const envFor = (b, webhook = 'https://discord.test/hook') => ({ ARTIFACTS: b, DISCORD_WEBHOOK_URL: webhook });

test('an overdue card alerts once, not every check, and says exactly what the brief asks for', async () => {
  const b = bucket(); const n = net({ health: overdue(2, 49) });
  for (let i = 0; i < 60; i += 1) await RA.runRecordAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });   // five hours of checks
  assert.equal(n.posts.length, 1);
  assert.equal(n.posts[0], '@here **UFC PBE RECORD ALERT**\nEvent: UFC Fight Night — 2026-09-19\nEvent ID: 221ca353-f623-4b66-98aa-3a504a418236\nState: GRADING OVERDUE\nPending official locks: 2\nOldest pending: 49h\nRecord health: FAIL');
});

test('cooldown: a condition that persists is re-announced only after 24 hours, as a reminder', async () => {
  const b = bucket(); const n = net({ health: overdue(2, 49) });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 23 * HOUR + 55 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1);
  n.state.health = overdue(2, 73);
  await RA.runRecordAlerts(envFor(b), { now: T0 + 24 * HOUR, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2);
  assert.match(n.posts[1], /Oldest pending: 73h\nReminder: unresolved for 24h\nRecord health: FAIL$/);
  assert.doesNotMatch(n.posts[1], /@here/, 'a reminder is not loud');
});

test('state is persisted: a Worker restart or redeploy does not repeat an alert', async () => {
  const b = bucket(); const n = net({ health: overdue() });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  /* a brand-new isolate: new env object, same bucket, nothing in memory */
  for (let i = 1; i <= 10; i += 1) await RA.runRecordAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1);
  assert.ok(b.objects.has(RA.STATE_KEY));
  const writesBefore = b.objects.get(RA.STATE_KEY);
  await RA.runRecordAlerts(envFor(b), { now: T0 + 60 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(b.objects.get(RA.STATE_KEY), writesBefore, 'an unchanged state is not rewritten');
});

test('one RECOVERED when the record returns to PASS, and never a second one', async () => {
  const b = bucket(); const n = net({ health: overdue() });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  n.state.health = healthy();
  for (let i = 1; i <= 12; i += 1) await RA.runRecordAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });
  assert.deepEqual(n.posts.slice(1), ['**UFC PBE RECORD RECOVERED**\nEvent grading is current (UFC Fight Night — 2026-09-19).\nRecord health returned to PASS.']);
  assert.equal((await RA.recordAlertStatus(envFor(b))).health, 'PASS');
  // a later, separate incident alerts again
  n.state.health = overdue(1, 50);
  await RA.runRecordAlerts(envFor(b), { now: T0 + 3 * HOUR, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 3);
});

test('a record that was never unhealthy sends nothing at all', async () => {
  const b = bucket(); const n = net({ health: healthy() });
  for (let i = 0; i < 20; i += 1) await RA.runRecordAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 0);
});

test('two problems, one clears: no RECOVERED until the whole record is PASS, and then exactly one', async () => {
  const b = bucket();
  const both = { ...overdue(), integrity: { ...overdue().integrity, orphan_grade_predictions: 1 } };
  const n = net({ health: both });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2);
  assert.ok(n.posts.some((p) => /State: GRADE WITHOUT A LOCKED PREDICTION\nAffected records: 1\nRecord health: FAIL/.test(p)));
  n.state.health = { ...healthy(), ok: false, state: 'FAIL', integrity: { ...healthy().integrity, orphan_grade_predictions: 1 } };
  await RA.runRecordAlerts(envFor(b), { now: T0 + 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2, 'still failing: no recovery notice yet');
  n.state.health = healthy();
  await RA.runRecordAlerts(envFor(b), { now: T0 + 10 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 15 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 3);
  assert.match(n.posts[2], /RECOVERED\*\*\nEvent grading is current .*\nCleared: GRADE WITHOUT A LOCKED PREDICTION\.\nRecord health returned to PASS\.$/);
});

test('duplicated records alert with a count and never an id', async () => {
  const b = bucket();
  const n = net({ health: { ...healthy(), ok: false, state: 'FAIL', integrity: { ...healthy().integrity, duplicate_predictions: 1, duplicate_grades: 2 } } });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.match(n.posts[0], /State: DUPLICATED RECORD\nAffected records: 3\n/);
});

test('a read failure must repeat before it alerts, is never a recovery, and recovers once', async () => {
  const b = bucket(); const n = net({ health: overdue() });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });                    // overdue alert
  n.state.health = 'DOWN';
  await RA.runRecordAlerts(envFor(b), { now: T0 + 5 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 10 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1, 'one or two failed reads are a blip, and the overdue card is NOT reported recovered');
  n.state.health = 'HTML';
  await RA.runRecordAlerts(envFor(b), { now: T0 + 15 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2);
  assert.match(n.posts[1], /State: RECORD STORE READ FAILURE\nConsecutive failed checks: 3\nPending official locks: unknown/);
  for (let i = 4; i < 12; i += 1) await RA.runRecordAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2, 'a continuing outage does not repeat');
  n.state.health = overdue();                                                                  // readable again, still overdue
  await RA.runRecordAlerts(envFor(b), { now: T0 + 2 * HOUR, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2, 'still FAIL: the read-failure clearance waits for PASS');
  n.state.health = healthy();
  await RA.runRecordAlerts(envFor(b), { now: T0 + 3 * HOUR, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 3);
  assert.match(n.posts[2], /RECOVERED/);
  // the endpoint's own read_error is the same class
  assert.equal(RA.classify({ service: 'ufc-pbe-record', ok: false, read_error: 'record_store_unreadable', integrity: null, overdue: [] }).readable, false);
});

test('Discord failing never throws, never counts as sent, and is retried on a 15-minute cooldown', async () => {
  const b = bucket(); const n = net({ health: overdue(), discordThrows: true });
  const first = await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.deepEqual([first.ok, first.undelivered, first.sent], [true, 1, []]);
  n.state.discordThrows = false; n.state.discordOk = false;                                   // now HTTP 500
  await RA.runRecordAlerts(envFor(b), { now: T0 + 5 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 10 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 0, 'inside the retry cooldown nothing is attempted');
  await RA.runRecordAlerts(envFor(b), { now: T0 + 15 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1, 'one retry, which also failed');
  n.state.discordOk = true;
  await RA.runRecordAlerts(envFor(b), { now: T0 + 30 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 35 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2, 'delivered once Discord is back, then silent');
  // a recovery whose notice could not be delivered is retried, not lost and not doubled
  n.state.health = healthy(); n.state.discordOk = false;
  await RA.runRecordAlerts(envFor(b), { now: T0 + 40 * MIN, fetchImpl: n.fetchImpl });
  n.state.discordOk = true;
  await RA.runRecordAlerts(envFor(b), { now: T0 + 45 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 56 * MIN, fetchImpl: n.fetchImpl });
  await RA.runRecordAlerts(envFor(b), { now: T0 + 90 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.filter((p) => /RECOVERED/.test(p)).length, 2, 'one failed attempt + one delivered');
});

test('an unconfigured webhook, a missing bucket and an unreadable state all degrade to "send nothing", without throwing', async () => {
  const b = bucket(); const n = net({ health: overdue() });
  const r = await RA.runRecordAlerts(envFor(b, ''), { now: T0, fetchImpl: n.fetchImpl });
  assert.deepEqual([r.ok, r.discord_configured, r.undelivered], [true, false, 1]);
  assert.equal(JSON.parse(b.objects.get(RA.STATE_KEY)).active[`overdue:${EVENT}`].delivered, false, 'not recorded as sent, so it goes out once the secret exists');
  await RA.runRecordAlerts(envFor(b), { now: T0 + 20 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1);
  assert.deepEqual(await RA.runRecordAlerts({ DISCORD_WEBHOOK_URL: 'https://discord.test/hook' }, { now: T0, fetchImpl: n.fetchImpl }), { ok: false, skipped: 'no_state_store' });
  const broken = { async get() { throw new Error('r2 down'); }, async put() {} };
  assert.deepEqual(await RA.runRecordAlerts(envFor(broken), { now: T0, fetchImpl: n.fetchImpl }), { ok: false, skipped: 'state_unreadable' });
  const readOnly = { ...bucket(), async put() { throw new Error('r2 write refused'); } };
  assert.equal((await RA.runRecordAlerts(envFor(readOnly), { now: T0, fetchImpl: n.fetchImpl })).ok, true);
});

test('nothing private can reach Discord: messages are built from a whitelist, and markup is neutralised', async () => {
  const b = bucket();
  const hostile = overdue();
  Object.assign(hostile.overdue[0], { event_name: '@everyone **UFC** `x`\n<https://evil.test>', pick_fighter_id: 'ffffffff-0000-4000-8000-000000000001', prediction_id: 'cccccccc-0000-4000-8000-000000001200', fighter: 'Secret Fighter' });
  Object.assign(hostile, { picks: [{ id: 'cccccccc-0000-4000-8000-000000001201', pick_name: 'Secret Fighter' }], read_error: null });
  const n = net({ health: hostile });
  await RA.runRecordAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  const all = n.posts.join('\n') + b.objects.get(RA.STATE_KEY) + JSON.stringify(await RA.recordAlertStatus(envFor(b)));
  assert.doesNotMatch(all, /Secret Fighter|cccccccc-|ffffffff-|@everyone|evil\.test>|`x`/);
  assert.match(n.posts[0], /^@here \*\*UFC PBE RECORD ALERT\*\*\nEvent: everyone UFC x https:\/\/evil\.test — 2026-09-19\n/);
  // an overdue entry without a real event id / date is ignored rather than echoed
  assert.deepEqual(RA.classify({ ...healthy(), overdue: [{ event_id: 'x', event_name: 'n', event_date: 'soon', pending: 1 }] }).conditions, []);
});

test('isolation: the alert Worker has no way to reach the model, the database or grading', async () => {
  const src = readFileSync(new URL('./recordAlerts.js', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .*$/gm)].map((m) => m[0]), [], 'recordAlerts.js imports nothing');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /supabase|SUPABASE|ufc_model|gradeLocked|runCycle|publish_prediction|rest\/v1/, 'no database handle and no model call');
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.deepEqual([...index.matchAll(/^import .*$/gm)].map((m) => m[0]), ["import { runRecordAlerts, recordAlertStatus } from './recordAlerts.js';"]);
  assert.match(index, /ctx\.waitUntil\(runRecordAlerts\(env\)\.catch\(/);
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/^#.*$/gm, '');
  assert.doesNotMatch(toml, /SUPABASE|\[\[services\]\]|ALGO_|ufc-algo-artifacts|workflows/, 'no database var, no service binding, not the model bucket');
  assert.match(toml, /crons = \["\*\/5 \* \* \* \*"\]/);
  /* the model Worker does not know this exists */
  const algo = readFileSync(new URL('../../ufc-algo/src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(algo, /recordAlerts|record-alerts|DISCORD/);
  // a check whose every dependency explodes still resolves
  const bomb = { get ARTIFACTS() { throw new Error('boom'); } };
  assert.deepEqual(await RA.runRecordAlerts(bomb, { now: T0, fetchImpl: async () => { throw new Error('x'); } }), { ok: false, error: 'check_failed' });
});
