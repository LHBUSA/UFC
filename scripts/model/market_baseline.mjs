// Market-implied probability, for comparison only.
//
// The model never sees this. A price is read AFTER a probability exists, and
// only from observations recorded strictly before the bout started - a closing
// line pulled after the fact would be a different and much easier problem than
// the one the model is asked to solve.
//
// Consensus is the MEDIAN implied probability across books rather than the
// mean, so one stale or extreme book cannot drag the figure, matching the
// definition already used by web/lib/market.ts.
//
// The two sides of a two-way market sum to more than one: that excess is the
// vig. Comparing a model probability against a vigged price would hand the
// model a free edge on both fighters at once, so the two consensus figures are
// normalised to sum to one before any comparison. That normalisation
// (proportional de-vig) is itself an assumption - it splits the margin in
// proportion to price - and it is named here rather than buried.

export const impliedFromAmerican = (price) =>
  price == null ? null : price > 0 ? 100 / (price + 100) : -price / (-price + 100);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {object[]} observations rows of ufc_market_observations for one bout
 * @param {string}   cutoffIso    only observations at or before this instant count
 * @returns {{fighter_id:string, implied:number, devigged:number, books:number}[]|null}
 */
export function consensusForBout(observations, cutoffIso) {
  const usable = observations.filter(
    (o) => o.market_key === 'h2h' && o.outcome_fighter_id && o.price != null &&
      (!cutoffIso || (o.observed_at && o.observed_at <= cutoffIso)),
  );
  if (!usable.length) return null;

  // Latest price per book per outcome, then median across books.
  const latest = new Map();
  for (const o of usable) {
    const k = `${o.bookmaker_key}|${o.outcome_fighter_id}`;
    const prev = latest.get(k);
    const stamp = o.source_last_update || o.observed_at;
    if (!prev || (prev.source_last_update || prev.observed_at) <= stamp) latest.set(k, o);
  }

  const perFighter = new Map();
  for (const o of latest.values()) {
    if (!perFighter.has(o.outcome_fighter_id)) perFighter.set(o.outcome_fighter_id, []);
    perFighter.get(o.outcome_fighter_id).push(impliedFromAmerican(o.price));
  }
  const sides = [...perFighter.entries()].map(([fighter_id, xs]) => ({
    fighter_id,
    implied: median(xs),
    books: xs.length,
  }));
  if (sides.length !== 2 || sides.some((s) => s.implied == null)) return null;

  const total = sides[0].implied + sides[1].implied;
  if (!(total > 0)) return null;
  for (const s of sides) s.devigged = s.implied / total;
  return sides;
}

/**
 * Market probability for the canonical corner one of a dataset row, or null
 * when no timestamp-compatible price exists. `cutoffIso` defaults to midnight
 * UTC on the event date: a price observed on fight day but after the bout
 * started would otherwise slip in, and no market row in this database currently
 * carries a precise enough bout start time to do better.
 */
export function marketProbForRow(row, observationsByBout, cutoffIso) {
  const obs = observationsByBout.get(row.bout_id);
  if (!obs?.length) return null;
  const sides = consensusForBout(obs, cutoffIso ?? `${row.event_date}T00:00:00+00:00`);
  if (!sides) return null;
  const one = sides.find((s) => s.fighter_id === row.fighter_1_id);
  const two = sides.find((s) => s.fighter_id === row.fighter_2_id);
  if (!one || !two) return null;
  return { p: one.devigged, books: Math.min(one.books, two.books), implied_one: one.implied, implied_two: two.implied };
}
