import { normalize, tokenSortRatio } from './shared/alias_resolver.mjs';

/* Round-stat lane — the pure decisions, kept apart from I/O so they can be
 * tested without a network, a database or a Worker runtime.
 *
 * The lane is BOUT-driven. The question it answers every run is "which bouts
 * does the authoritative record say are finished, and still have no round
 * rows?" — not "which UFC Stats events have we never linked?". The second
 * question stops being asked the moment an event is linked, and the backfill
 * links upcoming cards weeks before they happen, so a card linked in advance
 * would never be looked at again once it completed. That was the lane's
 * failure mode before this file existed.
 *
 * Nothing here writes a zero. A bout the source has no round detail for is
 * recorded as such and left without rows; absence stays absence.
 */

/* Dana White's Contender Series runs inside ESPN's UFC feed. UFC Stats DOES
 * carry those cards (fighter histories link events such as 66e981516e2476d1,
 * "DWCS 6.7"), but its completed-events list omits them. They are eligible
 * like any other final bout; this only routes their identity resolution away
 * from the list (to stored ids and fighter histories). */
export function isContenderSeries(name) {
  return /contender series|dana white'?s contender/i.test(String(name || ''));
}

const DAY = 86400000;

/* Bouts the lane should try this run.
 *
 *   bouts     : [{id, event_id, fighter_a_id, fighter_b_id, ufcstats_id, status}]
 *   events    : Map(event_id -> {id, name, event_date, ufcstats_id})
 *   results   : Map(bout_id -> {has_stats, stats_captured_at, round})
 *   withRows  : Set(bout_id) of bouts that already hold round rows
 *   now       : epoch ms
 *   forwardDays      : how far back the lane looks (older gaps are history's job)
 *   confirmGraceDays : a fight page that parsed with no stats tables is
 *                      re-checked for this long after the card, then accepted
 *                      as the source's final answer.
 *
 * Returns { candidates, skipped } where skipped counts why bouts were left. */
export function selectCandidates({ bouts, events, results, withRows, now, forwardDays = 45, confirmGraceDays = 7 }) {
  const cutoff = new Date(now - forwardDays * DAY).toISOString().slice(0, 10);
  const today = new Date(now + DAY).toISOString().slice(0, 10);   // UTC card dates run ahead of US evenings
  const skipped = { outside_window: 0, has_rows: 0, no_result: 0, source_confirmed_no_stats: 0, cancelled: 0 };
  const candidates = [];
  for (const b of bouts) {
    const ev = events.get(b.event_id);
    if (!ev || !ev.event_date || ev.event_date < cutoff || ev.event_date > today) { skipped.outside_window += 1; continue; }
    if (b.status === 'cancelled') { skipped.cancelled += 1; continue; }
    if (withRows.has(b.id)) { skipped.has_rows += 1; continue; }
    const r = results.get(b.id);
    /* The authoritative "this fight is over" is a stored result. A bout ESPN
     * still shows as scheduled cannot have round stats to fetch. */
    if (!r) { skipped.no_result += 1; continue; }
    if (r.stats_captured_at && r.has_stats === false) {
      const age = now - Date.parse(`${ev.event_date}T00:00:00Z`);
      if (age > confirmGraceDays * DAY) { skipped.source_confirmed_no_stats += 1; continue; }
    }
    candidates.push({ bout: b, event: ev, result: r });
  }
  /* Newest card first: the product cares most about the fight that just
   * ended, and a per-run cap should spend itself there. */
  candidates.sort((x, y) => String(y.event.event_date).localeCompare(String(x.event.event_date)));
  return { candidates, skipped };
}

/* Find our bout in one fighter's UFC Stats fight history, without the
 * completed-events list. A row qualifies when its event date is within a day
 * of ours (UFC Stats prints US-local dates, often a day earlier for Contender
 * Series) AND its opponent is our other corner: by UFC Stats id when we hold
 * one, otherwise by name (normalized equality, or token-sort >= 90). Exactly
 * one qualifying row is identity; none or several is not. */
export function matchHistoryRow(rows, { eventDate, other }) {
  const dd = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / DAY);
  const inDate = (rows || []).filter((r) => r.event_date && eventDate && dd(r.event_date, eventDate) <= 1);
  let by = null;
  let hits = [];
  if (other?.ufcstats_id) {
    hits = inDate.filter((r) => r.opponent_ufcstats_id === other.ufcstats_id);
    by = 'opponent_ufcstats_id';
  } else if (other?.name) {
    const n = normalize(other.name);
    hits = inDate.filter((r) => normalize(r.opponent_name) === n || tokenSortRatio(r.opponent_name, other.name) >= 90);
    by = 'opponent_name';
  }
  if (hits.length !== 1) return { row: null, candidates: hits.length, in_date: inDate.length };
  const r = hits[0];
  return { row: r, evidence: { by, date_delta_days: dd(r.event_date, eventDate), history_event: r.event_name, opponent_name: r.opponent_name } };
}

