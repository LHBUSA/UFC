/* Status lifecycle — how an availability claim stops being current.
 *
 * A status row is a claim in the present tense: "this fighter is out". Claims
 * in the present tense have to be able to stop being true, and the only two
 * honest ways for that to happen are:
 *
 *   RESOLUTION  a later SOURCED event says it ended — a clearance, a return.
 *   EXPIRY      the thing it was about is over. A withdrawal from a card that
 *               was fought last March says nothing about today.
 *
 * There is deliberately no third way. Nothing here decides that an injury has
 * probably healed because time passed, or that a fighter is fit because we
 * have not heard otherwise in a while. That is the medical inference this
 * whole system refuses to make, and it would be the easiest thing in the world
 * to add here under the name "cleanup".
 *
 * So:
 *
 *   status tied to an event  expires when that event's date has passed, unless
 *                            a later sourced event already resolved or
 *                            superseded it.
 *   status tied to nothing   NEVER expires by time. An injury with no card
 *                            attached ends when a source says it ended, and
 *                            not before. It may sit active for a year; that is
 *                            the honest state of our knowledge, and a page can
 *                            show its age.
 *
 * Nothing is deleted, ever. Expiry and resolution are state transitions on
 * rows that stay exactly where they are, so the fighter's history keeps the
 * event, keeps its source, and keeps the card it was about.
 */

/** Status types that make a fighter unavailable — the ones a lifecycle matters for. */
export const UNAVAILABLE_TYPES = new Set(['injury', 'illness', 'withdrawal', 'suspension', 'visa_travel']);

/** Status types that assert a fighter IS available again. */
export const RESOLVING_TYPES = new Set(['cleared', 'return']);

/**
 * Which active rows should expire, given the events they point at.
 *
 * `rows` are active status events; `eventDateById` maps event_id -> ISO date.
 * `today` is an ISO date string (YYYY-MM-DD) so the boundary is a date, not an
 * instant: an event on the 14th stops being upcoming at the end of the 14th in
 * UTC, not at some local midnight nobody agreed on.
 *
 * Returns `{ id, reason }` per row, and nothing else — deciding is separate
 * from writing so the decision can be tested without a database.
 */
export function expiries(rows, eventDateById, today) {
  const out = [];
  for (const r of rows) {
    if (r.state !== 'active') continue;
    /* Not about a card -> time tells us nothing. This is the branch that keeps
     * the system from inventing recoveries. */
    if (!r.event_id) continue;
    const date = eventDateById.get(r.event_id) ?? null;
    /* An unknown date is not evidence the event happened. */
    if (!date) continue;
    if (date >= today) continue;
    out.push({
      id: r.id,
      fighter_id: r.fighter_id,
      event_id: r.event_id,
      reason: `event ${r.event_id} took place on ${date}, before ${today}; a card-specific ${r.status_type} does not outlive its card`,
    });
  }
  return out;
}

/**
 * Which active rows a later sourced event resolves.
 *
 * ONLY where the relationship is unambiguous. A `cleared` or `return` event
 * resolves an earlier unavailable status for the SAME FIGHTER when:
 *
 *   - the resolver is strictly later than the thing it resolves, and
 *   - exactly one candidate is open for that fighter, or every open candidate
 *     shares the resolver's event/bout.
 *
 * When a fighter has two open unavailable statuses of different kinds — an
 * injury and a suspension, say — a bare "cleared to return" does not say which
 * one ended, and quite possibly ended only one. Guessing would either declare a
 * suspended fighter eligible or leave a healed fighter injured, and both are
 * assertions the source did not make. So that case resolves nothing and is
 * reported as ambiguous, exactly like an ambiguous subject in the extractor.
 *
 * A `cleared` event never resolves a `suspension` unless the resolver is itself
 * commission-sourced: a reporter saying a fighter is medically cleared is not
 * a commission lifting a ban, and conflating them would publish that someone
 * may compete when the body that suspended them has not said so.
 */
export function resolutions(resolvers, openRows) {
  const decided = [];
  const ambiguous = [];

  const openByFighter = new Map();
  for (const r of openRows) {
    if (r.state !== 'active' || !UNAVAILABLE_TYPES.has(r.status_type)) continue;
    if (!openByFighter.has(r.fighter_id)) openByFighter.set(r.fighter_id, []);
    openByFighter.get(r.fighter_id).push(r);
  }

  for (const res of resolvers) {
    if (!RESOLVING_TYPES.has(res.status_type)) continue;
    const open = (openByFighter.get(res.fighter_id) || [])
      .filter((r) => r.id !== res.id && occurredAt(r) < occurredAt(res));
    if (!open.length) continue;

    /* A medical clearance is not a lifted ban. */
    const eligible = open.filter((r) => (
      r.status_type !== 'suspension' || res.source_kind === 'commission'
    ));
    const blocked = open.filter((r) => !eligible.includes(r));
    for (const b of blocked) {
      ambiguous.push({
        id: b.id, resolver_id: res.id,
        reason: `a ${res.status_type} from a ${res.source_kind} source does not lift a suspension; only a commission source can`,
      });
    }
    if (!eligible.length) continue;

    if (eligible.length === 1) {
      decided.push({ id: eligible[0].id, resolved_by_event_id: res.id, reason: `the only open ${eligible[0].status_type} for this fighter, and this ${res.status_type} is later` });
      continue;
    }

    /* Several open, but all about the same card as the resolver: the story is
     * about that card and ends all of it. */
    const sameCard = res.event_id && eligible.every((r) => r.event_id === res.event_id);
    if (sameCard) {
      for (const r of eligible) {
        decided.push({ id: r.id, resolved_by_event_id: res.id, reason: `every open status for this fighter is about event ${res.event_id}, which this ${res.status_type} is also about` });
      }
      continue;
    }

    ambiguous.push({
      id: null, resolver_id: res.id, fighter_id: res.fighter_id,
      reason: `${eligible.length} open statuses (${eligible.map((r) => r.status_type).join(', ')}) and this ${res.status_type} does not say which it ends`,
    });
  }

  return { decided, ambiguous };
}

/** The single timestamp every ordering in this system uses. */
export function occurredAt(row) {
  return String(row.effective_at || row.source_published_at || row.detected_at || '');
}

/**
 * The whole lifecycle decision for one pass.
 *
 * Pure: takes rows and dates, returns the transitions to apply. The caller
 * does the writing, which is what makes every rule above testable without a
 * database and without the migration having been applied.
 */
export function planLifecycle({ rows, eventDateById, today }) {
  const active = rows.filter((r) => r.state === 'active');
  const resolvers = rows.filter((r) => RESOLVING_TYPES.has(r.status_type));

  const { decided, ambiguous } = resolutions(resolvers, active);
  const resolvedIds = new Set(decided.map((d) => d.id));

  /* Resolution wins over expiry: a row that a source explicitly ended is
   * resolved, not merely out of date, and the ledger should say which. */
  const toExpire = expiries(active, eventDateById, today).filter((e) => !resolvedIds.has(e.id));

  return { resolve: decided, expire: toExpire, ambiguous };
}
