/* The fight market tape — PURE. Given a bout's observations and the fight-state
 * transitions we actually recorded, produce the checkpoints a reader can trust.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * We do not have a price at the bell. We have prices at the moments we asked,
 * and a record of when we first saw the state change. The honest product is
 * therefore "the nearest real observation, and how far it was from the
 * boundary" — never a price synthesised for the boundary itself.
 *
 * So there is no interpolation anywhere in this file, and every checkpoint
 * carries `secondsFromBoundary` so the UI can say "observed 23s after Round 2"
 * rather than "Round 2 close". A checkpoint with no usable observation is
 * reported as unavailable; it is never filled in from the reading either side
 * of it.
 *
 * PRE-FIGHT CLOSE is defined strictly: the latest observation recorded STRICTLY
 * BEFORE the bout was confirmed in progress. A price recorded after the first
 * in-progress state is not a close, and is never labelled as one. If we were
 * not polling before the bell, the close is unavailable and stays unavailable —
 * it is the CLV benchmark, and a backfilled one would silently corrupt every
 * CLV number computed from it.
 */
import { impliedProbability, consensusOf, bestPrice } from './market_match.mjs';

/** Only observations at or before `at`, newest first. */
const atOrBefore = (rows, at) => rows
  .filter((r) => Date.parse(r.observed_at) <= at)
  .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));

/** One reading = all rows sharing an observed_at. */
function readingAt(rows, observedAt) {
  return rows.filter((r) => r.observed_at === observedAt);
}

/**
 * Both corners of one reading, priced.
 *
 * Returns null unless BOTH sides are present: a one-sided reading cannot carry
 * an implied probability that means anything, and showing one side alone
 * invites the reader to treat the vig as signal.
 */
export function priceReading(rows, fighterAId, fighterBId) {
  const a = rows.filter((r) => r.outcome_fighter_id === fighterAId);
  const b = rows.filter((r) => r.outcome_fighter_id === fighterBId);
  if (!a.length || !b.length) return null;
  const ca = consensusOf(a);
  const cb = consensusOf(b);
  if (!ca || !cb) return null;
  const books = new Set(rows.map((r) => r.bookmaker_key)).size;
  return {
    observedAt: rows[0].observed_at,
    sourceLastUpdate: rows.map((r) => r.source_last_update).sort().pop() ?? null,
    books,
    a: { consensus: ca.price, probability: ca.probability, best: bestPrice(a) },
    b: { consensus: cb.price, probability: cb.probability, best: bestPrice(b) },
    /* The two sides sum to more than 1 by the book's margin. Reported so a
     * reader can see it rather than being handed a de-vigged number as if it
     * were quoted. */
    overround: ca.probability + cb.probability,
  };
}

/**
 * The nearest usable observation to a boundary, and how far off it was.
 *
 * `prefer` decides which side of the boundary is acceptable:
 *   'before' — strictly before (pre-fight close: a later price is not a close)
 *   'after'  — at or after (a round boundary: the first price we got once the
 *              round had ended, which is what we actually observed)
 */
export function nearestReading(rows, boundaryAt, { prefer, maxSeconds = null, fighterAId, fighterBId }) {
  const boundary = Date.parse(boundaryAt);
  if (!Number.isFinite(boundary)) return null;
  const stamps = [...new Set(rows.map((r) => r.observed_at))]
    .filter((s) => {
      const t = Date.parse(s);
      if (!Number.isFinite(t)) return false;
      return prefer === 'before' ? t < boundary : t >= boundary;
    })
    .sort((x, y) => Math.abs(Date.parse(x) - boundary) - Math.abs(Date.parse(y) - boundary));

  for (const stamp of stamps) {
    const delta = Math.round((Date.parse(stamp) - boundary) / 1000);
    if (maxSeconds !== null && Math.abs(delta) > maxSeconds) continue;
    const priced = priceReading(readingAt(rows, stamp), fighterAId, fighterBId);
    if (priced) return { ...priced, secondsFromBoundary: delta };
  }
  return null;
}

