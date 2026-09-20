// PBE record alerts: overdue grading and record-integrity failures, to Discord.
//
// ISOLATION. This module reads ONE thing, the public record-health endpoint of
// the UFC site, and writes TWO things: a Discord message and its own state
// object in R2. It imports nothing and runs in its own Worker (ufc-record-alerts)
// that has no database binding, no service binding and no model secret, so it
// cannot evaluate, draft, lock, grade, train or promote, and nothing it does or
// fails to do can reach ufc-algo. Every await in runRecordAlerts is wrapped, and
// Discord delivery never throws.
//
// ONE DEFINITION OF HEALTH. "Overdue", "orphan grade" and "duplicated record"
// are decided by the site (web/lib/algoArchive.ts -> /api/ufc/record-health),
// the same index the public archive renders. Nothing is re-derived here.
//
// PRIVACY. The health payload is aggregates plus event id/name/date. Messages
// are built field by field from that whitelist: no fighter, side, probability,
// price or prediction id exists in anything this module can reach.
//
// NOISE. The cron runs every CHECK_EVERY_MINUTES (wrangler.toml). A
// condition alerts once when it appears, again only after REMIND_HOURS while it
// persists, and the whole record alerts RECOVERED once when it returns to PASS.
// A read failure must repeat READ_FAILURE_CONFIRM checks before it alerts, and a
// failed read is never mistaken for a recovery. State lives in R2, so a Worker
// restart, redeploy or isolate eviction does not repeat an alert. An undelivered
// alert (Discord down, webhook not configured) is retried every RETRY_MINUTES
// and is not counted as sent.

export const DEFAULT_HEALTH_URL = 'https://ufc.propbetedge.ai/api/ufc/record-health';
export const STATE_KEY = 'ops/record-alerts/state.json';
export const CHECK_EVERY_MINUTES = 5;
export const REMIND_HOURS = 24;
export const RETRY_MINUTES = 15;
export const READ_FAILURE_CONFIRM = 3;

const CLASS_LABEL = {
  GRADING_OVERDUE: 'GRADING OVERDUE',
  ORPHAN_GRADE: 'GRADE WITHOUT A LOCKED PREDICTION',
  DUPLICATE_RECORD: 'DUPLICATED RECORD',
  READ_FAILURE: 'RECORD STORE READ FAILURE',
};