/* When to look again. The lane runs every cron tick, so these are floors. */
export function nextAttempt(state, now) {
  const H = 3600000;
  const wait = { not_yet_published: 0.25 * H, awaiting_source: 0, queued: 0, no_round_detail: 24 * H, validation_failed: 24 * H, identity_review: 24 * H }[state];
  return wait == null ? null : new Date(now + wait).toISOString();
}

/* Everything that must be true before a parsed fight page may be written
 * against one of our bouts. Any failure means "do not write", never "write
 * and hope". Returns a list of problems; empty means valid. */
export function validateFight({ parsed, fighterA, fighterB, result }) {
  const problems = [];
  const ours = new Set([fighterA?.ufcstats_id, fighterB?.ufcstats_id]);
  const theirs = new Set((parsed.fighters || []).map((p) => p.ufcstats_id));
  if (ours.size !== 2 || [...ours].some((x) => !x)) problems.push('our bout fighters are not both linked to UFC Stats ids');
  else if (theirs.size !== 2 || [...theirs].some((x) => !ours.has(x))) problems.push(`fighter identity mismatch: ours ${[...ours].join(',')} vs page ${[...theirs].join(',')}`);

  if (result) {
    const ourWinnerUs = result.winner_id === fighterA?.id ? fighterA?.ufcstats_id
      : result.winner_id === fighterB?.id ? fighterB?.ufcstats_id : null;
    if ((ourWinnerUs || null) !== (parsed.winner_ufcstats_id || null)) {
      problems.push(`winner disagreement: stored ${ourWinnerUs || 'none'} vs page ${parsed.winner_ufcstats_id || 'none'}`);
    }
  }

  const rounds = parsed.rounds || [];
  const byRound = new Map();
  for (const r of rounds) {
    if (!theirs.has(r.fighter_ufcstats_id)) problems.push(`round row for a fighter not on the page: ${r.fighter_ufcstats_id}`);
    if (!byRound.has(r.round)) byRound.set(r.round, new Set());
    byRound.get(r.round).add(r.fighter_ufcstats_id);
  }
  const nums = [...byRound.keys()].sort((a, b) => a - b);
  nums.forEach((n, i) => { if (n !== i + 1) problems.push(`rounds not contiguous from 1: ${nums.join(',')}`); });
  for (const [n, corners] of byRound) if (corners.size !== 2) problems.push(`round ${n} has ${corners.size} corner(s)`);
  const finish = parsed.round ?? result?.round ?? null;
  if (finish != null && nums.length && nums[nums.length - 1] > finish) problems.push(`round rows beyond the finish round ${finish}`);
  return [...new Set(problems)];
}

/* Map parsed rows onto our ids. Only called after validateFight() passed. */
export function roundRowsFor(parsed, fighterA, fighterB, boutId, sourceUrl, capturedAt) {
  const idFor = new Map([[fighterA.ufcstats_id, fighterA.id], [fighterB.ufcstats_id, fighterB.id]]);
  return parsed.rounds.map(({ fighter_ufcstats_id, ...r }) => ({
    ...r, bout_id: boutId, fighter_id: idFor.get(fighter_ufcstats_id), source_url: sourceUrl, captured_at: capturedAt,
  }));
}

/* Latency is a window, not a point. The source's first-available moment is
 * only ever bracketed by our last look that found nothing and our first look
 * that found rows; claiming anything sharper than that bracket would be
 * inventing a measurement. */
export function latencySummary(rec) {
  const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  return {
    ...rec,
    source_available_window_ms: rec.ufcstats_last_unavailable_at && rec.ufcstats_first_available_at
      ? ms(rec.ufcstats_last_unavailable_at, rec.ufcstats_first_available_at) : null,
    final_to_capture_ms: ms(rec.espn_final_first_seen_at, rec.round_rows_captured_at),
  };
}

/* Should a remembered challenge keep the lane off? After any challenge the
 * lane did not answer (the default), a gate change, or a failed solve, we stay
 * away for `backoffHours` rather than probing a source that has just told us
 * it does not want automated reads. */
export function sourceBlocked(health, now, backoffHours = 6) {
  if (!health || health.status !== 'challenged' || !health.at) return false;
  return now - Date.parse(health.at) < backoffHours * 3600000;
}
