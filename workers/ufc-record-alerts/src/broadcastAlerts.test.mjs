// Broadcast schedule alerts: RED pages once, AMBER never pages, recovery once,
// read failures need confirmation, state survives restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as BA from './broadcastAlerts.js';

const T0 = Date.parse('2026-11-12T15:00:00Z');
const MIN = 60e3;

const body = (conditions = [], status = conditions.some((c) => c.severity === 'RED') ? 'RED' : 'GREEN') => ({
  worker: 'ufc-broadcast-schedule', status,
  health: { status, conditions, canonical_next_event: { id: 'x', name: 'UFC Fight Night: Alpha vs. Bravo', event_date: '2026-11-14', days_out: 2 }, minutes_since_success: 30 },
});
const MISSING = { code: 'broadcast_missing', severity: 'RED', detail: 'UFC Fight Night: Alpha vs. Bravo (2026-11-14) is inside fight week with no resolved broadcast row' };
const NO_KEY = { code: 'missing_binding', severity: 'RED', detail: 'supabase_service_role_key is not configured; every pass fails before writing' };
const AMBER = { code: 'last_run_failed', severity: 'AMBER', detail: 'most recent pass failed' };

function bucket() {
  const objects = new Map();
  return { objects, async get(k) { return objects.has(k) ? { json: async () => JSON.parse(objects.get(k)) } : null; }, async put(k, v) { objects.set(k, String(v)); } };
}
function net(payload) {
  const posts = [];
  const state = { payload };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('discord.test')) { posts.push(JSON.parse(init.body).content); return { ok: true, status: 204 }; }
    if (state.payload === 'DOWN') throw new Error('ETIMEDOUT');
    const red = state.payload.health.conditions.some((c) => c.severity === 'RED');
    return { status: red ? 503 : 200, json: async () => state.payload };
  };
  return { posts, state, fetchImpl };
}
const envFor = (b) => ({ ARTIFACTS: b, DISCORD_WEBHOOK_URL: 'https://discord.test/hook', BROADCAST_HEALTH_URL: 'https://broadcast.test/health' });

test('RED in fight week alerts once, then stays quiet; recovery is announced once', async () => {
  const b = bucket(); const n = net(body([MISSING]));
  let r = await BA.runBroadcastAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.equal(r.health, 'RED');
  assert.equal(n.posts.length, 1);
  assert.match(n.posts[0], /UFC BROADCAST SCHEDULE INCIDENT/);
  assert.match(n.posts[0], /BROADCAST MISSING/);
  assert.match(n.posts[0], /UFC Fight Night: Alpha vs\. Bravo — 2026-11-14/);
  await BA.runBroadcastAlerts(envFor(b), { now: T0 + 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1, 'no repeat inside the reminder window');
  n.state.payload = body([]);
  r = await BA.runBroadcastAlerts(envFor(b), { now: T0 + 10 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(r.health, 'GREEN');
  assert.equal(n.posts.length, 2);
  assert.match(n.posts[1], /RECOVERED/);
});

test('a missing Worker secret pages, one alert per binding', async () => {
  const b = bucket(); const n = net(body([NO_KEY, { ...NO_KEY, detail: 'admin_token is not configured' }]));
  await BA.runBroadcastAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 2);
  assert.ok(n.posts.every((p) => /MISSING BINDING/.test(p)));
});

test('AMBER never pages', async () => {
  const b = bucket(); const n = net(body([AMBER], 'AMBER'));
  const r = await BA.runBroadcastAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 0);
  assert.equal(r.health, 'GREEN');
});

test('an unreachable /health alerts only after confirmation, and is never a recovery', async () => {
  const b = bucket(); const n = net('DOWN');
  for (let i = 0; i < 2; i += 1) await BA.runBroadcastAlerts(envFor(b), { now: T0 + i * 5 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 0);
  await BA.runBroadcastAlerts(envFor(b), { now: T0 + 10 * MIN, fetchImpl: n.fetchImpl });
  assert.equal(n.posts.length, 1);
  assert.match(n.posts[0], /UNREADABLE/);
});

test('a payload from another service is a read failure, not GREEN', () => {
  assert.equal(BA.classifyBroadcast({ service: 'ufc-pbe-record', ok: true }).readable, false);
  assert.equal(BA.classifyBroadcast(null).readable, false);
});

test('state is separate from the PBE record alerts', async () => {
  const b = bucket(); const n = net(body([MISSING]));
  await BA.runBroadcastAlerts(envFor(b), { now: T0, fetchImpl: n.fetchImpl });
  assert.deepEqual([...b.objects.keys()], [BA.BROADCAST_STATE_KEY]);
  const s = await BA.broadcastAlertStatus(envFor(b));
  assert.equal(s.health, 'RED');
  assert.equal(s.active[0].key, 'red:broadcast_missing');
});