const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
const clean = (v, max = 90) => String(v ?? '').replace(/[`*_~|@<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

/** Health payload -> the conditions that are wrong right now. `null` means the
 *  record could not be read, which is a condition of its own and says nothing
 *  about the others. */
export function classify(health) {
  if (!health || typeof health !== 'object' || health.read_error || !health.integrity) {
    return { readable: false, conditions: [{ key: 'read_failure', klass: 'READ_FAILURE' }] };
  }
  const conditions = [];
  for (const o of Array.isArray(health.overdue) ? health.overdue : []) {
    if (!isUuid(o?.event_id) || !isDate(o?.event_date)) continue;
    conditions.push({ key: `overdue:${o.event_id}`, klass: 'GRADING_OVERDUE', event_id: o.event_id, event_name: clean(o.event_name), event_date: o.event_date, pending: int(o.pending), oldest_pending_hours: int(o.pending_age_hours) });
  }
  const i = health.integrity;
  if (int(i.orphan_grade_predictions) > 0) conditions.push({ key: 'orphan_grade', klass: 'ORPHAN_GRADE', count: int(i.orphan_grade_predictions) });
  const dup = int(i.duplicate_predictions) + int(i.duplicate_grades);
  if (dup > 0) conditions.push({ key: 'duplicate_record', klass: 'DUPLICATE_RECORD', count: dup });
  return { readable: true, conditions, pending_total: int(i.pending) };
}

export function alertMessage(c) {
  const lines = ['**UFC PBE RECORD ALERT**'];
  if (c.klass === 'GRADING_OVERDUE') {
    lines.push(`Event: ${c.event_name || 'Event'} — ${c.event_date}`, `Event ID: ${c.event_id}`, `State: ${CLASS_LABEL[c.klass]}`, `Pending official locks: ${c.pending}`, `Oldest pending: ${c.oldest_pending_hours}h`);
  } else if (c.klass === 'READ_FAILURE') {
    lines.push(`State: ${CLASS_LABEL[c.klass]}`, `Consecutive failed checks: ${int(c.failures)}`, 'Pending official locks: unknown (record unreadable)');
  } else {
    lines.push(`State: ${CLASS_LABEL[c.klass]}`, `Affected records: ${int(c.count)}`);
  }
  if (c.reminder) lines.push(`Reminder: unresolved for ${int(c.open_hours)}h`);
  lines.push('Record health: FAIL');
  return lines.join('\n');
}

export function recoveryMessage(cleared) {
  const overdue = cleared.filter((c) => c.klass === 'GRADING_OVERDUE');
  const others = [...new Set(cleared.filter((c) => c.klass !== 'GRADING_OVERDUE').map((c) => CLASS_LABEL[c.klass]))];
  const lines = ['**UFC PBE RECORD RECOVERED**'];
  if (overdue.length) lines.push(`Event grading is current${overdue.length === 1 ? ` (${overdue[0].event_name || 'Event'} — ${overdue[0].event_date})` : ` (${overdue.length} events)`}.`);
  if (others.length) lines.push(`Cleared: ${others.join(', ')}.`);
  lines.push('Record health returned to PASS.');
  return lines.join('\n');
}

const emptyState = () => ({ version: 1, health: 'UNKNOWN', read_failures: 0, active: {}, recovery: null });

/**
 * Pure. Previous state + this check -> the messages to send and the next state.
 * `sends` carry a `commit(delivered)` closure target via `key`; the caller
 * reports delivery back through settle().
 */
export function decide({ previous, check, now }) {
  const prev = previous && previous.version === 1 ? previous : emptyState();
  /* A deep copy: `previous` must stay as it was read, or "did the state change" can never be answered. */
  const next = JSON.parse(JSON.stringify({ version: 1, health: prev.health, read_failures: prev.read_failures, active: prev.active || {}, recovery: prev.recovery || null }));
  const sends = [];
  const due = (entry, minutes) => !entry.last_attempt_at || now - Date.parse(entry.last_attempt_at) >= minutes * 60e3;

  if (!check.readable) {
    /* Unknown, not healthy: keep every active condition exactly as it was. */
    next.read_failures = prev.read_failures + 1;
    next.health = next.read_failures >= READ_FAILURE_CONFIRM ? 'FAIL' : prev.health;
    if (next.read_failures >= READ_FAILURE_CONFIRM) consider({ key: 'read_failure', klass: 'READ_FAILURE', failures: next.read_failures });
    return { sends, next };
  }

  next.read_failures = 0;
  const present = new Map(check.conditions.map((c) => [c.key, c]));
  for (const c of present.values()) consider(c);

  /* Conditions that are gone. Only a DELIVERED alert earns a recovery notice. */
  const cleared = [];
  for (const [key, entry] of Object.entries(next.active)) {
    if (present.has(key)) continue;
    if (entry.delivered) cleared.push(entry.summary);
    delete next.active[key];
  }
  if (cleared.length) next.recovery = { cleared: [...(next.recovery?.cleared || []), ...cleared], last_attempt_at: next.recovery?.last_attempt_at || null };

  const healthy = present.size === 0;
  next.health = healthy ? 'PASS' : 'FAIL';
  /* One RECOVERED, and only when the whole record is back to PASS. */
  if (healthy && next.recovery && due(next.recovery, RETRY_MINUTES)) sends.push({ kind: 'recovered', key: null, loud: false, content: recoveryMessage(next.recovery.cleared) });
  /* While anything is still wrong, cleared conditions wait here and are named in that one notice. */
  return { sends, next };

  function consider(c) {
    const entry = next.active[c.key];
    const summary = { klass: c.klass, event_id: c.event_id, event_name: c.event_name, event_date: c.event_date };
    if (!entry) {
      next.active[c.key] = { first_seen_at: new Date(now).toISOString(), delivered: false, last_alert_at: null, last_attempt_at: null, alerts: 0, summary };
      sends.push({ kind: 'alert', key: c.key, loud: true, content: alertMessage(c) });
      return;
    }
    entry.summary = summary;
    if (!entry.delivered) {
      if (due(entry, RETRY_MINUTES)) sends.push({ kind: 'alert', key: c.key, loud: true, content: alertMessage(c) });
      return;
    }
    if (now - Date.parse(entry.last_alert_at) >= REMIND_HOURS * 3600e3) {
      sends.push({ kind: 'reminder', key: c.key, loud: false, content: alertMessage({ ...c, reminder: true, open_hours: (now - Date.parse(entry.first_seen_at)) / 3600e3 }) });
    }
  }
}

/** Fold delivery results into the state decide() produced. */
export function settle(next, results, now) {
  const at = new Date(now).toISOString();
  for (const { send, delivered } of results) {
    if (send.kind === 'recovered') {
      if (delivered) next.recovery = null; else if (next.recovery) next.recovery.last_attempt_at = at;
      continue;
    }
    const entry = next.active[send.key];
    if (!entry) continue;
    entry.last_attempt_at = at;
    if (delivered) { entry.delivered = true; entry.last_alert_at = at; entry.alerts = int(entry.alerts) + 1; }
  }
  return next;
}

/* Discord webhook, the same contract as ufc-stats-ingest/src/discord.mjs: it
 * never throws, because alerting must not be able to fail anything else. */
export async function discord(env, content, { loud = false, fetchImpl = fetch } = {}) {
  const url = String(env.DISCORD_WEBHOOK_URL || '').trim();
  if (!url) return false;
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${loud ? '@here ' : ''}${content}`.slice(0, 1900) }) });
    if (!r.ok) console.error(`[record-alerts] discord HTTP ${r.status}`);
    return Boolean(r.ok);
  } catch (e) {
    console.error(`[record-alerts] discord failed ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}

async function readHealth(env, fetchImpl) {
  try {
    const r = await fetchImpl(String(env.RECORD_HEALTH_URL || DEFAULT_HEALTH_URL), { headers: { accept: 'application/json', 'user-agent': 'ufc-algo-record-alerts' }, cf: { cacheTtl: 0 } });
    /* 503 is the endpoint's own "unhealthy" answer and still carries the payload. */
    if (r.status !== 200 && r.status !== 503) return null;
    const body = await r.json();
    return body && body.service === 'ufc-pbe-record' ? body : null;
  } catch {
    return null;
  }
}

/** One check. Never throws; returns a small report for logs and /health. */
export async function runRecordAlerts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const bucket = env.ARTIFACTS;
    if (!bucket) return { ok: false, skipped: 'no_state_store' };
    let previous = null;
    try { const obj = await bucket.get(STATE_KEY); previous = obj ? await obj.json() : null; } catch { return { ok: false, skipped: 'state_unreadable' }; }
    /* Without readable state an alert could repeat every check: send nothing. */
    const check = classify(await readHealth(env, fetchImpl));
    const { sends, next } = decide({ previous, check, now });
    const results = [];
    for (const send of sends) results.push({ send, delivered: await discord(env, send.content, { loud: send.loud, fetchImpl }) });
    settle(next, results, now);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      try { await bucket.put(STATE_KEY, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } }); } catch (e) { console.error(`[record-alerts] state write failed ${String(e?.message || e).slice(0, 120)}`); }
    }
    const report = { ok: true, health: next.health, active: Object.keys(next.active).length, sent: results.filter((r) => r.delivered).map((r) => r.send.kind), undelivered: results.filter((r) => !r.delivered).length, discord_configured: Boolean(String(env.DISCORD_WEBHOOK_URL || '').trim()) };
    if (results.length) console.log(`[record-alerts] ${JSON.stringify(report)}`);
    return report;
  } catch (e) {
    console.error(`[record-alerts] check failed ${String(e?.message || e).slice(0, 160)}`);
    return { ok: false, error: 'check_failed' };
  }
}

/** For GET /health: classes and counts only. */
export async function recordAlertStatus(env) {
  try {
    const obj = await env.ARTIFACTS?.get(STATE_KEY);
    const s = obj ? await obj.json() : null;
    if (!s) return { health: 'UNKNOWN', active: [], discord_configured: Boolean(String(env.DISCORD_WEBHOOK_URL || '').trim()) };
    return { health: s.health, read_failures: s.read_failures, active: Object.values(s.active).map((e) => ({ class: e.summary?.klass, event_date: e.summary?.event_date || null, first_seen_at: e.first_seen_at, delivered: e.delivered, alerts: e.alerts })), recovery_pending: Boolean(s.recovery), discord_configured: Boolean(String(env.DISCORD_WEBHOOK_URL || '').trim()) };
  } catch {
    return { health: 'UNKNOWN', error: 'state_unreadable' };
  }
}
