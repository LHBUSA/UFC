// UFC broadcast schedule alerts: the How to Watch lane's health invariant, to Discord.
//
// Same watchdog, same rules as recordAlerts.js (dedupe, 24 h reminders, one
// RECOVERED, READ_FAILURE_CONFIRM before a read failure alerts, state in R2,
// Discord never throws) — only the input differs. It reads ONE public endpoint,
// the ufc-broadcast-schedule Worker's GET /health, which evaluates the invariant
// defined once in web/lib/broadcastHealth.ts:
//
//   a canonical UFC card inside fight week with no resolved broadcast row,
//   a missing Worker secret/binding, or a collector whose last success is older
//   than its cadence allows  ->  status RED (HTTP 503 with the payload).
//
// Only RED conditions alert. AMBER (a single failed pass, unpublished times) is
// visible on /health and is not paged. Nothing here can write the schedule.
import { decide, settle, discord, READ_FAILURE_CONFIRM } from './recordAlerts.js';

export const DEFAULT_BROADCAST_HEALTH_URL = 'https://ufc-broadcast-schedule.sales-fd3.workers.dev/health';
export const BROADCAST_STATE_KEY = 'ops/broadcast-alerts/state.json';

const clean = (v, max = 160) => String(v ?? '').replace(/[`*_~|@<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** /health payload -> the RED conditions present right now. */
export function classifyBroadcast(body) {
  if (!body || typeof body !== 'object' || body.worker !== 'ufc-broadcast-schedule' || !body.health || !Array.isArray(body.health.conditions)) {
    return { readable: false, conditions: [{ key: 'read_failure', klass: 'READ_FAILURE' }] };
  }
  const ev = body.health.canonical_next_event || null;
  const conditions = [];
  const seen = new Set();
  for (const c of body.health.conditions) {
    if (c?.severity !== 'RED') continue;
    const code = String(c.code ?? '').replace(/[^a-z_]/gi, '').slice(0, 40) || 'unknown';
    const detail = clean(c.detail);
    /* One alert per missing binding, one per other condition code. */
    const binding = String(c.detail ?? '').split(' ')[0].replace(/[^a-z_]/gi, '').slice(0, 40);
    const key = code === 'missing_binding' ? `red:${code}:${binding}` : `red:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conditions.push({
      key, klass: code, detail,
      event_name: ev ? clean(ev.name, 90) : undefined,
      event_date: ev && isDate(ev.event_date) ? ev.event_date : undefined,
      minutes_since_success: Number.isFinite(Number(body.health.minutes_since_success)) ? Math.trunc(Number(body.health.minutes_since_success)) : null,
    });
  }
  return { readable: true, conditions };
}

export function broadcastAlertMessage(c) {
  const lines = ['**UFC BROADCAST SCHEDULE INCIDENT**'];
  if (c.klass === 'READ_FAILURE') {
    lines.push('State: BROADCAST HEALTH UNREADABLE', `Consecutive failed checks: ${Math.trunc(Number(c.failures) || 0)}`);
  } else {
    lines.push(`Condition: ${String(c.klass).replace(/_/g, ' ').toUpperCase()}`, `Detail: ${c.detail || '-'}`);
    if (c.event_name) lines.push(`Next card: ${c.event_name}${c.event_date ? ` — ${c.event_date}` : ''}`);
    if (c.minutes_since_success != null) lines.push(`Minutes since last successful pass: ${c.minutes_since_success}`);
  }
  if (c.reminder) lines.push(`Reminder: unresolved for ${Math.trunc(Number(c.open_hours) || 0)}h`);
  lines.push('Homepage shows "Schedule verification temporarily unavailable" until fixed.', 'Broadcast health: RED');
  return lines.join('\n');
}

export function broadcastRecoveryMessage(cleared) {
  const codes = [...new Set(cleared.map((c) => String(c.klass).replace(/_/g, ' ').toUpperCase()))];
  return ['**UFC BROADCAST SCHEDULE RECOVERED**', `Cleared: ${codes.join(', ') || 'all conditions'}.`, 'Broadcast health returned to GREEN.'].join('\n');
}

async function readBroadcastHealth(env, fetchImpl) {
  try {
    const r = await fetchImpl(String(env.BROADCAST_HEALTH_URL || DEFAULT_BROADCAST_HEALTH_URL), { headers: { accept: 'application/json', 'user-agent': 'ufc-record-alerts/broadcast' }, cf: { cacheTtl: 0 } });
    /* 503 is the endpoint's own RED answer and still carries the payload. */
    if (r.status !== 200 && r.status !== 503) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** One check. Never throws. */
export async function runBroadcastAlerts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const bucket = env.ARTIFACTS;
    if (!bucket) return { ok: false, skipped: 'no_state_store' };
    let previous = null;
    try { const obj = await bucket.get(BROADCAST_STATE_KEY); previous = obj ? await obj.json() : null; } catch { return { ok: false, skipped: 'state_unreadable' }; }
    const check = classifyBroadcast(await readBroadcastHealth(env, fetchImpl));
    const { sends, next } = decide({ previous, check, now, alertFn: broadcastAlertMessage, recoveryFn: broadcastRecoveryMessage });
    const results = [];
    for (const send of sends) results.push({ send, delivered: await discord(env, send.content, { loud: send.loud, fetchImpl }) });
    settle(next, results, now);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      try { await bucket.put(BROADCAST_STATE_KEY, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } }); } catch (e) { console.error(`[broadcast-alerts] state write failed ${String(e?.message || e).slice(0, 120)}`); }
    }
    const report = { ok: true, health: next.health === 'PASS' ? 'GREEN' : next.health === 'FAIL' ? 'RED' : next.health, active: Object.keys(next.active).length, sent: results.filter((r) => r.delivered).map((r) => r.send.kind), undelivered: results.filter((r) => !r.delivered).length };
    if (results.length || report.health === 'RED') console.log(`[broadcast-alerts] ${JSON.stringify({ ...report, conditions: check.conditions.map((c) => c.key) })}`);
    return report;
  } catch (e) {
    console.error(`[broadcast-alerts] check failed ${String(e?.message || e).slice(0, 160)}`);
    return { ok: false, error: 'check_failed' };
  }
}

/** For GET /health. */
export async function broadcastAlertStatus(env) {
  try {
    const obj = await env.ARTIFACTS?.get(BROADCAST_STATE_KEY);
    const s = obj ? await obj.json() : null;
    if (!s) return { health: 'UNKNOWN', active: [] };
    return {
      health: s.health === 'PASS' ? 'GREEN' : s.health === 'FAIL' ? 'RED' : s.health,
      read_failures: s.read_failures,
      read_failure_confirm: READ_FAILURE_CONFIRM,
      active: Object.entries(s.active).map(([key, e]) => ({ key, first_seen_at: e.first_seen_at, delivered: e.delivered, alerts: e.alerts })),
      recovery_pending: Boolean(s.recovery),
    };
  } catch {
    return { health: 'UNKNOWN', error: 'state_unreadable' };
  }
}