/**
 * Movement between two checkpoints, in implied-probability POINTS.
 *
 * Points, not a difference of American prices: -110 to +110 is a 20-"point"
 * move on the raw number and about 9.1 points of probability, and the first
 * figure is arithmetic on a scale that is not linear. The American prices stay
 * visible; the movement is measured on the only scale where subtraction is
 * meaningful.
 */
export function movementPts(from, to, side = 'a') {
  if (!from || !to) return null;
  const p0 = from[side]?.probability;
  const p1 = to[side]?.probability;
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) return null;
  return Math.round((p1 - p0) * 1000) / 10;
}

/**
 * Build the tape.
 *
 * `transitions` are the state changes we OBSERVED, each carrying the instant we
 * first saw it — not a broadcast timestamp and not a bell. Their provenance is
 * carried through to every checkpoint so the UI never implies precision the
 * source did not give us.
 */
/* 120 seconds. At roughly one poll per minute a genuine round-end reading is
 * within two ticks; anything further is the NEXT round's market wearing this
 * round's label. A gap is reported as unavailable rather than filled from
 * deep inside the following round merely to populate a UI. */
export const MAX_ROUND_BOUNDARY_SECONDS = 120;

export function buildMarketTape({ observations, fighterAId, fighterBId, transitions = [], maxSecondsFromBoundary = MAX_ROUND_BOUNDARY_SECONDS }) {
  const rows = (observations || []).filter((r) => r.outcome_fighter_id && r.observed_at);
  const checkpoints = [];
  const stamps = [...new Set(rows.map((r) => r.observed_at))].sort();

  /* First observed: the earliest reading we hold for this bout. */
  if (stamps.length) {
    const first = priceReading(readingAt(rows, stamps[0]), fighterAId, fighterBId);
    if (first) checkpoints.push({ key: 'first_observed', label: 'First observed', ...first, secondsFromBoundary: null, provenance: 'first reading held' });
  }

  const inProgress = transitions.find((t) => t.kind === 'in_progress');
  /* Pre-fight close: strictly before the first in-progress state, or nothing. */
  if (inProgress?.observedAt) {
    const close = nearestReading(rows, inProgress.observedAt, { prefer: 'before', fighterAId, fighterBId });
    checkpoints.push(close
      ? { key: 'prefight_close', label: 'Pre-fight close', ...close, provenance: `last reading before we first saw the bout in progress (${inProgress.provenance || 'observed transition'})` }
      : { key: 'prefight_close', label: 'Pre-fight close', unavailable: true, reason: 'no reading before the bout was seen in progress', secondsFromBoundary: null });
  } else {
    checkpoints.push({ key: 'prefight_close', label: 'Pre-fight close', unavailable: true, reason: 'no observed in-progress transition', secondsFromBoundary: null });
  }

  /* Round boundaries, in the order the source reported them. */
  for (const t of transitions.filter((x) => x.kind === 'round_end' && Number.isInteger(x.round)).sort((x, y) => x.round - y.round)) {
    const near = nearestReading(rows, t.observedAt, { prefer: 'after', maxSeconds: maxSecondsFromBoundary, fighterAId, fighterBId });
    checkpoints.push(near
      ? { key: `round_${t.round}`, label: `After round ${t.round}`, round: t.round, ...near, provenance: t.provenance || 'observed state transition' }
      : { key: `round_${t.round}`, label: `After round ${t.round}`, round: t.round, unavailable: true, reason: 'no reading within the window after this round', secondsFromBoundary: null });
  }

  /* Movement is only ever between two checkpoints we actually hold. */
  let prev = null;
  for (const c of checkpoints) {
    if (c.unavailable) { c.movePtsA = null; c.movePtsB = null; continue; }
    c.movePtsA = movementPts(prev, c, 'a');
    c.movePtsB = movementPts(prev, c, 'b');
    prev = c;
  }
  return { checkpoints, readings: stamps.length, interpolated: false };
}
