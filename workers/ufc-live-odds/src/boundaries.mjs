/* Round-boundary evidence — PURE, so every rule is testable without a card.
 *
 * TWO PATHS, ONE AUTHORITY
 *
 * ESPN remains the only state authority. This is not a second fight clock; it
 * preserves two different SHAPES of ESPN's evidence, because a one-minute poll
 * can miss a short-lived intermission and a round whose break we polled either
 * side of would otherwise leave no boundary at all.
 *
 *   espn_end_of_round_status  we observed STATUS_END_OF_ROUND with period N
 *   espn_period_transition    we saw the bout active in period N and later in
 *                             period N+1, so round N ended between them
 *
 * The second is weaker and is labelled as such all the way to the UI. Neither
 * is a horn time: observed_at means "when we first saw this", and for the
 * inferred path the bracketing sightings are kept so the uncertainty window is
 * visible rather than implied.
 *
 * FIRST-SEEN-WINS SURVIVES ENRICHMENT. If the fallback recorded a boundary and
 * a direct status arrives later, the historical observed_at is NOT moved
 * forward — a later sighting is strictly worse evidence of when something
 * happened, and rewriting it would falsify the one thing this table exists to
 * record.
 */

/** The period a bout is currently in, if ESPN reported one. Never inferred. */
export function activePeriod(status) {
  const p = Number(status?.period);
  if (!Number.isInteger(p) || p < 1 || p > 5) return null;
  return p;
}

/**
 * Boundaries evidenced by this observation, given what we saw last time.
 *
 * `previous` is the last observation of the SAME competition: { period, seenAt }.
 * Returns zero or more boundary records; a tick that evidences nothing returns
 * an empty list, which is the normal case.
 */
export function boundariesFrom({ status, previous, observedAt, scheduledRounds = null }) {
  const out = [];
  const compId = String(status?.competitionId || '');
  if (!compId) return out;

  /* PATH 1 — the direct state. Strongest evidence available. */
  if (status.status === 'STATUS_END_OF_ROUND') {
    const round = activePeriod(status);
    if (round !== null && withinSchedule(round, scheduledRounds)) {
      out.push({
        espn_competition_id: compId,
        kind: 'round_end',
        round,
        espn_status: status.status,
        observed_at: observedAt,
        boundary_basis: 'espn_end_of_round_status',
        provenance: `ESPN status first observed as STATUS_END_OF_ROUND period ${round}`,
      });
    }
  }

  /* PATH 2 — the period advanced since we last looked. Every round between the
   * two sightings completed, so a poll that skipped a whole round still yields
   * its boundary rather than losing it. */
  const now = activePeriod(status);
  const before = Number.isInteger(previous?.period) ? previous.period : null;
  if (now !== null && before !== null && now > before) {
    for (let round = before; round < now; round += 1) {
      if (!withinSchedule(round, scheduledRounds)) continue;
      out.push({
        espn_competition_id: compId,
        kind: 'round_end',
        round,
        espn_status: status.status,
        observed_at: observedAt,
        boundary_basis: 'espn_period_transition',
        previous_period_seen_at: previous.seenAt ?? null,
        next_period_seen_at: observedAt,
        provenance: `Round ${round} completion inferred from first observed ESPN period transition ${before} -> ${now}`,
      });
    }
  }

  /* A period that goes BACKWARDS is not a boundary. It is a correction, a
   * restart or a bad read, and inventing a round end from it would record a
   * completion that never happened. */
  return out;
}

/** A round beyond the bout's scheduled length is refused, where we know it. */
function withinSchedule(round, scheduledRounds) {
  if (!Number.isInteger(scheduledRounds)) return true;
  return round >= 1 && round <= scheduledRounds;
}

/**
 * Collapse boundaries to one per (competition, round).
 *
 * The same completion can be evidenced by both paths, and must not become two
 * Round 2s. The direct status wins on BASIS, but the earliest sighting wins on
 * TIME — so a fallback seen first keeps its observed_at and merely records
 * that the direct state was seen later.
 */
export function dedupeBoundaries(existing, incoming) {
  const key = (b) => `${b.espn_competition_id}|${b.round}`;
  const byKey = new Map((existing || []).map((b) => [key(b), { ...b }]));

  for (const b of incoming || []) {
    const k = key(b);
    const prior = byKey.get(k);
    if (!prior) { byKey.set(k, { ...b }); continue; }

    const priorAt = Date.parse(prior.observed_at);
    const nextAt = Date.parse(b.observed_at);
    /* Never move a recorded boundary forward in time. */
    const keepAt = Number.isFinite(priorAt) && Number.isFinite(nextAt) && priorAt <= nextAt ? prior.observed_at : b.observed_at;

    const upgrading = prior.boundary_basis === 'espn_period_transition'
      && b.boundary_basis === 'espn_end_of_round_status';

    byKey.set(k, {
      ...prior,
      observed_at: keepAt,
      /* Basis may be enriched to the stronger evidence, because that does not
       * change WHEN we first saw the boundary — only what proved it. */
      boundary_basis: upgrading ? 'espn_end_of_round_status' : prior.boundary_basis,
      provenance: upgrading
        ? `${prior.provenance}; direct STATUS_END_OF_ROUND observed later at ${b.observed_at}`
        : prior.provenance,
    });
  }
  return [...byKey.values()];
}

/**
 * How the tape should describe a boundary. The two paths read differently on
 * purpose — a reader must not be invited to assume equal precision.
 */
export function describeBoundary(basis, round) {
  return basis === 'espn_end_of_round_status'
    ? `round-end state was first seen`
    : `ESPN advanced to round ${Number(round) + 1}`;
}
