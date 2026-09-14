/* Round-archive gap detection and alert policy. Pure: no network, no clock of
 * its own (the caller passes `now`).
 *
 * WHY THIS EXISTS
 * ---------------
 * "Leaving UFCSTATS_ENABLED off is a silent outage" was written in wrangler.toml
 * and it happened anyway: Noche UFC (2026-09-12) completed with 13 stored
 * results, every bout queued awaiting_source, 0 round rows, and nothing anywhere
 * said so. ESPN kept writing results, so every other signal looked healthy.
 *
 * WHAT COUNTS AS A GAP
 *   an event with card_status = complete, stored results, past its source
 *   publication grace period, whose results are not matched by round rows (or
 *   an explicit "the source published no round detail" answer), where at least
 *   one missing bout is still waiting on the source (queued / awaiting_source).
 *
 * The service is not "down" when this is true — ESPN results keep landing. The
 * round lane is "degraded", and that is what gets reported.
 */

/** Hours after the end of the event day (UTC) before missing round rows count as a gap. */
export const DEFAULT_GRACE_HOURS = 12;
/** While a gap persists, re-alert at most this often. */
export const DEFAULT_ESCALATE_HOURS = 24;

const WAITING_STATES = new Set(['queued', 'awaiting_source', 'not_yet_published']);

/** When missing rows for an event dated `eventDate` start to count as a gap. */
export function gapDueAt(eventDate, graceHours = DEFAULT_GRACE_HOURS) {
  const endOfDay = Date.parse(`${eventDate}T00:00:00Z`) + 86400e3;
  return endOfDay + graceHours * 3600e3;
}

/**
 * @param events  [{ id, name, event_date, card_status, bouts: [{ id, has_result, round_rows, queue_state, queue_reason }] }]
 * @param source  { enabled: boolean, challenged: boolean }
 * @returns       gaps, newest event first
 */
export function roundArchiveGaps({ events, now, graceHours = DEFAULT_GRACE_HOURS, source = { enabled: true, challenged: false } }) {
  const gaps = [];
  for (const e of events || []) {
    if (e.card_status !== 'complete' || !e.event_date) continue;
    if (now < gapDueAt(e.event_date, graceHours)) continue;
    const results = (e.bouts || []).filter((b) => b.has_result);
    if (!results.length) continue;
    const withRows = results.filter((b) => (b.round_rows || 0) > 0);
    const noDetail = results.filter((b) => !(b.round_rows > 0) && b.queue_state === 'no_round_detail');
    const missing = results.filter((b) => !(b.round_rows > 0) && b.queue_state !== 'no_round_detail');
    const waiting = missing.filter((b) => WAITING_STATES.has(b.queue_state));
    if (!missing.length || !waiting.length) continue;
    const states = missing.reduce((acc, b) => ({ ...acc, [b.queue_state || 'not_queued']: (acc[b.queue_state || 'not_queued'] || 0) + 1 }), {});
    const reasons = [...new Set(waiting.map((b) => b.queue_reason).filter(Boolean))];
    gaps.push({
      event_id: e.id, event_name: e.name, event_date: e.event_date,
      completed_bouts: results.length, with_round_rows: withRows.length, no_round_detail: noDetail.length,
      missing: missing.length, waiting_on_source: waiting.length, missing_by_state: states, queue_reasons: reasons,
      cause: !source.enabled ? 'source disabled' : source.challenged ? 'source challenged' : 'awaiting source',
    });
  }
  return gaps.sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
}

/** ok | degraded. The worker itself is not reported down for this. */
export function roundLaneStatus({ gaps }) {
  return gaps.length ? 'degraded' : 'ok';
}

export function gapLine(g) {
  return `ROUND ARCHIVE GAP · ${g.event_name} · ${g.completed_bouts} completed bouts · ${g.with_round_rows} with round rows · ${g.cause}`;
}

const signature = (gaps) => gaps.map((g) => `${g.event_id}:${g.with_round_rows}/${g.completed_bouts}:${g.cause}`).sort().join('|');

/**
 * Decide whether to alert, from the gaps now and the last alert state.
 *   - a gap event not alerted before           -> alert
 *   - a change in counts or cause              -> alert
 *   - the same gaps, older than escalateHours  -> re-alert (escalation)
 *   - the same gaps, recently alerted          -> silent
 *   - gaps cleared after an alerted gap        -> one "cleared" message
 * Returns { send, kind, message, next } where `next` is the state to store.
 */
export function gapAlertDecision({ gaps, previous, now, escalateHours = DEFAULT_ESCALATE_HOURS }) {
  const prev = previous || { status: 'ok', signature: '', event_ids: [], last_alert_at: null, alerts_sent: 0 };
  const sig = signature(gaps);
  const at = new Date(now).toISOString();
  if (!gaps.length) {
    if (prev.status === 'degraded') {
      return { send: true, kind: 'cleared', message: `ROUND ARCHIVE GAP CLEARED · ${prev.event_ids.length} event${prev.event_ids.length === 1 ? '' : 's'} now have their round rows or an explicit no-detail answer`, next: { status: 'ok', signature: '', event_ids: [], last_alert_at: at, cleared_at: at, alerts_sent: (prev.alerts_sent || 0) + 1 } };
    }
    return { send: false, kind: 'none', message: null, next: { ...prev, status: 'ok' } };
  }
  const ids = gaps.map((g) => g.event_id);
  const isNew = ids.some((id) => !(prev.event_ids || []).includes(id));
  const changed = sig !== prev.signature;
  const stale = !prev.last_alert_at || now - Date.parse(prev.last_alert_at) >= escalateHours * 3600e3;
  const kind = prev.status !== 'degraded' || isNew ? 'new' : changed ? 'changed' : stale ? 'escalation' : 'none';
  const send = kind !== 'none';
  const next = {
    status: 'degraded', signature: sig, event_ids: ids,
    first_seen_at: prev.status === 'degraded' && prev.first_seen_at ? prev.first_seen_at : at,
    last_alert_at: send ? at : prev.last_alert_at, alerts_sent: (prev.alerts_sent || 0) + (send ? 1 : 0),
  };
  const lead = kind === 'escalation' ? `STILL DEGRADED since ${next.first_seen_at} · ` : '';
  return { send, kind, message: send ? `${lead}${gaps.map(gapLine).join('\n')}` : null, next };
}
