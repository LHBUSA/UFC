/* Turning one provider payload into rows.
 *
 * Resolution is NOT implemented here. It is imported from
 * scripts/odds/market_match.mjs, the same module the Node CLI uses, because
 * two definitions of "whose price is this" would drift and the drift would be
 * invisible until a price was already attached to the wrong fighter and stored
 * as history. This file is the part that differs between the two callers:
 * which tables get written, and in what shape.
 *
 * TWO LAYERS, ON PURPOSE
 *
 *   ufc_market_run_quotes    SNAPSHOT history. Every quote in this fetch, all
 *                            sharing this run's single observed_at. This is
 *                            what makes "the market right after round 2" a
 *                            true statement even when nothing moved.
 *
 *   ufc_market_observations  CHANGE history. Its unique constraint makes an
 *                            unchanged price a database no-op, which is what
 *                            keeps the archive compact. Untouched semantics.
 *
 * A fetch returning 352 identical prices writes 352 snapshot rows and zero
 * observation rows. Both facts are correct and neither table can express the
 * other's.
 *
 * AMBIGUITY FAILS CLOSED, always. A quote we cannot attribute to exactly one
 * fighter in exactly one bout is not written to either layer; it lands in
 * ufc_market_unmatched with a reason, where a human can read it.
 */
import { buildIndex, resolveOutcome, matchBout } from '../../../scripts/odds/market_match.mjs';

/**
 * Normalise one provider payload into the rows both layers need.
 *
 * `observedAt` is taken ONCE by the caller around the fetch and passed in.
 * Nothing here calls a clock: one provider request is one snapshot, and a
 * per-row timestamp would split a single reading across several and invite a
 * reader to infer movement inside it.
 */
export function normalizePayload({ payload, bouts, fighters, aliases, observedAt, eventId = null }) {
  const byNorm = buildIndex(fighters, aliases);
  const quotes = [];
  const unmatched = [];
  let matchedBouts = 0;
  let ambiguous = 0;
  const books = new Set();

  for (const src of Array.isArray(payload) ? payload : []) {
    const m = matchBout(src, bouts, byNorm);
    if (m.status !== 'ok') {
      unmatched.push({
        source_event_id: String(src.id || ''),
        sport_key: String(src.sport_key || ''),
        commence_time: src.commence_time || null,
        home_team: src.home_team || null,
        away_team: src.away_team || null,
        reason: m.reason || m.status,
        detail: { status: m.status },
      });
      if (m.status === 'ambiguous') ambiguous += 1;
      continue;
    }
    matchedBouts += 1;
    const bout = m.bout;
    const corners = [{ id: bout.a.id, name: bout.a.name }, { id: bout.b.id, name: bout.b.name }];

    for (const bk of src.bookmakers || []) {
      for (const mk of bk.markets || []) {
        for (const oc of mk.outcomes || []) {
          const r = resolveOutcome(oc.name, corners, byNorm);
          if (r.status !== 'ok') {
            /* A quote we cannot attribute is never attached to a fighter, in
             * either layer. */
            if (r.status === 'ambiguous') ambiguous += 1;
            unmatched.push({
              source_event_id: String(src.id || ''),
              sport_key: String(src.sport_key || ''),
              commence_time: src.commence_time || null,
              home_team: src.home_team || null,
              away_team: src.away_team || null,
              reason: `outcome_${r.status}:${r.reason || ''}`.slice(0, 200),
              detail: { outcome_name: oc.name, bout_id: bout.id },
            });
            continue;
          }
          books.add(bk.key);
          quotes.push({
            event_id: eventId,
            bout_id: bout.id,
            fighter_a_id: bout.a.id,
            fighter_b_id: bout.b.id,
            bookmaker_key: bk.key,
            bookmaker_name: bk.title ?? null,
            market_key: mk.key,
            outcome_name: oc.name,
            outcome_fighter_id: r.fighterId,
            price: Math.round(Number(oc.price)),
            point: oc.point ?? null,
            source_event_id: String(src.id || ''),
            commence_time: src.commence_time || null,
            source_last_update: mk.last_update || bk.last_update || null,
            observed_at: observedAt,
          });
        }
      }
    }
  }
  return { quotes, unmatched, matchedBouts, ambiguous, books: books.size };
}

/** Snapshot rows for one run: every quote, deduplicated only within the run. */
export const snapshotRows = (quotes, runId) => quotes.map((q) => ({ ...q, run_id: runId }));

/**
 * Change-history rows, in the shape ufc_market_observations already expects.
 *
 * Deliberately the SAME columns and the same conflict target the CLI uses, so
 * the database's existing idempotency does the deduplication rather than any
 * logic here deciding what counts as a change.
 */
export const observationRows = (quotes) => quotes.map((q) => ({
  event_id: q.event_id,
  bout_id: q.bout_id,
  fighter_a_id: q.fighter_a_id,
  fighter_b_id: q.fighter_b_id,
  bookmaker_key: q.bookmaker_key,
  bookmaker_name: q.bookmaker_name,
  market_key: q.market_key,
  outcome_name: q.outcome_name,
  outcome_fighter_id: q.outcome_fighter_id,
  price: q.price,
  point: q.point,
  source_event_id: q.source_event_id,
  commence_time: q.commence_time,
  source_last_update: q.source_last_update,
  observed_at: q.observed_at,
}));
